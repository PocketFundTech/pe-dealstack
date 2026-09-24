import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import {
  getOutreachSettings,
  upsertOutreachSettings,
  resetOutreachSettings,
} from '../services/outreachSettingsService.js';

// ─── GET/PATCH /outreach/settings, POST /outreach/settings/reset ──────
//
// Org-scoped pipeline configuration: the stale-contact threshold and
// which auto-advance rules are on. See outreachSettingsService.ts for the
// lazy-create-with-defaults behavior and cicero-outreach-settings-migration.sql
// for the table. Mounted in the same requireCiceroCapital-gated router
// chain as the rest of outreach.ts.

const router = Router();

const patchSettingsSchema = z
  .object({
    staleDays: z.number().int().min(1).max(365).optional(),
    autoAdvanceSourceToEnrich: z.boolean().optional(),
    autoAdvanceEnrichToSend: z.boolean().optional(),
    autoAdvanceSendToHandleReply: z.boolean().optional(),
  })
  .strict();

router.get('/settings', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const settings = await getOutreachSettings(orgId);
    res.json(settings);
  } catch (error) {
    log.error('Get outreach settings error', error);
    res.status(500).json({ error: 'Failed to load outreach settings' });
  }
});

router.patch('/settings', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const validation = patchSettingsSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }
    if (Object.keys(validation.data).length === 0) {
      return res.status(400).json({ error: 'No settings fields provided' });
    }

    const updated = await upsertOutreachSettings(orgId, validation.data);
    log.info('Outreach settings updated', { orgId, patch: validation.data });
    res.json(updated);
  } catch (error) {
    log.error('Update outreach settings error', error);
    res.status(500).json({ error: 'Failed to update outreach settings' });
  }
});

router.post('/settings/reset', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const defaults = await resetOutreachSettings(orgId);
    log.info('Outreach settings reset to defaults', { orgId });
    res.json(defaults);
  } catch (error) {
    log.error('Reset outreach settings error', error);
    res.status(500).json({ error: 'Failed to reset outreach settings' });
  }
});

export default router;
