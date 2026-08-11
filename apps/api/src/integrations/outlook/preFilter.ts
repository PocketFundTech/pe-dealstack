import type { GraphMessage } from './types.js';

// Conservative pre-filter run BEFORE the AI classifier. It only drops mail that
// is clearly automated/bulk (no-reply senders, mailer daemons). It deliberately
// errs toward letting the classifier decide — a real deal email is never sent
// from a no-reply address, so this can't drop genuine deal mail. Its only job
// is to avoid spending LLM calls on obvious machine mail.
const AUTOMATED_SENDER =
  /(^|[._-])(no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|notifications?|newsletter|alerts?|updates?|mailer|bounce)([._-]|@)/i;

export function shouldSkipForAI(message: GraphMessage): boolean {
  const from = (
    message.from?.emailAddress?.address ??
    message.sender?.emailAddress?.address ??
    ''
  ).toLowerCase();
  if (!from) return false;
  return AUTOMATED_SENDER.test(from);
}
