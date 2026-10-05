// POST /api/webhooks/clay-enrichment/:secret — Clay enrichment RESULT
// callback.
//
// Completes the other half of the Clay enrichment loop. What already
// existed (services/outreachEnrichment.ts's enrichViaClay): we POST one
// contact to CLAY_WEBHOOK_URL (a per-table webhook SOURCE a human sets up
// inside Clay), including our contactId. Clay enqueues it, runs its
// enrichment waterfall over the next few minutes, and previously had no way
// to hand the result back — enrichViaClay's own comment says as much
// ("contributes ZERO synchronous fields... a separate, deliberately
// out-of-scope follow-up"). This route is that follow-up: a human adds an
// outbound "Send Webhook" ACTION on that same Clay table (fires once
// enrichment finishes on a row), pointed at this route, with the
// original contactId passed through so we know which OutreachContact to
// update — no fuzzy matching needed here, unlike the bulk-sourcing import
// path, since Clay is just echoing back an id we gave it.
//
// Same shared-secret-in-URL scheme as every other inbound webhook in this
// feature area (outreach-webhooks.ts, outreach-clay-import-webhook.ts) —
// Clay can't carry a Supabase session or sign requests for us. A separate
// secret from CLAY_IMPORT_WEBHOOK_SECRET since this is a different Clay
// table/flow (single-contact enrichment vs bulk sourcing) — least
// privilege, and one leaking doesn't compromise the other.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { verifySharedWebhookSecret } from '../utils/webhookSecret.js';
import { recordTouch } from '../services/outreachTouchLog.js';

const router = Router();

const CLAY_ENRICHMENT_RESULT_SECRET = process.env.CLAY_ENRICHMENT_RESULT_SECRET;

router.post('/:secret', async (req: Request, res: Response) => {
  // Verify before doing anything else — reject immediately on mismatch,
  // never trust payload contents before this passes.
  if (!verifySharedWebhookSecret(CLAY_ENRICHMENT_RESULT_SECRET, req.params.secret)) {
    log.warn('clay-enrichment webhook: secret mismatch or CLAY_ENRICHMENT_RESULT_SECRET not configured, rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Past the secret check, payload shape is still untrusted third-party
  // input. Malformed/unexpected payloads must never 500 — log and 200, same
  // idiom as every other inbound webhook here. Non-200 is reserved strictly
  // for the auth failure above.
  try {
    const payload = (req.body ?? {}) as Record<string, any>;
    const contactId: string | undefined = payload?.contactId;

    if (!contactId || typeof contactId !== 'string') {
      log.warn('clay-enrichment webhook: payload missing contactId, cannot match to a contact');
      return res.status(200).end();
    }

    // Cicero Capital only, same as every other route in this feature area —
    // no req.user here (Clay can't carry a session), so resolved directly.
    const { data: org, error: orgError } = await supabase
      .from('Organization')
      .select('id')
      .eq('slug', 'cicero-capital')
      .single();

    if (orgError || !org) {
      log.error('clay-enrichment webhook: cicero-capital org lookup failed', orgError);
      return res.status(200).end();
    }

    const { data: contact, error: fetchError } = await supabase
      .from('OutreachContact')
      .select('*')
      .eq('id', contactId)
      .eq('organizationId', org.id)
      .single();

    if (fetchError || !contact) {
      log.info('clay-enrichment webhook: no matching contact for contactId', { contactId });
      return res.status(200).end();
    }

    // Fill-blank-only — same rule as the manual Enrich route and the bulk
    // importers: an async result must never clobber a human-edited field,
    // or a field Apollo/Anymail Finder already filled synchronously at the
    // time of the original Enrich click.
    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      enrichedAt: new Date().toISOString(),
      enrichmentData: {
        ...(contact.enrichmentData || {}),
        clay: { receivedAt: new Date().toISOString(), raw: payload },
      },
      enrichmentSource: Array.from(new Set([...(contact.enrichmentSource || []), 'clay'])),
    };
    if (payload.email && !contact.email) updates.email = payload.email;
    if (payload.phone && !contact.phone) updates.phone = payload.phone;
    if (payload.title && !contact.title) updates.title = payload.title;
    if (payload.linkedinUrl && !contact.linkedinUrl) updates.linkedinUrl = payload.linkedinUrl;
    if (payload.company && !contact.company) updates.company = payload.company;

    const { error: updateError } = await supabase
      .from('OutreachContact')
      .update(updates)
      .eq('id', contactId)
      .eq('organizationId', org.id);

    if (updateError) {
      log.error('clay-enrichment webhook: failed to persist result', updateError, { contactId });
      return res.status(200).end();
    }

    await recordTouch({
      organizationId: org.id,
      contactId,
      channel: 'enrichment',
      type: 'enriched',
      direction: 'inbound',
      metadata: { sourcesUsed: ['clay'], trigger: 'clay_callback' },
    });

    log.info('clay-enrichment webhook: recorded result', { contactId });
    return res.status(200).end();
  } catch (err) {
    log.error('clay-enrichment webhook: unexpected error processing payload', err);
    return res.status(200).end();
  }
});

export default router;
