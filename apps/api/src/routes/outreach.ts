import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyOutreachStageAccess, verifyOutreachContactAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { enrichContact, getConfiguredProviders } from '../services/outreachEnrichment.js';
import { listCampaigns, addContactToCampaign, checkForNewReplies } from '../services/replyIoService.js';
import { recordOutreachReply } from '../services/outreachReplyRecorder.js';

// Outreach: manual pipeline-tracking board. Org-gated to Cicero Capital only
// — see requireCiceroCapital in middleware/orgScope.ts, applied at the
// app.ts/app-lite.ts mount, not here (this router assumes the caller has
// already been authorized for the org).

const router = Router();

const outreachChannels = ['proprietary', 'broker'] as const;

const createContactSchema = z.object({
  stageId: z.string().uuid('stageId must be a valid UUID'),
  name: z.string().min(1, 'Name is required').max(200),
  company: z.string().max(200).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(30).optional().or(z.literal('')),
  channel: z.enum(outreachChannels).optional(),
  notes: z.string().max(5000).optional().or(z.literal('')),
});

const sendContactSchema = z.object({
  campaignId: z.string().min(1, 'campaignId is required'),
});

const updateContactSchema = z.object({
  stageId: z.string().uuid('stageId must be a valid UUID').optional(),
  name: z.string().min(1, 'Name is required').max(200).optional(),
  company: z.string().max(200).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(30).optional().or(z.literal('')),
  channel: z.enum(outreachChannels).optional(),
  notes: z.string().max(5000).optional().or(z.literal('')),
});

// ─── GET /stages — List outreach stages, ordered by position ────

router.get('/stages', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const { data: stages, error } = await supabase
      .from('OutreachStage')
      .select('*')
      .eq('organizationId', orgId)
      .order('position', { ascending: true });

    if (error) throw error;

    res.json({ stages: stages || [] });
  } catch (error) {
    log.error('List outreach stages error', error);
    res.status(500).json({ error: 'Failed to list outreach stages' });
  }
});

// ─── GET /contacts — List outreach contacts ──────────────────────

router.get('/contacts', async (req: Request, res) => {
  try {
    const orgId = getOrgId(req);

    const { data: contacts, error } = await supabase
      .from('OutreachContact')
      .select('*')
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });

    if (error) throw error;

    res.json({ contacts: contacts || [] });
  } catch (error) {
    log.error('List outreach contacts error', error);
    res.status(500).json({ error: 'Failed to list outreach contacts' });
  }
});

// ─── POST /contacts — Create outreach contact ────────────────────

router.post('/contacts', async (req: Request, res) => {
  try {
    const validation = createContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const data = validation.data;
    const orgId = getOrgId(req);

    // Never trust a client-supplied stageId without verifying it belongs to
    // the caller's org first — a guessed/foreign stageId would otherwise let
    // a contact be filed under another org's stage.
    const stage = await verifyOutreachStageAccess(data.stageId, orgId);
    if (!stage) {
      return res.status(400).json({ error: 'Invalid stageId' });
    }

    // organizationId and createdBy come from the authenticated request only
    // — never trust these from the request body.
    const { data: contact, error } = await supabase
      .from('OutreachContact')
      .insert({
        organizationId: orgId,
        stageId: data.stageId,
        name: data.name,
        company: data.company || null,
        email: data.email || null,
        phone: data.phone || null,
        channel: data.channel || 'proprietary',
        notes: data.notes || null,
        createdBy: req.user?.id || null,
      })
      .select()
      .single();

    if (error) {
      log.error('Supabase insert error', { code: error.code, message: error.message, details: error.details, hint: error.hint });
      return res.status(500).json({ error: 'Failed to create outreach contact', details: error.message });
    }

    log.info('Outreach contact created', { contactId: contact.id, orgId });

    res.status(201).json(contact);
  } catch (error: any) {
    log.error('Create outreach contact error', error);
    res.status(500).json({ error: 'Failed to create outreach contact', details: error?.message });
  }
});

// ─── PATCH /contacts/:id — Update outreach contact ───────────────

router.patch('/contacts/:id', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const validation = updateContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const data = validation.data;
    const orgId = getOrgId(req);

    const existing = await verifyOutreachContactAccess(id, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    // If the contact is being moved to a new stage, that stage must also
    // belong to the caller's org.
    if (data.stageId !== undefined) {
      const stage = await verifyOutreachStageAccess(data.stageId, orgId);
      if (!stage) {
        return res.status(400).json({ error: 'Invalid stageId' });
      }
    }

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (data.stageId !== undefined) updates.stageId = data.stageId;
    if (data.name !== undefined) updates.name = data.name;
    if (data.company !== undefined) updates.company = data.company || null;
    if (data.email !== undefined) updates.email = data.email || null;
    if (data.phone !== undefined) updates.phone = data.phone || null;
    if (data.channel !== undefined) updates.channel = data.channel;
    if (data.notes !== undefined) updates.notes = data.notes || null;

    const { data: contact, error } = await supabase
      .from('OutreachContact')
      .update(updates)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (error) throw error;
    if (!contact) return res.status(404).json({ error: 'Outreach contact not found' });

    log.info('Outreach contact updated', { contactId: id });

    res.json(contact);
  } catch (error) {
    log.error('Update outreach contact error', error);
    res.status(500).json({ error: 'Failed to update outreach contact' });
  }
});

// ─── DELETE /contacts/:id — Delete outreach contact ──────────────

router.delete('/contacts/:id', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const existing = await verifyOutreachContactAccess(id, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    const { error } = await supabase
      .from('OutreachContact')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    log.info('Outreach contact deleted', { contactId: id });

    res.status(204).send();
  } catch (error) {
    log.error('Delete outreach contact error', error);
    res.status(500).json({ error: 'Failed to delete outreach contact' });
  }
});

// ─── POST /contacts/:id/enrich — Enrich outreach contact via Apollo/Anymail Finder/Clay ────
//
// See services/outreachEnrichment.ts for the provider integrations and the
// merge rule. No provider keys are configured yet (Clay/Apollo/Anymail
// Finder are all "coming later" per the org's rollout plan) — that's an
// expected, normal state right now, not an error, so it's a 200 with
// enriched:false rather than a 4xx/5xx.

router.post('/contacts/:id/enrich', async (req: Request, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const existing = await verifyOutreachContactAccess(id, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    const configuredProviders = getConfiguredProviders();
    if (configuredProviders.length === 0) {
      return res.status(200).json({ enriched: false, reason: 'No enrichment providers configured yet' });
    }

    // verifyOutreachContactAccess only selects id/organizationId/stageId
    // (just enough to authorize) — fetch the full row now that we know the
    // caller owns it, both as enrichContact's input and so the merge below
    // can tell which fields are already human-filled.
    const { data: contact, error: fetchError } = await supabase
      .from('OutreachContact')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: 'Outreach contact not found' });
    }

    const result = await enrichContact({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      linkedinUrl: contact.linkedinUrl,
    });

    // enrichmentData/enrichmentSource/enrichedAt always update — they record
    // the attempt itself, including a run that found nothing new. Every
    // other field only fills in when currently null/empty, so enrichment
    // never clobbers a human-edited name/notes/etc.
    // enrichmentSource accumulates across runs (union, not overwrite) so a
    // provider that contributed data on an earlier run isn't forgotten just
    // because it's unconfigured or found nothing on this one.
    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      enrichedAt: new Date().toISOString(),
      enrichmentData: { ...(contact.enrichmentData || {}), ...result.enrichmentData },
      enrichmentSource: Array.from(new Set([...(contact.enrichmentSource || []), ...result.sourcesUsed])),
    };

    if (result.updates.email && !contact.email) updates.email = result.updates.email;
    if (result.updates.phone && !contact.phone) updates.phone = result.updates.phone;
    if (result.updates.title && !contact.title) updates.title = result.updates.title;
    if (result.updates.linkedinUrl && !contact.linkedinUrl) updates.linkedinUrl = result.updates.linkedinUrl;
    if (result.updates.company && !contact.company) updates.company = result.updates.company;

    const { data: updated, error: updateError } = await supabase
      .from('OutreachContact')
      .update(updates)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (updateError) throw updateError;
    if (!updated) return res.status(404).json({ error: 'Outreach contact not found' });

    log.info('Outreach contact enriched', { contactId: id, providersConfigured: configuredProviders, sourcesUsed: result.sourcesUsed });

    res.json(updated);
  } catch (error) {
    log.error('Enrich outreach contact error', error);
    res.status(500).json({ error: 'Failed to enrich outreach contact' });
  }
});

// ─── GET /campaigns — List Reply.io campaigns for the Send picker ───
//
// See services/replyIoService.ts for the researched API version + auth
// details. No REPLY_IO_API_KEY configured is an expected, normal state
// (same as the enrich providers above) — 200 with configured:false, not an
// error. A configured key that fails the live call (bad key, Reply.io
// outage, etc.) is a real error worth a non-200 so the UI can surface it.

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
// replyIoCampaignId + sentAt on the OutreachContact row. Reply tracking
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
