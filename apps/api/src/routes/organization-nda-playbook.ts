// ─── Organization NDA playbook ────────────────────────────────────
// GET/PATCH /api/organizations/nda-playbook — the firm's standing position
// on each NDA clause, used by the NDA review agent.
//
// Stored in Organization.settings.ndaPlaybook (same JSON-settings pattern
// as settings.dealCriteria in organization-criteria.ts — no migration).
//
// GET seeds from DEFAULT_NDA_PLAYBOOK at read time without persisting, so
// the review feature works before a firm has configured anything and the
// user sees exactly what will be applied.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import {
  ndaPlaybookSchema,
  DEFAULT_NDA_PLAYBOOK,
} from '../services/ndaPlaybookDefaults.js';

const router = Router();

async function loadSettings(orgId: string): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  return (data?.settings || {}) as Record<string, any>;
}

// GET /api/organizations/nda-playbook
router.get('/nda-playbook', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);

    if (settings.ndaPlaybook) {
      const parsed = ndaPlaybookSchema.safeParse(settings.ndaPlaybook);
      if (parsed.success && parsed.data.positions.length > 0) {
        return res.json({ playbook: parsed.data, isDefault: false });
      }
      log.warn('Stored NDA playbook invalid — serving defaults', { orgId });
    }

    res.json({ playbook: DEFAULT_NDA_PLAYBOOK, isDefault: true });
  } catch (error: any) {
    log.error('NDA playbook GET failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load the NDA playbook' });
  }
});

// PATCH /api/organizations/nda-playbook
router.patch('/nda-playbook', async (req: Request, res: Response) => {
  const parsed = ndaPlaybookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid playbook', details: parsed.error.flatten() });
  }
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);
    const playbook = { ...parsed.data, updatedAt: new Date().toISOString() };

    const { error } = await supabase
      .from('Organization')
      .update({ settings: { ...settings, ndaPlaybook: playbook } })
      .eq('id', orgId);
    if (error) throw error;

    res.json({ success: true, playbook });
  } catch (error: any) {
    log.error('NDA playbook PATCH failed', { error: error.message });
    res.status(500).json({ error: 'Failed to save the NDA playbook' });
  }
});

export default router;
