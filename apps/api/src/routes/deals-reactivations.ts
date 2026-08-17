// ─── Deal reactivations ───────────────────────────────────────────
// The "worth revisiting" feed and its controls:
//   GET   /api/deals/reactivations             — org-wide feed
//   POST  /api/deals/:dealId/rescore           — manual re-score
//   PATCH /api/deals/:dealId/reactivations/:id — seen / acted / dismissed
//
// MOUNT ORDER: the literal /reactivations path must be registered before
// the generic dealsRouter, whose /:id catch-all would otherwise read
// "reactivations" as a deal id.
//
// Backed by DealReactivation — see apps/api/deal-reactivation-migration.sql
// (applied MANUALLY per the repo's Supabase-migrations convention).

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { rescorePassedDeal } from '../services/agents/dealReactivation/index.js';

const router = Router();

const FEED_LIMIT = 50;

const patchSchema = z.object({
  status: z.enum(['SEEN', 'ACTED', 'DISMISSED']),
});

// GET /api/deals/reactivations — deals that became interesting again
router.get('/reactivations', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const requested = typeof req.query.status === 'string' ? req.query.status : 'NEW';

    let query = supabase
      .from('DealReactivation')
      .select('id, dealId, trigger, previousScore, newScore, previousVerdict, newVerdict, delta, status, createdAt, seenAt')
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false })
      .limit(FEED_LIMIT);

    if (requested !== 'all') query = query.eq('status', requested);

    const { data: rows, error } = await query;
    if (error) throw error;

    // Join deal labels in one query rather than per row.
    const dealIds = [...new Set((rows ?? []).map((r) => r.dealId))];
    const dealsById = new Map<string, { name: string; companyName: string | null; stage: string }>();
    if (dealIds.length > 0) {
      const { data: deals } = await supabase
        .from('Deal')
        .select('id, name, companyName, stage, passReason, revisitAt')
        .eq('organizationId', orgId)
        .in('id', dealIds);
      for (const d of deals ?? []) {
        dealsById.set(d.id, { name: d.name, companyName: d.companyName, stage: d.stage });
      }
    }

    res.json({
      appliedStatus: requested,
      reactivations: (rows ?? []).map((r) => ({
        ...r,
        dealName: dealsById.get(r.dealId)?.name ?? null,
        companyName: dealsById.get(r.dealId)?.companyName ?? null,
        dealStage: dealsById.get(r.dealId)?.stage ?? null,
      })),
    });
  } catch (error: any) {
    log.error('List reactivations failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load reactivations' });
  }
});

// POST /api/deals/:dealId/rescore — manual re-score
//
// Bypasses the automatic eligibility gate on purpose: the user asked, so
// the cooldown and change-detection rules don't apply.
router.post('/:dealId/rescore', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const outcome = await rescorePassedDeal(dealId, orgId, 'MANUAL');
    res.json(outcome);
  } catch (error: any) {
    log.error('Manual re-score failed', { error: error.message });
    res.status(500).json({ error: 'Failed to re-score this deal' });
  }
});

// PATCH /api/deals/:dealId/reactivations/:id — triage an alert
router.patch('/:dealId/reactivations/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid status', details: parsed.error.flatten() });
  }
  try {
    const { dealId, id } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const patch: Record<string, unknown> = { status: parsed.data.status };
    if (parsed.data.status === 'SEEN') patch.seenAt = new Date().toISOString();

    const { error } = await supabase
      .from('DealReactivation')
      .update(patch)
      .eq('id', id)
      .eq('dealId', dealId)
      .eq('organizationId', orgId);
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    log.error('Patch reactivation failed', { error: error.message });
    res.status(500).json({ error: 'Failed to update this alert' });
  }
});

export default router;
