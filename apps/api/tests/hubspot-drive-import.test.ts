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
