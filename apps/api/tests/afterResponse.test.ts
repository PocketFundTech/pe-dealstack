/**
 * runAfterResponse() usage-context re-binding (usage-cost-accuracy). Next's
 * after() runs the deferred job on a fresh continuation outside the
 * request's AsyncLocalStorage chain — without re-binding the captured
 * UsageContext, any AI call inside the deferred job found no usage context
 * and recordUsageEvent() silently no-op'd, so background upload/extraction
 * work went completely untracked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';
import { runAfterResponse, type RequestWithAfterResponse } from '../src/utils/afterResponse.js';
import { runWithUsageContext, getUsageContext, type UsageContext } from '../src/middleware/usageContext.js';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ctx: UsageContext = { userId: 'user-1', organizationId: 'org-1', source: 'http' };

function fakeRequestWithHook(): { req: RequestWithAfterResponse; deferred: Array<() => void | Promise<void>> } {
  const deferred: Array<() => void | Promise<void>> = [];
  const req = {
    runAfterResponse: (fn: () => void | Promise<void>) => {
      deferred.push(fn);
    },
  } as unknown as RequestWithAfterResponse;
  return { req, deferred };
}

describe('runAfterResponse — usage context propagation', () => {
  it('re-binds the captured usage context inside the deferred job (Next after() path)', async () => {
    const { req, deferred } = fakeRequestWithHook();
    let seenInsideJob: UsageContext | undefined;

    await runWithUsageContext(ctx, async () => {
      await runAfterResponse(req as unknown as Request, () => {
        seenInsideJob = getUsageContext();
      });
    });

    // Not run yet — runAfterResponse only registers the hook.
    expect(seenInsideJob).toBeUndefined();
    expect(deferred).toHaveLength(1);

    // Simulate Next calling the deferred job OUTSIDE the original async chain.
    await deferred[0]();
    expect(seenInsideJob).toEqual(ctx);
  });

  it('runs the job with no context when none was bound at schedule time (no crash, no fabricated context)', async () => {
    const { req, deferred } = fakeRequestWithHook();
    let seenInsideJob: UsageContext | undefined | 'not-called' = 'not-called';

    await runAfterResponse(req as unknown as Request, () => {
      seenInsideJob = getUsageContext();
    });
    await deferred[0]();

    expect(seenInsideJob).toBeUndefined();
  });

  it('runs fn inline and awaited when no after() hook is present (local dev / tests / Render)', async () => {
    const req = {} as Request;
    let ran = false;
    await runWithUsageContext(ctx, async () => {
      await runAfterResponse(req, async () => {
        ran = true;
        expect(getUsageContext()).toEqual(ctx);
      });
    });
    expect(ran).toBe(true);
  });

  it('logs but does not throw when the deferred job fails', async () => {
    const { req, deferred } = fakeRequestWithHook();
    await runWithUsageContext(ctx, async () => {
      await runAfterResponse(req as unknown as Request, () => {
        throw new Error('boom');
      });
    });
    await expect(deferred[0]()).resolves.toBeUndefined();
  });
});
