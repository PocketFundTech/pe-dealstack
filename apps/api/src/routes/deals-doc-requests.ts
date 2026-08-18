// ─── Document requests (owner side) ───────────────────────────────
// POST/GET/PATCH/DELETE /api/deals/:dealId/doc-requests — create, list,
// edit, remind and revoke structured document asks sent to brokers and
// sellers. The public fulfilment side lives in routes/doc-request-portal.ts.
//
// Backed by DocRequest/DocRequestItem/DocRequestEvent (see
// apps/api/doc-request-migration.sql — applied MANUALLY per the repo's
// Supabase-migrations convention).
//
// Shape deliberately mirrors deals-share.ts: same crypto token, same
// soft-revoke, same null-safe email. If you change one, look at the other.

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { supabase } from '../supabase.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import {
  expandTemplate,
  isTemplateKey,
  DOC_REQUEST_TEMPLATE_KEYS,
} from '../services/docRequestTemplates.js';
import { sendDocRequestEmail } from '../services/docRequestEmail.js';
import { computeRequestStatus } from '../services/docRequests.js';

const router = Router();

/** Manual reminders are rate-limited harder than the nightly sweep. */
const MANUAL_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const itemInputSchema = z.object({
  label: z.string().min(1).max(300),
  docType: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
  required: z.boolean().default(true),
});

const createSchema = z.object({
  templateKey: z.string().max(60).optional(),
  items: z.array(itemInputSchema).max(60).optional(),
  recipientEmail: z.string().email().optional(),
  recipientName: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

const patchSchema = z.object({
  message: z.string().max(2000).optional(),
  items: z.array(itemInputSchema).min(1).max(60).optional(),
});

function uploadBaseUrl(): string {
  return process.env.APP_URL || 'http://localhost:3002';
}

function uploadUrl(token: string): string {
  return `${uploadBaseUrl()}/upload/${token}`;
}

/** Resolve the checklist for a create call — template, explicit list, or 400. */
function resolveChecklist(
  input: z.infer<typeof createSchema>,
): { ok: true; items: Array<{ label: string; docType?: string; notes?: string; required: boolean; sortOrder: number }> }
  | { ok: false; error: string } {
  if (input.items && input.items.length > 0) {
    return {
      ok: true,
      items: input.items.map((item, index) => ({ ...item, sortOrder: index })),
    };
  }
  if (input.templateKey) {
    if (!isTemplateKey(input.templateKey)) {
      return { ok: false, error: `Unknown template. Expected one of: ${DOC_REQUEST_TEMPLATE_KEYS.join(', ')}` };
    }
    return { ok: true, items: expandTemplate(input.templateKey) };
  }
  return { ok: false, error: 'Provide either a templateKey or a non-empty items list.' };
}

async function loadOrgName(orgId: string): Promise<string | null> {
  const { data } = await supabase.from('Organization').select('name').eq('id', orgId).single();
  return data?.name ?? null;
}

// GET /api/deals/:dealId/doc-requests/templates — the checklist packages
//
// Served rather than duplicated in the frontend so there is one source of
// truth for what a "Standard DD package" contains. The modal expands a
// template here, lets the user edit it, then posts explicit items.
// Mounted BEFORE the /:id routes so 'templates' isn't read as a request id.
router.get('/:dealId/doc-requests/templates', (_req, res) => {
  res.json({
    templates: Object.fromEntries(
      DOC_REQUEST_TEMPLATE_KEYS.map((key) => [key, expandTemplate(key)]),
    ),
  });
});

// POST /api/deals/:dealId/doc-requests — create a request
router.post('/:dealId/doc-requests', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }

  const checklist = resolveChecklist(parsed.data);
  if (!checklist.ok) return res.status(400).json({ error: checklist.error });

  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { recipientEmail, recipientName, message, expiresInDays } = parsed.data;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : null;

    const { data: docRequest, error } = await supabase
      .from('DocRequest')
      .insert({
        dealId,
        organizationId: orgId,
        token,
        recipientEmail: recipientEmail ?? null,
        recipientName: recipientName ?? null,
        message: message ?? null,
        status: 'OPEN',
        createdBy: (req as any).user?.id ?? null,
        expiresAt,
      })
      .select()
      .single();
    if (error) throw error;

    const { data: items, error: itemsError } = await supabase
      .from('DocRequestItem')
      .insert(checklist.items.map((item) => ({
        requestId: docRequest.id,
        label: item.label,
        docType: item.docType ?? null,
        notes: item.notes ?? null,
        required: item.required,
        sortOrder: item.sortOrder,
      })))
      .select();
    if (itemsError) throw itemsError;

    const url = uploadUrl(token);

    // Activity log on the deal (best-effort — mirrors deals-share.ts)
    await supabase.from('Activity').insert({
      dealId,
      type: 'NOTE_ADDED',
      title: 'Documents requested',
      description: `${checklist.items.length} document${checklist.items.length === 1 ? '' : 's'} requested${recipientEmail ? ` from ${recipientEmail}` : ''}`,
      metadata: { docRequestId: docRequest.id },
    });

    let emailed = false;
    if (recipientEmail) {
      emailed = await sendDocRequestEmail({
        to: recipientEmail,
        recipientName,
        dealName: (deal as any).name ?? 'a deal',
        firmName: await loadOrgName(orgId),
        message,
        url,
        items: checklist.items.map((i) => ({ label: i.label, required: i.required })),
      });
    }

    res.status(201).json({ request: docRequest, items: items ?? [], url, emailed });
  } catch (error: any) {
    log.error('Create doc request failed', { error: error.message });
    res.status(500).json({ error: 'Failed to create document request' });
  }
});

// GET /api/deals/:dealId/doc-requests — list with items + progress
router.get('/:dealId/doc-requests', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { data: requests, error } = await supabase
      .from('DocRequest')
      .select('id, token, recipientEmail, recipientName, message, status, createdAt, expiresAt, revokedAt, lastRemindedAt, reminderCount, completedAt')
      .eq('dealId', dealId)
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });
    if (error) throw error;

    const requestIds = (requests ?? []).map((r) => r.id);
    let itemsByRequest = new Map<string, any[]>();
    let viewsByRequest = new Map<string, number>();

    if (requestIds.length > 0) {
      const { data: items } = await supabase
        .from('DocRequestItem')
        .select('id, requestId, label, docType, notes, required, sortOrder, documentId, fulfilledAt')
        .in('requestId', requestIds)
        .order('sortOrder', { ascending: true });
      for (const item of items ?? []) {
        const list = itemsByRequest.get(item.requestId) ?? [];
        list.push(item);
        itemsByRequest.set(item.requestId, list);
      }

      const { data: events } = await supabase
        .from('DocRequestEvent')
        .select('requestId, kind')
        .in('requestId', requestIds);
      for (const event of events ?? []) {
        if (event.kind !== 'VIEWED') continue;
        viewsByRequest.set(event.requestId, (viewsByRequest.get(event.requestId) ?? 0) + 1);
      }
    }

    res.json({
      requests: (requests ?? []).map((r) => {
        const items = itemsByRequest.get(r.id) ?? [];
        return {
          ...r,
          url: uploadUrl(r.token),
          items,
          receivedCount: items.filter((i) => i.fulfilledAt).length,
          totalCount: items.length,
          viewCount: viewsByRequest.get(r.id) ?? 0,
        };
      }),
    });
  } catch (error: any) {
    log.error('List doc requests failed', { error: error.message });
    res.status(500).json({ error: 'Failed to list document requests' });
  }
});

// PATCH /api/deals/:dealId/doc-requests/:id — edit message / checklist
router.patch('/:dealId/doc-requests/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }
  try {
    const { dealId, id } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    if (parsed.data.message !== undefined) {
      const { error } = await supabase
        .from('DocRequest')
        .update({ message: parsed.data.message })
        .eq('id', id)
        .eq('dealId', dealId)
        .eq('organizationId', orgId);
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (error: any) {
    log.error('Patch doc request failed', { error: error.message });
    res.status(500).json({ error: 'Failed to update document request' });
  }
});

// POST /api/deals/:dealId/doc-requests/:id/remind — manual nudge
router.post('/:dealId/doc-requests/:id/remind', async (req, res) => {
  try {
    const { dealId, id } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { data: docRequest, error } = await supabase
      .from('DocRequest')
      .select('id, token, recipientEmail, recipientName, message, status, createdAt, expiresAt, revokedAt, lastRemindedAt, reminderCount')
      .eq('id', id)
      .eq('dealId', dealId)
      .eq('organizationId', orgId)
      .single();
    if (error || !docRequest) return res.status(404).json({ error: 'Request not found' });

    if (!docRequest.recipientEmail) {
      return res.status(400).json({ error: 'This request has no recipient email — share the link directly.' });
    }
    if (docRequest.revokedAt || docRequest.status === 'CANCELLED') {
      return res.status(410).json({ error: 'This request has been revoked.' });
    }
    if (
      docRequest.lastRemindedAt &&
      Date.now() - new Date(docRequest.lastRemindedAt).getTime() < MANUAL_REMINDER_COOLDOWN_MS
    ) {
      return res.status(429).json({ error: 'Already reminded in the last 24 hours.' });
    }

    const { data: items } = await supabase
      .from('DocRequestItem')
      .select('label, required, fulfilledAt')
      .eq('requestId', id)
      .order('sortOrder', { ascending: true });

    const emailed = await sendDocRequestEmail({
      to: docRequest.recipientEmail,
      recipientName: docRequest.recipientName,
      dealName: (deal as any).name ?? 'a deal',
      firmName: await loadOrgName(orgId),
      message: docRequest.message,
      url: uploadUrl(docRequest.token),
      items: items ?? [],
      isReminder: true,
    });

    const { error: updateError } = await supabase
      .from('DocRequest')
      .update({
        lastRemindedAt: new Date().toISOString(),
        reminderCount: (docRequest.reminderCount ?? 0) + 1,
      })
      .eq('id', id)
      .eq('dealId', dealId)
      .eq('organizationId', orgId);
    if (updateError) throw updateError;

    res.json({ success: true, emailed });
  } catch (error: any) {
    log.error('Remind doc request failed', { error: error.message });
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// DELETE /api/deals/:dealId/doc-requests/:id — soft revoke
router.delete('/:dealId/doc-requests/:id', async (req, res) => {
  try {
    const { dealId, id } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { error } = await supabase
      .from('DocRequest')
      .update({ revokedAt: new Date().toISOString(), status: 'CANCELLED' })
      .eq('id', id)
      .eq('dealId', dealId)
      .eq('organizationId', orgId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    log.error('Revoke doc request failed', { error: error.message });
    res.status(500).json({ error: 'Failed to revoke document request' });
  }
});

export { computeRequestStatus };
export default router;
