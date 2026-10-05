/**
 * BUG (found 2026-10-05, live on multiple production orgs — one at 100% of
 * its deals, one at 89%): both company-resolution fallback paths used the
 * literal string 'Unknown Company' as a natural-key MATCH value, not just a
 * display default. Since that string isn't actually unique, every
 * blank-named HubSpot company AND every deal with no company association
 * collapsed onto one single shared Company row, each overwriting the
 * previous one's hubspotId. Deals ended up pointing at an arbitrary, wrong
 * company instead of their own distinct (if nameless) one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listDealStageLabels, upsertByHubspotId } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listDealStageLabels: vi.fn().mockResolvedValue({}),
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
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
vi.mock('../src/services/hubspot/dedup.js', () => ({ upsertByHubspotId }));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStageLabelCache();
});

describe('companies phase — blank HubSpot name must not become a shared match key', () => {
  it('does not pass a natural-key match for a company with no HubSpot name', async () => {
    vi.doMock('../src/services/hubspot/mappers.js', () => ({
      mapCompany: vi.fn((rec: { id: string }) => ({
        hubspotId: rec.id, name: 'Unknown Company', industry: null, website: null,
        description: null, hubspotProperties: {},
      })),
      mapContact: vi.fn(), mapDeal: vi.fn(),
    }));
    const { runImportBatch: run } = await import('../src/services/hubspot/importEngine.js');

    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'companies', cursor: null },
      }),
    });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });
    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') {
        importJobCalls += 1;
        return importJobCalls === 1 ? jobChain : finalUpdateChain;
      }
      return makeChain();
    });

    listPage.mockResolvedValue({
      results: [
        { id: 'hs-company-1', properties: { name: '' } },
        { id: 'hs-company-2', properties: { name: '' } },
      ],
      nextCursor: null,
    });

    await run('job-1', 'tok');

    expect(upsertByHubspotId).toHaveBeenCalledTimes(2);
    for (const call of upsertByHubspotId.mock.calls) {
      // match (5th positional arg) must be undefined for a blank-name company —
      // passing {column:'name', value:'Unknown Company'} is what caused the collapse.
      expect(call[4]).toBeUndefined();
    }
  });
});

describe('deals phase — two deals with no company association must not share a company', () => {
  it('creates a distinct Company stub per unresolvable deal instead of reusing one shared row', async () => {
    vi.doMock('../src/services/hubspot/mappers.js', () => ({
      mapCompany: vi.fn(),
      mapContact: vi.fn(),
      mapDeal: vi.fn((rec: { id: string }) => ({
        hubspotId: rec.id, name: `Deal ${rec.id}`, dealSize: null, stage: null, description: null,
        associatedCompanyHubspotId: null, customFields: {}, hubspotProperties: {},
      })),
    }));
    const { runImportBatch: run } = await import('../src/services/hubspot/importEngine.js');

    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'deals', cursor: null },
      }),
    });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });
    let importJobCalls = 0;
    let companyInsertCalls = 0;
    const companyIds = ['new-company-1', 'new-company-2'];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') {
        importJobCalls += 1;
        return importJobCalls === 1 ? jobChain : finalUpdateChain;
      }
      // 'Company' table: each unresolvable deal must INSERT its own stub —
      // never find-and-reuse an existing 'Unknown Company' row.
      return makeChain({
        insert: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() => {
          const id = companyIds[companyInsertCalls] ?? `new-company-${companyInsertCalls + 1}`;
          companyInsertCalls += 1;
          return Promise.resolve({ data: { id } });
        }),
      });
    });

    listPage.mockResolvedValue({
      results: [
        { id: 'hs-deal-1', properties: { dealname: 'Deal A' } },
        { id: 'hs-deal-2', properties: { dealname: 'Deal B' } },
      ],
      nextCursor: null,
    });

    await run('job-1', 'tok');

    const dealCalls = upsertByHubspotId.mock.calls.filter((c) => c[0] === 'Deal');
    expect(dealCalls).toHaveLength(2);
    const companyIdsUsed = dealCalls.map((c) => (c[3] as { companyId: string | null }).companyId);
    expect(companyIdsUsed[0]).not.toBeNull();
    expect(companyIdsUsed[1]).not.toBeNull();
    // The two deals must NOT have been wired to the same company.
    expect(companyIdsUsed[0]).not.toBe(companyIdsUsed[1]);
  });
});
