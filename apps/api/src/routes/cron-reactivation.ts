// ─── Nightly deal-reactivation sweep ──────────────────────────────
// POST /api/cron/reactivation — walks every active org's dormant deals
// and re-scores the ones with a reason to be looked at. Auth is the
// shared CRON_SECRET, same shape as routes/cron-signal-scan.ts.
//
// The expensive decision (do we spend an LLM call on this deal?) lives in
// the engine's eligibility gate, not here. An org whose passed pile hasn't
// changed costs one query per night and nothing more.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { sweepPassedDeals } from '../services/agents/dealReactivation/index.js';

const router = Router();
const BATCH_SIZE = 5;

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: orgs, error } = await supabase
    .from('Organization')
    .select('id')
    .eq('isActive', true);

  if (error || !orgs) {
    log.error('Reactivation sweep: failed to list orgs', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list organizations' });
  }

  let rescored = 0;
  let reactivated = 0;
  let failed = 0;
  let failedOrgs = 0;
  let truncatedOrgs = 0;

  for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
    const batch = orgs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((org) =>
        sweepPassedDeals(org.id).catch((err) => {
          captureAgentError(err, { context: 'cron-reactivation', organizationId: org.id });
          return null;
        }),
      ),
    );

    for (const result of results) {
      if (!result) {
        failedOrgs += 1;
        continue;
      }
      rescored += result.rescored;
      reactivated += result.reactivated;
      failed += result.failed;
      if (result.truncated) truncatedOrgs += 1;
    }
  }

  // Truncation is reported, never swallowed — a capped sweep must not read
  // as full coverage.
  if (truncatedOrgs > 0) {
    log.warn('Reactivation sweep hit the per-org cap', { truncatedOrgs });
  }

  log.info('Reactivation sweep complete', {
    orgs: orgs.length, rescored, reactivated, failed, failedOrgs, truncatedOrgs,
  });

  res.json({ orgs: orgs.length, rescored, reactivated, failed, failedOrgs, truncatedOrgs });
});

export default router;
