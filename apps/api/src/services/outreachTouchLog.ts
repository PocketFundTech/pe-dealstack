// ─── OutreachTouch append-only event log ─────────────────────────────
//
// OutreachContact still carries the mutable scalar fields it always has
// (stageId, lastReplyAt, sentAt, ...) — those are NOT going away and this
// module doesn't touch them. OutreachTouch (see
// cicero-outreach-touch-log-migration.sql) is a parallel, append-only log:
// one row per action, per channel, so a contact that's quiet on email but
// active on LinkedIn has a real history instead of a single stage field
// that can't hold both truths at once. Deliberately NOT used to derive or
// auto-move stageId anywhere in this codebase — the actual stage taxonomy
// still needs the human workshop the source planning doc calls for.
//
// recordTouch() is called from every automated Outreach write path (Send,
// reply recording, Enrich, Clay import) in ADDITION to whatever that path
// already persists — never as a replacement.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export type OutreachTouchDirection = 'outbound' | 'inbound';

export interface RecordTouchInput {
  organizationId: string;
  contactId: string;
  /** e.g. 'email', 'enrichment', 'clay_import' — free text, not an enum in the DB. */
  channel: string;
  /** e.g. 'sent', 'replied', 'enriched', 'sourced', 'reimported' — free text, not an enum in the DB. */
  type: string;
  direction: OutreachTouchDirection;
  /** ISO timestamp of when the underlying action actually happened. Defaults to now(). */
  occurredAt?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Thin insert into OutreachTouch. Soft-fails: logs and returns on any
 * error, NEVER throws past itself — a touch-log write failing must never
 * break the primary action (send/reply/enrich/import) that triggered it.
 */
export async function recordTouch(input: RecordTouchInput): Promise<void> {
  try {
    const { error } = await supabase.from('OutreachTouch').insert({
      organizationId: input.organizationId,
      contactId: input.contactId,
      channel: input.channel,
      type: input.type,
      direction: input.direction,
      occurredAt: input.occurredAt || new Date().toISOString(),
      metadata: input.metadata ?? null,
    });

    if (error) {
      log.error('recordTouch: failed to insert OutreachTouch', error, {
        contactId: input.contactId,
        channel: input.channel,
        type: input.type,
      });
      return;
    }

    log.info('recordTouch: recorded', {
      contactId: input.contactId,
      channel: input.channel,
      type: input.type,
      direction: input.direction,
    });
  } catch (err) {
    // Defensive — the insert above shouldn't throw (Supabase errors come
    // back on `error`, not as a rejection), but this is a soft-fail
    // side-channel by design, so nothing from here should ever propagate.
    log.error('recordTouch: unexpected error', err, { contactId: input.contactId, channel: input.channel, type: input.type });
  }
}
