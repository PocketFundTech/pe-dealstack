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

vi.mock('../src/services/hubspot/fileQueue.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/fileQueue.js')>();
  return { ...real, drainFileQueue: vi.fn().mockResolvedValue({ done: true, note: null }) };
});

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

/**
 * Second batch: the job is now in the files phase (empty queue). Feeds back the
 * counts/error the first batch saved and returns the files phase's final update.
 */
async function finishInFilesPhase(jobId: string, saved: { objectCounts: unknown; error?: string | null }) {
  const jobChain = makeChain({
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: jobId, organizationId: 'org-A', status: 'running', objectCounts: saved.objectCounts, currentObject: 'files', cursor: null, error: saved.error ?? null },
    }),
  });
  const finishChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: jobId } }) });
  let calls = 0;
  mockFrom.mockImplementation(() => (++calls === 1 ? jobChain : finishChain));
  expect(await runImportBatch(jobId, 'tok')).toBe(false);
  const updates = (finishChain.update as ReturnType<typeof vi.fn>).mock.calls;
  return updates[updates.length - 1][0] as Record<string, unknown>;
}
const savedBy = (chain: Record<string, unknown>) =>
  (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as { objectCounts: unknown; error?: string | null };

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

  it('records how far it got when a LATER page fails, instead of advancing silently', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-1', organizationId: 'org-A', status: 'running', currentObject: 'companies', cursor: 'page-4',
          objectCounts: { companies: { processed: 300, created: 300, updated: 0, failed: 0, skipped: 0 } },
        },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });
    let calls = 0;
    mockFrom.mockImplementation(() => (++calls === 1 ? jobChain : advanceChain));
    listPage.mockRejectedValue(new Error('HubSpot companies list failed: 502 Bad Gateway'));

    expect(await runImportBatch('job-1', 'tok')).toBe(true);
    expect(advanceChain.update).toHaveBeenCalledWith(expect.objectContaining({
      currentObject: 'contacts',
      error: expect.stringMatching(/^companies: stopped after 300 records .*502.*Run the import again/),
    }));
  });

  it('still fails the job when the LAST object type fetch fails, with nowhere left to advance', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-2', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'tasks', cursor: null },
      }),
    });
    const failChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : failChain;
    });

    listPage.mockRejectedValue(new Error('HubSpot tasks list failed: 403 MISSING_SCOPES'));

    const result = await runImportBatch('job-2', 'tok');

    // 'tasks' is no longer last: the job advances to the files phase.
    expect(result).toBe(true);
    expect(failChain.update).toHaveBeenCalledWith(expect.objectContaining({ currentObject: 'files', status: 'running' }));
    // Nothing succeeded anywhere: the files phase ends the job as failed.
    const final = await finishInFilesPhase('job-2', savedBy(failChain));
    expect(final).toMatchObject({ status: 'failed', currentObject: null });
    expect(String(final.error)).toContain('MISSING_SCOPES');
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
    expect(updateCall.objectCounts.companies).toMatchObject({ processed: 5, created: 5, updated: 0, failed: 0 });
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
    const finishChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    const result = await runImportBatch('job-4', 'tok');

    expect(result).toBe(true);
    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({
      currentObject: 'files', status: 'running',
      error: expect.stringContaining('MISSING_SCOPES'),
    }));
    const final = await finishInFilesPhase('job-4', savedBy(finishChain));
    expect(final).toMatchObject({ status: 'completed', currentObject: null });
    expect(String(final.error)).toContain('MISSING_SCOPES');
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
    const finishChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    const result = await runImportBatch('job-5', 'tok');

    expect(result).toBe(true);
    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({ currentObject: 'files', status: 'running' }));    const final = await finishInFilesPhase('job-5', savedBy(finishChain));
    expect(final).toMatchObject({ status: 'failed' });
    expect(String(final.error)).toContain('MISSING_SCOPES');
  });

  it('marks the job failed, not completed, when a type processed records but every write failed', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-6', organizationId: 'org-A', status: 'running',
          objectCounts: { companies: { processed: 5, created: 0, updated: 0, failed: 5 } },
          currentObject: 'tasks', cursor: null,
        },
      }),
    });
    const finishChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    const result = await runImportBatch('job-6', 'tok');

    expect(result).toBe(true);
    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({ currentObject: 'files', status: 'running' }));    const final = await finishInFilesPhase('job-6', savedBy(finishChain));
    expect(final).toMatchObject({ status: 'failed' });
  });

  it('clears currentObject and cursor on the terminal branch, whether the job ends completed or failed', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-7', organizationId: 'org-A', status: 'running',
          objectCounts: { companies: { processed: 5, created: 5, updated: 0, failed: 0 } },
          currentObject: 'tasks', cursor: null,
        },
      }),
    });
    const finishChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : finishChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    await runImportBatch('job-7', 'tok');

    expect(finishChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'running', currentObject: 'files', cursor: null,
    }));
    // The files phase's terminal update clears currentObject and cursor.
    expect(await finishInFilesPhase('job-7', savedBy(finishChain))).toMatchObject({
      status: 'completed', currentObject: null, cursor: null,
    });
  });
});

describe('runImportBatch — totals for progress', () => {
  it('fetches every object total once and stores it, null when HubSpot cannot say', async () => {
    const { HubSpotClient } = await import('../src/services/hubspot/client.js');
    const countObjects = vi.fn(async (o: string) => (o === 'companies' ? 3971 : o === 'emails' ? null : 10));
    (HubSpotClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return { listPage, listPropertyNames, countObjects, listDealStageLabels: vi.fn().mockResolvedValue({}) };
    });
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'notes', cursor: null },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });
    let calls = 0;
    mockFrom.mockImplementation(() => (++calls === 1 ? jobChain : advanceChain));
    listPage.mockResolvedValue({ results: [], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    expect(countObjects).toHaveBeenCalledTimes(8);
    const saved = (advanceChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0].objectCounts;
    expect(saved.companies.total).toBe(3971);
    expect(saved.emails.total).toBeNull();
  });
});
