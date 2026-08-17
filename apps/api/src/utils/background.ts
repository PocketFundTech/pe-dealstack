// ─── Serverless-safe background work ────────────────────────────────
// On Vercel, the function can be frozen as soon as the response is sent —
// a plain fire-and-forget promise silently dies (see the runDeepPass
// comment in documents-upload.ts, which chose to AWAIT for exactly this
// reason). `waitUntil` from @vercel/functions tells the platform to keep
// the invocation alive until the task settles, WITHOUT delaying the
// response. Outside Vercel (local dev, tests) the process isn't frozen,
// so the already-started promise simply runs to completion on its own.

import { log } from './logger.js';

export function runInBackground(label: string, task: Promise<unknown>): void {
  // Attach the error handler FIRST so a fast rejection can never surface
  // as an unhandled rejection while the waitUntil import resolves.
  const settled = task.catch((err) => {
    log.error(`background task failed: ${label}`, err);
  });
  void import('@vercel/functions')
    .then(({ waitUntil }) => waitUntil(settled))
    .catch(() => {
      // Not running on Vercel (or package unavailable) — nothing to do;
      // `settled` continues in the background of this live process.
    });
}
