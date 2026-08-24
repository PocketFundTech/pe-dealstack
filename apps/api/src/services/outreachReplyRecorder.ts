// ─── Shared "a reply came in" persistence ────────────────────────────
//
// Both reply-detection paths — the registered webhook
// (routes/outreach-webhooks.ts, currently unusable outside prod, see
// services/replyIoService.ts's module header) and the on-demand poll
// (routes/outreach.ts POST /sync-replies) — end up in the exact same place:
// a contact has a new reply, and it needs the same three things done to it:
//   1. lastReplyText / lastReplyAt written.
//   2. Claude's reply-intent read (services/replyIntentClassifier.ts) run
//      over that text.
//   3. replyIntent / needsReview written from that read — confident-only
//      (see classifyReplyIntent's doc comment): needsReview flags anything
//      the classifier couldn't confidently read, in which case replyIntent
//      is left unset rather than persisting an unconfident guess.
//
// Pulled out here so neither route re-implements the persistence shape —
// both call recordOutreachReply() with the raw reply text/date they found.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { classifyReplyIntent } from './replyIntentClassifier.js';

export interface RecordOutreachReplyInput {
  contactId: string;
  /** Only used as classifier context — not trusted for authorization; the
   *  caller must already have verified contactId belongs to the org. */
  name?: string | null;
  company?: string | null;
  channel?: string | null;
  /** Raw reply text (plain text, HTML already stripped upstream if needed). */
  replyText: string | null;
  /** ISO timestamp of the reply. */
  replyDate: string;
}

export interface RecordOutreachReplyResult {
  /** False only when the Supabase write itself failed. */
  persisted: boolean;
  /** True when Claude flagged this reply for human review (or wasn't confident). */
  needsReview: boolean;
  /** True when the classifier actually ran and returned a read (vs. skipped/failed). */
  classified: boolean;
}

/**
 * Persists a newly-detected reply on an OutreachContact row and runs it
 * through the reply-intent classifier. Never throws — a classifier failure
 * (see classifyReplyIntent) just leaves replyIntent/needsReview untouched,
 * and this function still writes lastReplyText/lastReplyAt either way. A
 * Supabase failure is logged and reflected in the returned `persisted` flag
 * rather than thrown, matching this feature area's soft-fail idiom.
 */
export async function recordOutreachReply(input: RecordOutreachReplyInput): Promise<RecordOutreachReplyResult> {
  const classification = await classifyReplyIntent({
    replyText: input.replyText || '',
    name: input.name,
    company: input.company,
    channel: input.channel,
  });

  const updates: Record<string, any> = {
    lastReplyText: input.replyText ? input.replyText.slice(0, 20000) : null,
    lastReplyAt: input.replyDate,
    updatedAt: new Date().toISOString(),
  };

  if (classification) {
    updates.needsReview = classification.needsReview;
    // Only a confident, clean read gets persisted as replyIntent — a
    // flagged read is surfaced to a human via needsReview instead, per
    // classifyReplyIntent's contract.
    updates.replyIntent = classification.needsReview ? null : classification.intent;
  }

  const { error } = await supabase.from('OutreachContact').update(updates).eq('id', input.contactId);

  if (error) {
    log.error('recordOutreachReply: failed to persist reply', { contactId: input.contactId, message: error.message });
    return { persisted: false, needsReview: classification?.needsReview ?? false, classified: !!classification };
  }

  log.info('recordOutreachReply: recorded reply', {
    contactId: input.contactId,
    classified: !!classification,
    needsReview: classification?.needsReview ?? false,
  });

  return { persisted: true, needsReview: classification?.needsReview ?? false, classified: !!classification };
}
