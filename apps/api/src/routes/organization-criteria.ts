// ─── Organization deal criteria (dealCriteria settings) ───────────
// GET/PUT /api/organizations/criteria — the firm's investment criteria
// used by the deal scorecard. Stored in Organization.settings.dealCriteria
// (same JSON pattern as settings.firmProfile — no migration).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { sweepPassedDeals } from '../services/agents/dealReactivation/index.js';

const router = Router();

export const dealCriteriaSchema = z.object({
  sectorsInclude: z.array(z.string()).max(30).default([]),
  sectorsExclude: z.array(z.string()).max(30).default([]),
  dealSizeMin: z.number().nullable().default(null),
  dealSizeMax: z.number().nullable().default(null),
  revenueMin: z.number().nullable().default(null),
  revenueMax: z.number().nullable().default(null),
  ebitdaMin: z.number().nullable().default(null),
  hardExclusions: z.array(z.string()).max(30).default([]),
  thesis: z.string().max(2000).default(''),
});

export type DealCriteria = z.infer<typeof dealCriteriaSchema>;

async function loadSettings(orgId: string): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  return (data?.settings || {}) as Record<string, any>;
}

// GET /api/organizations/criteria
router.get('/criteria', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);

    if (settings.dealCriteria) {
      return res.json({ criteria: settings.dealCriteria, seededFromFirmProfile: false });
    }

    // Read-time seeding from the research agent's firmProfile — nothing persisted.
    const firmProfile = settings.firmProfile as { sectors?: string[] } | undefined;
    if (firmProfile?.sectors?.length) {
      const seeded = dealCriteriaSchema.parse({ sectorsInclude: firmProfile.sectors });
      return res.json({ criteria: seeded, seededFromFirmProfile: true });
    }

    res.json({ criteria: null, seededFromFirmProfile: false });
  } catch (error: any) {
    log.error('criteria GET failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load criteria' });
  }
});

// PATCH /api/organizations/criteria
router.patch('/criteria', async (req: Request, res: Response) => {
  const parsed = dealCriteriaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid criteria', details: parsed.error.flatten() });
  }
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);

    // updatedAt is the signal the reactivation eligibility gate reads to
    // answer "have the rules changed since we last scored this deal?".
    // Without it, a firm could rewrite its thesis and every dormant deal
    // would keep its stale verdict forever.
    const dealCriteria = { ...parsed.data, updatedAt: new Date().toISOString() };

    const updatedSettings = { ...settings, dealCriteria };
    const { error } = await supabase
      .from('Organization')
      .update({ settings: updatedSettings })
      .eq('id', orgId);
    if (error) throw error;

    // Changing the thesis is exactly when a passed deal can become live
    // again. Fire-and-forget: a firm with hundreds of dormant deals must
    // still get an instant save, and a scoring outage must not fail it.
    void sweepPassedDeals(orgId, 'CRITERIA_CHANGED').catch((err) =>
      log.warn('criteria-change reactivation sweep failed', {
        orgId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    res.json({ success: true, criteria: dealCriteria });
  } catch (error: any) {
    log.error('criteria PUT failed', { error: error.message });
    res.status(500).json({ error: 'Failed to save criteria' });
  }
});

export default router;
