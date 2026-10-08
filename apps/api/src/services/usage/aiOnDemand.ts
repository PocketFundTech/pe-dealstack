import { getUsageContext } from '../../middleware/usageContext.js';

/**
 * AI runs when a user asks for it — a button click, a chat message, an
 * ingest they started. Work nobody clicked for (cron jobs, webhooks, the
 * scheduled integration sync) skips its AI step unless AI_BACKGROUND_JOBS=on.
 *
 * Off by default so the AI credit is spent only on what people ask for.
 */
export function isBackgroundAiEnabled(): boolean {
  return (process.env.AI_BACKGROUND_JOBS ?? '').trim().toLowerCase() === 'on';
}

/**
 * True when the current work came from a user's request (an HTTP request
 * context, including work deferred until after its response), or when
 * background AI is switched on. Cron, webhook and scheduled-sync work runs
 * with a 'background' context or none, so it gets false by default.
 */
export function canRunAiNow(): boolean {
  if (getUsageContext()?.source === 'http') return true;
  return isBackgroundAiEnabled();
}
