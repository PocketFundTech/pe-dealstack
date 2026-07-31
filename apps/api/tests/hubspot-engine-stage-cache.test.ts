/**
 * listDealStageLabels() fetches HubSpot's /crm/v3/pipelines/deals, which is
 * invariant for the whole import job. runImportBatch is called once per
 * ~100-record batch (up to MAX_BATCHES=1000 times per job), so refetching it
 * every call wastes a round-trip inside a time-boxed Vercel serverless
 * function. It must be cached per jobId across calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage: mockListPage, listDealStageLabels: mockListDealStageLabels } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listDealStageLabels: vi.fn(),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return {
      listPage: mockListPage,
      listPropertyNames: vi.fn().mockResolvedValue(['dealname']),
      listDealStageLabels: mockListDealStageLabels,
    };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({ upsertByHubspotId: vi.fn().mockResolvedValue('created') }));
vi.mock('../src/services/hubspot/mappers.js', () => ({
  mapCompany: vi.fn(), mapContact: vi.fn(),
  mapDeal: vi.fn().mockReturnValue({
    hubspotId: 'hs-1', name: 'Deal', dealSize: null, stage: null,
    description: null, associatedCompanyHubspotId: null, customFields: {}, hubspotProperties: {},
  }),
}));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(), upsert: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [] }),
    single: vi.fn().mockResolvedValue({ data: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

function runningDealsJob(jobId: string, cursor: string | null = null) {
  return makeChain({
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: jobId, organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'deals', cursor },
    }),
  });
}

describe('runImportBatch — deal stage label caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
    mockListDealStageLabels.mockResolvedValue({ '104512346': 'Closed Won' });
  });

  it('fetches pipeline stage labels only once across multiple batches of the same job', async () => {
    // First batch still has a nextCursor (more deals remain); second batch
    // finishes. Both must reuse the same cached labels.
    mockFrom.mockImplementation(() => runningDealsJob('job-cache-1', null));
    mockListPage.mockResolvedValueOnce({ results: [{ id: 'hs-1', properties: { dealname: 'A' } }], nextCursor: 'cursor-2' });
    mockListPage.mockResolvedValueOnce({ results: [{ id: 'hs-2', properties: { dealname: 'B' } }], nextCursor: null });

    await runImportBatch('job-cache-1', 'tok');
    await runImportBatch('job-cache-1', 'tok');

    expect(mockListDealStageLabels).toHaveBeenCalledTimes(1);
  });

  it('fetches pipeline stage labels again for a different job', async () => {
    mockFrom.mockImplementation(() => runningDealsJob('job-cache-2', null));
    mockListPage.mockResolvedValue({ results: [], nextCursor: null });

    await runImportBatch('job-cache-1', 'tok');
    await runImportBatch('job-cache-2', 'tok');

    expect(mockListDealStageLabels).toHaveBeenCalledTimes(2);
  });
});

describe('runImportBatch — resolveCompanyId natural-key ordering', () => {
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
    mockListDealStageLabels.mockResolvedValue({});
  });

  it('orders the fallback Company lookup so duplicate names resolve deterministically', async () => {
    const loadJobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-x', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'deals', cursor: null },
      }),
    });
    const companyLookupChain = makeChain({ limit: vi.fn().mockResolvedValue({ data: [{ id: 'company-1' }] }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-x' } }) });

    let call = 0;
    mockFrom.mockImplementation(() => {
      call += 1;
      if (call === 1) return loadJobChain;      // loadJob
      if (call === 2) return companyLookupChain; // resolveCompanyId natural-key fallback
      return finalUpdateChain;                   // advance-cursor / complete
    });
    mockListPage.mockResolvedValue({ results: [{ id: 'hs-1', properties: { dealname: 'X' } }], nextCursor: null });

    await runImportBatch('job-x', 'tok');

    expect(companyLookupChain.order).toHaveBeenCalledWith('createdAt', { ascending: true });
  });
});
