// ─── Daily Anthropic usage reconciliation sweep ────────────────────
// GET|POST /api/cron/usage-reconciliation — compares yesterday's (UTC) AI
// usage ledger against Anthropic's own Admin API billing and stores the
// drift in `UsageReconciliation`. Auth is the shared CRON_SECRET, same
// shape as routes/cron-reactivation.ts.
//
// Vercel Cron Jobs always invoke via GET (see commit "fix(cron): accept
// GET on every scheduled job route"); POST is kept for manual/test
// triggering. Runs at 03:00 UTC — after the previous UTC day has settled
// (Admin API data can lag up to ~5 minutes, so 03:00 is comfortably safe).
//
// `?day=YYYY-MM-DD` overrides the target day for manual backfill/replay.

import { Router, type Request, type Response } from 'express';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { reconcileAnthropicDay } from '../services/usage/anthropicReconciliation.js';

const router = Router();

function yesterdayUtc(): string {
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return y.toISOString().slice(0, 10);
}

const handler = async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';

  // An unset secret and a wrong secret must look IDENTICAL to the caller —
  // never leak configuration state to an unauthenticated request. But they
  // are very different operationally: a missing secret means this cron can
  // never run, silently, forever. Make that one findable in the logs.
  if (!process.env.CRON_SECRET) {
    log.error(
      'CRON_SECRET is not set — the usage-reconciliation cron can never run. Set it in the Vercel project environment.',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dayOverride = typeof req.query.day === 'string' ? req.query.day : undefined;
  const day = dayOverride && /^\d{4}-\d{2}-\d{2}$/.test(dayOverride) ? dayOverride : yesterdayUtc();

  try {
    const result = await reconcileAnthropicDay(day);
    if ('skipped' in result) {
      log.info('Usage reconciliation sweep skipped', { day, reason: result.skipped });
      return res.json({ day, ...result });
    }

    log.info('Usage reconciliation sweep complete', {
      day,
      ledgerCostUsd: result.ledgerCostUsd,
      providerCostUsd: result.providerCostUsd,
      driftUsd: result.driftUsd,
      driftPct: result.driftPct,
      persisted: result.persisted,
      alerted: result.alerted,
    });
    res.json(result);
  } catch (error) {
    captureAgentError(error, { context: 'cron-usage-reconciliation', day });
    log.error('Usage reconciliation sweep failed', {
      day,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Usage reconciliation sweep failed' });
  }
};

router.get('/', handler);
router.post('/', handler);

export default router;
