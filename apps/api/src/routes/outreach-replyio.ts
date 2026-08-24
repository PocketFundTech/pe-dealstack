import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyOutreachContactAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { listCampaigns, addContactToCampaign, checkForNewReplies } from '../services/replyIoService.js';
import { recordOutreachReply } from '../services/outreachReplyRecorder.js';
import { recordTouch } from '../services/outreachTouchLog.js';

// Reply.io send + reply-sync routes for the Outreach pipeline board — split
// out of routes/outreach.ts (contact CRUD + enrich) to keep both files
// under this repo's 500-line convention (see AGENTS.md). Mounted at the
// same '/api/outreach' base with the same middleware chain — see
// app.ts/app-lite.ts. Org-gated to Cicero Capital only (requireCiceroCapital
// applied at the mount, not here — this router assumes the caller has
// already been authorized for the org).

const router = Router();

const sendContactSchema = z.object({
  campaignId: z.string().min(1, 'campaignId is required'),
});

// ─── GET /campaigns — List Reply.io campaigns for the Send picker ───
//
// See services/replyIoService.ts for the researched API version + auth
// details. No REPLY_IO_API_KEY configured is an expected, normal state —
// 200 with configured:false, not an error. A configured key that fails the
// live call (bad key, Reply.io outage, etc.) is a real error worth a
// non-200 so the UI can surface it.

router.get('/campaigns', async (req: Request, res) => {
  try {
    const result = await listCampaigns();

    if (!result.configured) {
      return res.status(200).json({ configured: false, campaigns: [], reason: 'Reply.io is not configured (REPLY_IO_API_KEY not set)' });
    }

    if (result.error) {
      return res.status(502).json({ configured: true, campaigns: [], error: result.error });
    }

    res.json({ configured: true, campaigns: result.campaigns });
  } catch (error) {
    log.error('List Reply.io campaigns error', error);
    res.status(500).json({ error: 'Failed to list Reply.io campaigns' });
  }
});

// ─── POST /contacts/:id/send — Send outreach contact via Reply.io ───
//
// Creates/finds the contact in Reply.io and enrolls it in the chosen
// campaign (services/replyIoService.ts addContactToCampaign) — this is what
// actually triggers Reply.io to start emailing them. On success, records
// replyIoCampaignId + sentAt on the OutreachContact row, and an
// OutreachTouch (channel:'email', type:'sent'). Reply tracking
// (lastReplyText/lastReplyAt) is populated later, out-of-band, by the
// inbound webhook in routes/outreach-webhooks.ts.

router.post('/contacts/:id/send', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const validation = sendContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const orgId = getOrgId(req);

    const existing = await verifyOutreachContactAccess(id, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    const { data: contact, error: fetchError } = await supabase
      .from('OutreachContact')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    const { campaignId } = validation.data;

    const result = await addContactToCampaign(campaignId, {
      name: contact.name,
      email: contact.email,
      company: contact.company,
      phone: contact.phone,
      linkedinUrl: contact.linkedinUrl,
    });

    if (!result.configured) {
      return res.status(200).json({ sent: false, reason: result.reason || 'Reply.io is not configured' });
    }

    if (!result.success) {
      // `reason` = a precondition we can name (no email / bad campaignId) —
      // caller's mistake, 400. `error` = a genuine Reply.io API failure —
      // upstream problem, 502. Same distinction outreachEnrichment.ts's
      // per-provider results make between "no_match" and "error".
      if (result.reason) {
        return res.status(400).json({ error: result.reason });
      }
      return res.status(502).json({ error: result.error || 'Failed to send via Reply.io' });
    }

    const updates = {
      updatedAt: new Date().toISOString(),
      replyIoCampaignId: campaignId,
      sentAt: new Date().toISOString(),
    };

    const { data: updated, error: updateError } = await supabase
      .from('OutreachContact')
      .update(updates)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (updateError) throw updateError;
    if (!updated) return res.status(404).json({ error: 'Outreach contact not found' });

    log.info('Outreach contact sent via Reply.io', {
      contactId: id,
      campaignId,
      replyIoContactId: result.replyIoContactId,
    });

    await recordTouch({
      organizationId: orgId,
      contactId: id,
      channel: 'email',
      type: 'sent',
      direction: 'outbound',
      metadata: { campaignId, replyIoContactId: result.replyIoContactId },
    });

    res.json(updated);
  } catch (error) {
    log.error('Send outreach contact via Reply.io error', error);
    res.status(500).json({ error: 'Failed to send outreach contact' });
  }
});

// ─── POST /sync-replies — on-demand Reply.io reply sync ─────────────
//
// Pull-based fallback for reply detection, same idiom as
// routes/legal-documents.ts's POST /legal-documents/check-signatures (see
// services/legalDocSignaturePollService.ts): the registered webhook
// (routes/outreach-webhooks.ts) needs a stable public URL this deployment
// doesn't have yet, so this on-demand poll is how replies get noticed until
// then — callable by a human now (a "Sync replies" button), and later by a
// cron the same way pollOrgSignatures is. No request body needed; runs
// across every contact in the caller's org that has a replyIoCampaignId.
//
// Newly-found replies are persisted (lastReplyText/lastReplyAt) and run
// through the reply-intent classifier (replyIntent/needsReview) via
// services/outreachReplyRecorder.ts — the exact same persistence path the
// webhook route uses, so poll and webhook classify identically once the
// webhook is usable again.

router.post('/sync-replies', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const { data: contacts, error } = await supabase
      .from('OutreachContact')
      .select('id, email, company, name, channel, sentAt, lastReplyAt')
      .eq('organizationId', orgId)
      .not('replyIoCampaignId', 'is', null);

    if (error) throw error;

    const rows = contacts || [];

    const result = await checkForNewReplies(
      rows.map((c) => ({
        contactId: c.id,
        email: c.email,
        lastReplyAt: c.lastReplyAt,
        sentAt: c.sentAt,
      })),
    );

    if (!result.configured) {
      return res.status(200).json({ checked: 0, newReplies: 0, flaggedForReview: 0, reason: 'Reply.io is not configured (REPLY_IO_API_KEY not set)' });
    }

    if (result.error) {
      return res.status(502).json({ error: result.error });
    }

    const byId = new Map(rows.map((c) => [c.id, c]));

    let flaggedForReview = 0;
    for (const reply of result.replies) {
      const contact = byId.get(reply.contactId);
      if (!contact) continue; // shouldn't happen — defensive

      const recorded = await recordOutreachReply({
        organizationId: orgId,
        contactId: reply.contactId,
        name: contact.name,
        company: contact.company,
        channel: contact.channel,
        replyText: reply.replyText,
        replyDate: reply.replyDate,
      });

      if (recorded.needsReview) flaggedForReview++;
    }

    log.info('Outreach reply sync completed', {
      orgId,
      checked: rows.length,
      newReplies: result.replies.length,
      flaggedForReview,
    });

    res.json({ checked: rows.length, newReplies: result.replies.length, flaggedForReview });
  } catch (error) {
    log.error('Sync outreach replies error', error);
    res.status(500).json({ error: 'Failed to sync Reply.io replies' });
  }
});

export default router;
