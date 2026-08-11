// ─── /api/deals/:id/teasers router ──────────────────────────────────
// Per-deal firm-teaser endpoints:
//   GET  /api/deals/:id/teasers          → { teasers }   (one per generated profile)
//   POST /api/deals/:id/teasers { profileId } → { teaser } (generate/regenerate one)
//
// Mounted under /api/deals (see app.ts / app-lite.ts / app-ai.ts). The literal
// /:id/teasers shape is matched ahead of the bare /:id catch-all in deals-list
// because this router mounts before dealsRouter.

import { Router } from 'express';
import { z } from 'zod';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

const regenerateBodySchema = z.object({
  profileId: z.string(),
});

// ─── GET /api/deals/:id/teasers → { teasers } ───────────────────────
router.get('/:id/teasers', async (req, res) => {
  try {
    const { id: dealId } = req.params;
    const orgId = getOrgId(req);

    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { getDealTeasers } = await import('../services/firmTeaserService.js');
    const teasers = await getDealTeasers(dealId, orgId);
    res.json({ teasers });
  } catch (error) {
    log.error('deals-teasers: GET failed', error, { dealId: req.params.id });
    res.status(500).json({ error: 'Failed to load deal teasers' });
  }
});

// ─── POST /api/deals/:id/teasers { profileId } → { teaser } ─────────
router.post('/:id/teasers', async (req, res) => {
  try {
    const { id: dealId } = req.params;
    const orgId = getOrgId(req);

    const parsed = regenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { regenerateDealTeaser } = await import('../services/firmTeaserService.js');
    const teaser = await regenerateDealTeaser({ dealId, orgId, profileId: parsed.data.profileId });
    res.json({ teaser });
  } catch (error) {
    log.error('deals-teasers: POST failed', error, { dealId: req.params.id });
    const message = error instanceof Error ? error.message : 'Failed to generate teaser';
    if (message.startsWith('Profile not found')) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.status(500).json({ error: 'Failed to generate deal teaser', message });
  }
});

export default router;
