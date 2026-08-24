// POST /api/webhooks/reply-io/:secret — public Reply.io reply-event
// webhook.
//
// Reply.io has no native webhook signing (see services/replyIoService.ts's
// module header for the full research trail — checked their webhook
// creation docs, event docs, payload docs, and their entire bundled OpenAPI
// spec for "signature"/"hmac"/"secret": zero matches). So authenticity here
// is entirely our own shared secret, carried as a URL path segment — the
// operator sets REPLY_IO_WEBHOOK_SECRET in .env and pastes
// `https://<domain>/api/webhooks/reply-io/<that same secret>` as the
// webhook URL when registering the subscription with Reply.io (dashboard,
// or POST /v3/webhooks — Reply.io supports both). See .env.example.
//
// Mounted BEFORE the authenticated routers in app.ts / app-lite.ts, same as
// dropbox-sign-webhook.ts — this can't go through authMiddleware/
// orgMiddleware because Reply.io can't carry a Supabase session. There is
// no req.user here, so the Cicero Capital org is looked up directly by
// Organization.slug (this webhook only exists to serve that one org's
// Outreach board — see requireCiceroCapital in middleware/orgScope.ts for
// the equivalent authenticated-route gate).

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { verifyReplyIoWebhookSecret } from '../services/replyIoService.js';
import { recordOutreachReply } from '../services/outreachReplyRecorder.js';

const router = Router();

const REPLY_EVENT_TYPES = new Set(['email_replied', 'contact_replied']);

router.post('/:secret', async (req: Request, res: Response) => {
  // Verify the shared secret on EVERY request before doing anything else —
  // reject immediately on mismatch. Never trust payload contents before
  // this check passes.
  if (!verifyReplyIoWebhookSecret(req.params.secret)) {
    log.warn('reply-io webhook: secret mismatch or REPLY_IO_WEBHOOK_SECRET not configured, rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Past this point the caller is authenticated as whoever holds
  // REPLY_IO_WEBHOOK_SECRET — but the payload shape is still untrusted
  // third-party input. Malformed/unexpected payloads must never 500; log
  // and 200 for anything we can't confidently act on. Non-200 is reserved
  // strictly for the auth failure above, so Reply.io never gets retried
  // for something that isn't actually a failure on their end.
  try {
    const payload = (req.body ?? {}) as Record<string, any>;
    const eventType: string | undefined = payload?.event?.type;

    if (!eventType || !REPLY_EVENT_TYPES.has(eventType)) {
      // A subscription we're not set up to act on yet (or a malformed
      // event) — ack so Reply.io doesn't retry.
      log.info('reply-io webhook: ignoring non-reply event', { eventType: eventType || null });
      return res.status(200).end();
    }

    const email: string | undefined = payload?.contact_fields?.email;
    if (!email || typeof email !== 'string') {
      log.warn('reply-io webhook: reply event with no contact email in payload', { eventType });
      return res.status(200).end();
    }

    const { data: org, error: orgError } = await supabase
      .from('Organization')
      .select('id')
      .eq('slug', 'cicero-capital')
      .single();

    if (orgError || !org) {
      log.error('reply-io webhook: cicero-capital org lookup failed', orgError);
      return res.status(200).end();
    }

    // limit(1) rather than .single()/.maybeSingle() — OutreachContact has
    // no unique constraint on email, so more than one row could match; take
    // the first rather than letting a duplicate-email edge case error out.
    // Select name/company/channel too — not just id — since
    // recordOutreachReply passes them to the reply-intent classifier as
    // context.
    const { data: contacts, error: contactError } = await supabase
      .from('OutreachContact')
      .select('id, name, company, channel')
      .eq('organizationId', org.id)
      .eq('email', email)
      .limit(1);

    if (contactError) {
      log.error('reply-io webhook: contact lookup failed', contactError);
      return res.status(200).end();
    }

    const contact = contacts?.[0];
    if (!contact) {
      log.info('reply-io webhook: no matching outreach contact for reply', { email, eventType });
      return res.status(200).end();
    }

    const replyText: string | undefined = typeof payload?.email_text === 'string' ? payload.email_text : undefined;
    const replyDateRaw: string | undefined = payload?.reply_date || payload?.event?.date;
    const replyDate =
      replyDateRaw && !Number.isNaN(Date.parse(replyDateRaw)) ? new Date(replyDateRaw).toISOString() : new Date().toISOString();

    // Persistence + reply-intent classification shared with the on-demand
    // poll path (routes/outreach.ts POST /sync-replies) — see
    // services/outreachReplyRecorder.ts.
    const result = await recordOutreachReply({
      organizationId: org.id,
      contactId: contact.id,
      name: contact.name,
      company: contact.company,
      channel: contact.channel,
      replyText: replyText ?? null,
      replyDate,
    });

    if (!result.persisted) {
      log.error('reply-io webhook: failed to record reply', { contactId: contact.id, eventType });
    } else {
      log.info('reply-io webhook: recorded reply', { contactId: contact.id, eventType, needsReview: result.needsReview });
    }

    return res.status(200).end();
  } catch (err) {
    log.error('reply-io webhook: unexpected error processing payload', err);
    return res.status(200).end();
  }
});

export default router;
