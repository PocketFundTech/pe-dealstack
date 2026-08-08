// ─── Deal scorecard route ─────────────────────────────────────────
// POST /api/deals/:dealId/scorecard — run the two-layer scorecard
// for a deal and return the persisted verdict.

import { Router } from 'express';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { scoreDeal, CriteriaNotConfiguredError } from '../services/agents/dealScorecard/index.js';
import { log } from '../utils/logger.js';

const router = Router();

router.post('/:dealId/scorecard', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const scorecard = await scoreDeal(dealId, orgId);
    res.json(scorecard);
  } catch (error: any) {
    if (error instanceof CriteriaNotConfiguredError) {
      return res.status(400).json({
        error: 'Set your investment criteria in Settings before scoring deals.',
        code: 'CRITERIA_NOT_CONFIGURED',
      });
    }
    log.error('Deal scorecard failed', { error: error.message });
    res.status(500).json({ error: `Failed to score deal: ${error.message}` });
  }
});

export default router;
