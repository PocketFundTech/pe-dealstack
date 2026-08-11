/**
 * Deals in the same batch commonly share a company (a portfolio CRM has far
 * fewer companies than deals). Each deal used to do its own
 * companyNameForHubspotId + resolveCompanyId round-trips even when the
 * company was identical to the previous record — real, avoidable latency
 * inside a time-boxed Vercel serverless function. Resolution should be
 * cached per batch so a shared company costs one lookup, not N.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listDealStageLabels } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listDealStageLabels: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage, listPropertyNames: vi.fn().mockResolvedValue(['dealname']), listDealStageLabels };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({ upsertByHubspotId: vi.fn().mockResolvedValue('created') }));
vi.mock('../src/services/hubspot/mappers.js', () => ({
  mapCompany: vi.fn(),
  mapContact: vi.fn(),
  mapDeal: vi.fn((rec: { id: string }) => ({
    hubspotId: rec.id, name: `Deal ${rec.id}`, dealSize: null, stage: null, description: null,
    associatedCompanyHubspotId: 'hs-company-1', customFields: {}, hubspotProperties: {},
  })),
}));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [{ id: 'local-company-1' }] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: { name: 'Acme Inc' } }),
  };
  return Object.assign(base, overrides);
}

describe('runImportBatch — deal company resolution caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
  });

  it('resolves a company shared by multiple deals in the same batch only once', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'deals', cursor: null },
      }),
    });
    const companyChain = makeChain();
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') {
        importJobCalls += 1;
        return importJobCalls === 1 ? jobChain : finalUpdateChain;
      }
      return companyChain; // 'Company'
    });

    listPage.mockResolvedValue({
      results: [
        { id: 'hs-deal-1', properties: { dealname: 'Deal A' } },
        { id: 'hs-deal-2', properties: { dealname: 'Deal B' } },
      ],
      nextCursor: null,
    });

    await runImportBatch('job-1', 'tok');

    const companyCalls = mockFrom.mock.calls.filter((c) => c[0] === 'Company').length;
    // 1 companyNameForHubspotId lookup + 1 resolveCompanyId lookup, shared
    // across both deals — not 4 (2 deals × 2 lookups each, uncached).
    expect(companyCalls).toBe(2);
  });
});
