// ─── Shared-secret webhook verification ─────────────────────────────
//
// Constant-time comparison for webhook shared secrets that WE define and
// hand to a third party (as a URL path segment, e.g.
// REPLY_IO_WEBHOOK_SECRET, CLAY_IMPORT_WEBHOOK_SECRET) — as opposed to a
// provider-issued signature/HMAC, which is verified differently (see
// integrations/dropboxSign/client.ts's verifyWebhookEvent for that pattern:
// an HMAC over the raw payload using a key the provider tells us, not a
// value we invented ourselves).
//
// Pulled out of services/replyIoService.ts so a second "our own secret in
// the URL" webhook (routes/outreach-clay-import-webhook.ts) doesn't
// reimplement the same timing-safe-compare logic.

import { timingSafeEqual } from 'node:crypto';

/**
 * Fails CLOSED: false whenever `expected` isn't configured, or `provided`
 * is missing/empty — an unconfigured secret must never be treated as
 * "anything passes". Length-checked before timingSafeEqual because Node's
 * implementation throws (rather than returning false) on a length
 * mismatch, and a length mismatch is itself not secret-worthy information
 * to leak via a crash vs. a clean `false`.
 */
export function verifySharedWebhookSecret(expected: string | undefined, provided: string | undefined | null): boolean {
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
