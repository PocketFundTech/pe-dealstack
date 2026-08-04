import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listPropertyNames } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listPropertyNames: vi.fn(),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage, listPropertyNames, listDealStageLabels: vi.fn().mockResolvedValue({}) };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
  upsertContactInteractionByHubspotId: vi.fn().mockResolvedValue('created'),
}));
vi.mock('../src/services/hubspot/mappers.js', () => ({ mapCompany: vi.fn(), mapContact: vi.fn(), mapDeal: vi.fn() }));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

describe('runImportBatch — per-object-type fetch failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
    listPropertyNames.mockResolvedValue(['hs_note_body']);
  });

  it('advances to the next object type instead of failing the whole job when a fetch fails', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'notes', cursor: null },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : advanceChain;
    });

    listPage.mockRejectedValue(new Error('HubSpot notes list failed: 403 MISSING_SCOPES'));

    const result = await runImportBatch('job-1', 'tok');

    expect(result).toBe(true); // more work remains — advanced, didn't stop
    expect(advanceChain.update).toHaveBeenCalledWith(expect.objectContaining({
      currentObject: 'calls', status: 'running',
    }));
    // Must NOT have set status: 'failed'.
    expect(advanceChain.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('still fails the job when the LAST object type fetch fails, with nowhere left to advance', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-2', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'tasks', cursor: null },
      }),
    });
    const failChain = makeChain();

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : failChain;
    });

    listPage.mockRejectedValue(new Error('HubSpot tasks list failed: 403 MISSING_SCOPES'));

    const result = await runImportBatch('job-2', 'tok');

    expect(result).toBe(false);
    expect(failChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('preserves already-accumulated counts for prior object types when skipping', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-3', organizationId: 'org-A', status: 'running',
          objectCounts: { companies: { processed: 5, created: 5, updated: 0, failed: 0 } },
          currentObject: 'notes', cursor: null,
        },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-3' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : advanceChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    await runImportBatch('job-3', 'tok');

    const updateCall = (advanceChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as { objectCounts: Record<string, unknown> };
    expect(updateCall.objectCounts.companies).toEqual({ processed: 5, created: 5, updated: 0, failed: 0 });
  });

  it('marks the job completed (not failed) when the last object type fails but an earlier type succeeded', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-4', organizationId: 'org-A', status: 'running',
          objectCounts: { companies: { processed: 5, created: 5, updated: 0, failed: 0 } },
          currentObject: 'tasks', cursor: null,
        },
      }),
    });
    const finishChain = makeChain();

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    const result = await runImportBatch('job-4', 'tok');

    expect(result).toBe(false);
    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      error: expect.stringContaining('MISSING_SCOPES'),
    }));
  });

  it('still marks the job failed when the last object type fails and nothing else succeeded', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-5', organizationId: 'org-A', status: 'running',
          objectCounts: {}, currentObject: 'tasks', cursor: null,
        },
      }),
    });
    const finishChain = makeChain();

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    const result = await runImportBatch('job-5', 'tok');

    expect(result).toBe(false);
    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});
