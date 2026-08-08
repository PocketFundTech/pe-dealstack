// ─── Organization deal criteria (dealCriteria settings) ───────────
// GET/PUT /api/organizations/criteria — the firm's investment criteria
// used by the deal scorecard. Stored in Organization.settings.dealCriteria
// (same JSON pattern as settings.firmProfile — no migration).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

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
    const updatedSettings = { ...settings, dealCriteria: parsed.data };
    const { error } = await supabase
      .from('Organization')
      .update({ settings: updatedSettings })
      .eq('id', orgId);
    if (error) throw error;
    res.json({ success: true, criteria: parsed.data });
  } catch (error: any) {
    log.error('criteria PUT failed', { error: error.message });
    res.status(500).json({ error: 'Failed to save criteria' });
  }
});

export default router;
