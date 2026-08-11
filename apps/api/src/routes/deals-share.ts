// ─── Deal sharing (owner side) ────────────────────────────────────
// POST/GET/DELETE /api/deals/:dealId/shares — create, list, and revoke
// tokenized external share links for a deal (client portal).
// Public consumption of the links lives in routes/portal.ts.
//
// Backed by DealShare/DealShareView (see apps/api/deal-share-migration.sql —
// applied MANUALLY per the repo's Supabase-migrations convention).

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Resend } from 'resend';
import { supabase } from '../supabase.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const router = Router();

const createShareSchema = z.object({
  label: z.string().max(200).optional(),
  invitedEmail: z.string().email().optional(),
  includeFinancials: z.boolean().default(true),
  includeDocuments: z.boolean().default(true),
  includeMemos: z.boolean().default(true),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

function portalBaseUrl(): string {
  return process.env.APP_URL || 'http://localhost:3002';
}

// POST /api/deals/:dealId/shares — create a share link
router.post('/:dealId/shares', async (req, res) => {
  const parsed = createShareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  }
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { label, invitedEmail, includeFinancials, includeDocuments, includeMemos, expiresInDays } = parsed.data;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : null;

    const { data: share, error } = await supabase
      .from('DealShare')
      .insert({
        dealId,
        organizationId: orgId,
        token,
        label: label ?? null,
        invitedEmail: invitedEmail ?? null,
        includeFinancials,
        includeDocuments,
        includeMemos,
        createdBy: (req as any).user?.id ?? null,
        expiresAt,
      })
      .select()
      .single();
    if (error) throw error;

    const url = `${portalBaseUrl()}/portal/${token}`;

    // Activity log on the deal (best-effort)
    await supabase.from('Activity').insert({
      dealId,
      type: 'NOTE_ADDED',
      title: 'Deal shared externally',
      description: `Share link created${label ? ` for "${label}"` : ''}${invitedEmail ? ` (${invitedEmail})` : ''}`,
      metadata: { shareId: share.id },
    });

    // Optional email delivery — same null-safe Resend pattern as invitations.
    if (invitedEmail && resend) {
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      resend.emails
        .send({
          from: fromEmail,
          to: invitedEmail,
          subject: `A deal has been shared with you`,
          html: `<p>You've been given access to view a deal${label ? ` (${label})` : ''}.</p><p><a href="${url}">Open the deal</a></p><p>This link is private — don't forward it.</p>`,
        })
        .catch((err: unknown) => log.error('deal share email failed', { err }));
    }

    res.status(201).json({ share, url });
  } catch (error: any) {
    log.error('Create deal share failed', { error: error.message });
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// GET /api/deals/:dealId/shares — list shares with view stats
router.get('/:dealId/shares', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { data: shares, error } = await supabase
      .from('DealShare')
      .select('id, label, invitedEmail, token, includeFinancials, includeDocuments, includeMemos, createdAt, expiresAt, revokedAt')
      .eq('dealId', dealId)
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });
    if (error) throw error;

    const shareIds = (shares ?? []).map((s) => s.id);
    let viewsByShare = new Map<string, { count: number; last: string | null }>();
    if (shareIds.length > 0) {
      const { data: views } = await supabase
        .from('DealShareView')
        .select('shareId, viewedAt')
        .in('shareId', shareIds);
      for (const v of views ?? []) {
        const entry = viewsByShare.get(v.shareId) ?? { count: 0, last: null };
        entry.count += 1;
        if (!entry.last || v.viewedAt > entry.last) entry.last = v.viewedAt;
        viewsByShare.set(v.shareId, entry);
      }
    }

    res.json({
      shares: (shares ?? []).map((s) => ({
        ...s,
        url: `${portalBaseUrl()}/portal/${s.token}`,
        viewCount: viewsByShare.get(s.id)?.count ?? 0,
        lastViewedAt: viewsByShare.get(s.id)?.last ?? null,
      })),
    });
  } catch (error: any) {
    log.error('List deal shares failed', { error: error.message });
    res.status(500).json({ error: 'Failed to list shares' });
  }
});

// DELETE /api/deals/:dealId/shares/:shareId — soft-revoke
router.delete('/:dealId/shares/:shareId', async (req, res) => {
  try {
    const { dealId, shareId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { error } = await supabase
      .from('DealShare')
      .update({ revokedAt: new Date().toISOString() })
      .eq('id', shareId)
      .eq('dealId', dealId)
      .eq('organizationId', orgId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    log.error('Revoke deal share failed', { error: error.message });
    res.status(500).json({ error: 'Failed to revoke share' });
  }
});

export default router;
