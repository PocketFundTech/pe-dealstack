/**
 * driveImport is the fire-and-forget loop POST /import kicks off. When
 * runImportBatch keeps returning true (more work remains) all the way to the
 * safety cap, the loop used to just stop — nothing ever updated the job past
 * that point, so it sat at status 'running' forever and the UI polled
 * indefinitely. It must mark the job with an actionable, safe-to-retry state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, runImportBatch } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  runImportBatch: vi.fn(),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/services/hubspot/importEngine.js', () => ({ runImportBatch }));

import { driveImport } from '../src/routes/hubspot-import.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    error: null,
  };
  return Object.assign(base, overrides);
}

describe('driveImport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the job failed with an actionable, safe-to-retry message when the batch cap is hit', async () => {
    runImportBatch.mockResolvedValue(true); // never signals completion
    const updateChain = makeChain();
    mockFrom.mockReturnValue(updateChain);

    await driveImport('job-1', 'tok', 'fill', 3);

    expect(runImportBatch).toHaveBeenCalledTimes(3);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/click.*import.*again/i),
    }));
  });

  it('does not touch the job when the batch loop completes naturally', async () => {
    runImportBatch.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await driveImport('job-2', 'tok', 'fill', 10);

    expect(runImportBatch).toHaveBeenCalledTimes(2);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('still marks the job failed with the thrown error when runImportBatch itself throws', async () => {
    runImportBatch.mockRejectedValue(new Error('HubSpot API unreachable'));
    const updateChain = makeChain();
    mockFrom.mockReturnValue(updateChain);

    await driveImport('job-3', 'tok', 'fill', 10);

    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'HubSpot API unreachable',
    }));
  });
});

/**
 * Vercel freezes the serverless instance the moment the HTTP response is sent,
 * so a fire-and-forget background loop is killed mid-import and the job sits at
 * status 'running' forever. driveImport must instead run INSIDE the request,
 * bounded by a time budget, and report whether work remains so the client can
 * resume it with another request.
 */
describe('driveImport — serverless time budget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns more:true and leaves the job running when the time budget is exhausted mid-import', async () => {
    runImportBatch.mockResolvedValue(true); // work always remains
    mockFrom.mockReturnValue(makeChain());

    // budgetMs: 0 → the budget is already spent after the first batch.
    const result = await driveImport('job-budget', 'tok', 'fill', 1000, 0);

    expect(result).toEqual({ more: true });
    // Exactly one batch ran, then it yielded rather than burning the whole cap.
    expect(runImportBatch).toHaveBeenCalledTimes(1);
    // Critically: the job must NOT be marked failed — it's resumable.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns more:false when the import finishes within the budget', async () => {
    runImportBatch.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await driveImport('job-done', 'tok', 'fill', 1000, 60_000);

    expect(result).toEqual({ more: false });
    expect(runImportBatch).toHaveBeenCalledTimes(2);
  });

  it('returns more:false after hitting the batch cap (not resumable via continue — needs a fresh import)', async () => {
    runImportBatch.mockResolvedValue(true);
    mockFrom.mockReturnValue(makeChain());

    const result = await driveImport('job-cap', 'tok', 'fill', 3, 60_000);

    expect(result).toEqual({ more: false });
    expect(runImportBatch).toHaveBeenCalledTimes(3);
  });

  it('returns more:false when runImportBatch throws, so the client stops retrying', async () => {
    runImportBatch.mockRejectedValue(new Error('boom'));
    mockFrom.mockReturnValue(makeChain());

    const result = await driveImport('job-throw', 'tok', 'fill', 10, 60_000);

    expect(result).toEqual({ more: false });
  });
});
