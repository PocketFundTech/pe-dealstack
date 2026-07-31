// ─── AI Agent Routes ────────────────────────────────────────────────
// Endpoints for Contact Enrichment, Meeting Prep, Signal Monitor,
// and Smart Email Drafting agents.

import { Router } from 'express';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { classifyAIError, classifyAIErrorObject } from '../utils/aiErrors.js';
import { getOrgId, verifyDealAccess, verifyContactAccess } from '../middleware/orgScope.js';
import { supabase } from '../supabase.js';

// Agent imports
import { runContactEnrichment } from '../services/agents/contactEnrichment/index.js';
import { suggestContactFollowUp } from '../services/contactFollowUpSuggester.js';
import { generateMeetingPrep } from '../services/agents/meetingPrep/index.js';
import { runSignalMonitor } from '../services/agents/signalMonitor/index.js';
import { generateEmailDraft, getEmailTemplates } from '../services/agents/emailDrafter/index.js';
import { scanInboxForDeals } from '../services/inboxDealScanService.js';

const router = Router();

// ─── Contact Enrichment ───────────────────────────────────────────

const enrichContactSchema = z.object({
  contactId: z.string().uuid(),
});

// POST /api/ai/enrich-contact - Enrich a contact with AI
router.post('/ai/enrich-contact', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { contactId } = enrichContactSchema.parse(req.body);

    // Fetch contact
    const { data: contact, error } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, email, company, title')
      .eq('id', contactId)
      .eq('organizationId', orgId)
      .single();

    if (error || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    log.info('Enriching contact', { contactId, name: `${contact.firstName} ${contact.lastName}` });

    const result = await runContactEnrichment({
      contactId: contact.id,
      organizationId: orgId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      company: contact.company,
      title: contact.title,
    });

    res.json(result);
  } catch (error: any) {
    log.error('Contact enrichment error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// ─── Suggest Follow-up (lightweight — single LLM call) ────────────
// Replaces the misuse of the full enrichment agent for follow-up timing.
// Reads the contact's recent interactions and returns a model-decided
// follow-up date + action. SUGGESTION ONLY — never writes followUpAt.

const suggestFollowUpSchema = z.object({
  contactId: z.string().uuid(),
});

// POST /api/ai/suggest-follow-up - Suggest a follow-up date + action
router.post('/ai/suggest-follow-up', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { contactId } = suggestFollowUpSchema.parse(req.body);

    // Fetch + org-scope the contact.
    const { data: contact, error } = await supabase
      .from('Contact')
      .select('id, firstName, lastName, company, title, type, lastContactedAt')
      .eq('id', contactId)
      .eq('organizationId', orgId)
      .single();

    if (error || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Pull recent interactions for this contact (cheap, bounded).
    const { data: interactions } = await supabase
      .from('ContactInteraction')
      .select('type, title, date')
      .eq('contactId', contactId)
      .order('date', { ascending: false })
      .limit(12);

    const fullName = `${contact.firstName} ${contact.lastName}`.trim();
    log.info('Suggesting contact follow-up', { contactId, name: fullName });

    const suggestion = await suggestContactFollowUp({
      fullName,
      type: contact.type,
      company: contact.company,
      title: contact.title,
      lastContactedAt: contact.lastContactedAt,
      interactions: (interactions || []).map((i: any) => ({
        type: i.type,
        title: i.title,
        date: i.date,
      })),
    });

    res.json(suggestion);
  } catch (error: any) {
    log.error('Suggest follow-up error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// ─── Meeting Prep ─────────────────────────────────────────────────

const meetingPrepSchema = z.object({
  dealId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  meetingTopic: z.string().optional(),
  meetingDate: z.string().optional(),
});

// POST /api/ai/meeting-prep - Generate meeting prep brief
router.post('/ai/meeting-prep', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const input = meetingPrepSchema.parse(req.body);

    // Verify deal belongs to user's org
    const deal = await verifyDealAccess(input.dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Verify contact if provided
    if (input.contactId) {
      const contact = await verifyContactAccess(input.contactId, orgId);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
    }

    log.info('Generating meeting prep', { dealId: input.dealId });

    const brief = await generateMeetingPrep({
      dealId: input.dealId,
      contactId: input.contactId,
      organizationId: orgId,
      meetingTopic: input.meetingTopic,
      meetingDate: input.meetingDate,
    });

    res.json(brief);
  } catch (error: any) {
    log.error('Meeting prep error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// ─── Deal Signal Monitor ─────────────────────────────────────────

// POST /api/ai/scan-signals - Scan portfolio for deal signals
router.post('/ai/scan-signals', async (req, res) => {
  try {
    const orgId = getOrgId(req);

    log.info('Scanning deal signals', { orgId });

    const result = await runSignalMonitor(orgId);

    res.json(result);
  } catch (error: any) {
    log.error('Signal scan error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// ─── Inbox Deal Scan ──────────────────────────────────────────────

const scanInboxSchema = z.object({
  lookbackDays: z.number().int().min(1).max(60).optional(),
});

// POST /api/ai/scan-inbox - Read the user's Gmail and return deal CANDIDATES
// for review. Review-first: writes nothing to the DB.
router.post('/ai/scan-inbox', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const authUserId = req.user?.id;
    if (!authUserId) return res.status(401).json({ error: 'Not authenticated' });
    // A bad optional `lookbackDays` must NOT 400 the whole scan — fall back to default.
    const parsed = scanInboxSchema.safeParse(req.body ?? {});
    const lookbackDays = parsed.success ? parsed.data.lookbackDays : undefined;
    const result = await scanInboxForDeals({ orgId, authUserId, lookbackDays });
    res.json(result);
  } catch (error: any) {
    log.error('Inbox deal scan error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// POST /api/ai/scan-inbox/stream - Same scan, but streams NDJSON progress
// events (one JSON object per line) as each email is listed, scored, gated,
// extracted, and surfaced — so the dashboard can render a live terminal of
// exactly which mail is being picked up. The final line is a `{t:'result'}`
// event carrying the same payload the buffered endpoint returns.
router.post('/ai/scan-inbox/stream', async (req, res) => {
  const orgId = getOrgId(req);
  const authUserId = req.user?.id;
  if (!authUserId) return res.status(401).json({ error: 'Not authenticated' });
  const parsed = scanInboxSchema.safeParse(req.body ?? {});
  const lookbackDays = parsed.success ? parsed.data.lookbackDays : undefined;

  // NDJSON stream. `no-transform` + flushing after each line keeps the
  // (possible) compression/proxy layers from buffering the whole response.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj: unknown) => {
    res.write(JSON.stringify(obj) + '\n');
    // compression middleware monkey-patches res.flush; force each line out.
    (res as unknown as { flush?: () => void }).flush?.();
  };

  try {
    const result = await scanInboxForDeals({
      orgId,
      authUserId,
      lookbackDays,
      onEvent: (ev) => write(ev),
    });
    write({ t: 'result', result });
  } catch (error: any) {
    log.error('Inbox deal scan (stream) error', error);
    const { userMessage } = classifyAIErrorObject(error);
    write({ t: 'error', msg: userMessage });
  } finally {
    res.end();
  }
});

// ─── Smart Email Drafting ─────────────────────────────────────────

const emailDraftSchema = z.object({
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  purpose: z.string().min(5).max(500),
  context: z.string().optional(),
  templateId: z.string().optional(),
  tone: z.enum(['professional', 'friendly', 'formal', 'direct', 'warm']).optional(),
});

// GET /api/ai/email-templates - List available email templates
router.get('/ai/email-templates', (_req, res) => {
  res.json({ templates: getEmailTemplates() });
});

// POST /api/ai/draft-email - Generate a smart email draft
router.post('/ai/draft-email', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const input = emailDraftSchema.parse(req.body);

    // Verify deal belongs to user's org (if provided)
    if (input.dealId) {
      const deal = await verifyDealAccess(input.dealId, orgId);
      if (!deal) return res.status(404).json({ error: 'Deal not found' });
    }

    // Verify contact belongs to user's org (if provided)
    if (input.contactId) {
      const contact = await verifyContactAccess(input.contactId, orgId);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
    }

    log.info('Drafting email', { purpose: input.purpose, dealId: input.dealId });

    const result = await generateEmailDraft({
      organizationId: orgId,
      dealId: input.dealId || null,
      contactId: input.contactId || null,
      purpose: input.purpose,
      context: input.context,
      templateId: input.templateId || null,
      tone: input.tone,
    });

    res.json(result);
  } catch (error: any) {
    log.error('Email draft error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

export default router;
