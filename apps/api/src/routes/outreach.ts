import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyOutreachStageAccess, verifyOutreachContactAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { enrichContact, getConfiguredProviders, resolveAutoAdvanceStage } from '../services/outreachEnrichment.js';
import { recordTouch } from '../services/outreachTouchLog.js';

// Outreach: manual pipeline-tracking board. Org-gated to Cicero Capital only
// — see requireCiceroCapital in middleware/orgScope.ts, applied at the
// app.ts/app-lite.ts mount, not here (this router assumes the caller has
// already been authorized for the org).
//
// Reply.io send/campaigns/sync-replies routes live in
// routes/outreach-replyio.ts (split out to stay under this repo's 500-line
// file convention — see AGENTS.md), mounted alongside this router at the
// same '/api/outreach' base.

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

    // See resolveAutoAdvanceStage's own comment (outreachEnrichment.ts) —
    // only advances a contact off the org's first stage, only when this run
    // actually found something.
    const autoAdvanceStageId = await resolveAutoAdvanceStage(orgId, contact.stageId, result.sourcesUsed);
    if (autoAdvanceStageId) updates.stageId = autoAdvanceStageId;

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

    await recordTouch({
      organizationId: orgId,
      contactId: id,
      channel: 'enrichment',
      type: 'enriched',
      direction: 'outbound',
      metadata: {
        providersConfigured: configuredProviders,
        sourcesUsed: result.sourcesUsed,
        autoAdvancedToStageId: autoAdvanceStageId,
      },
    });

    res.json(updated);
  } catch (error) {
    log.error('Enrich outreach contact error', error);
    res.status(500).json({ error: 'Failed to enrich outreach contact' });
  }
});

export default router;
