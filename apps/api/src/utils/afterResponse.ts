import type { Request } from 'express';
import { log } from './logger.js';
import { getUsageContext, runWithUsageContext } from '../middleware/usageContext.js';

// A route handler can attach this to the incoming Express request when it's
// running inside the Next.js proxy (see apps/web-next/src/lib/api-adapter.ts)
// so background work can outlive the HTTP response without Vercel freezing
// the serverless function mid-task. Outside that context (local `app.ts` dev
// server, tests, Render) the property is simply absent.
export interface RequestWithAfterResponse extends Request {
  runAfterResponse?: (fn: () => void | Promise<void>) => void;
}

/**
 * Run `fn` after the response has been sent, when the caller has wired up a
 * post-response hook (Next's `after()`, attached by the proxy adapter as
 * `req.runAfterResponse`). If no hook is present — local dev via app.ts,
 * tests, or any non-Vercel deployment — `fn` runs inline and is awaited, so
 * behavior matches what the route did before this helper existed.
 *
 * Errors thrown by `fn` are swallowed and logged here (never surfaced to the
 * client, since the response may already be on its way / already sent) so a
 * background failure can't crash the process or throw an unhandled rejection.
 */
export async function runAfterResponse(
  req: Request,
  fn: () => void | Promise<void>,
): Promise<void> {
  const hook = (req as RequestWithAfterResponse).runAfterResponse;
  if (typeof hook === 'function') {
    // Capture the AsyncLocalStorage-bound usage context NOW, while we're
    // still inside the request's async chain. Next's after() runs the
    // deferred job on a fresh continuation outside that chain — without
    // re-binding, any AI call inside `fn` finds no usage context and
    // recordUsageEvent() silently no-ops ("no usage context bound"), so
    // background upload/extraction work went untracked.
    const ctx = getUsageContext();
    hook(async () => {
      try {
        if (ctx) {
          await runWithUsageContext(ctx, fn);
        } else {
          await fn();
        }
      } catch (err) {
        log.error('runAfterResponse: background job failed', err);
      }
    });
    return;
  }
  // No hook available — preserve legacy inline/awaited behavior. Already
  // running inside the request's context here, so no re-bind needed.
  await fn();
}
