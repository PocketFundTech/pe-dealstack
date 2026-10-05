import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { runSignalMonitorViaManagedAgents } from '../services/managedAgents/signalMonitorOrchestrator.js';
import { runAsOrgSystem } from '../middleware/usageContext.js';

const router = Router();
const BATCH_SIZE = 5;

/**
 * Whether the org has any deal the signal monitor would look at — same
 * filter as its list_deals_for_org tool. Each scan is a paid Managed Agents
 * session, and one with no deals to watch is pure cost. Fails open: if the
 * count can't be read, the org is scanned.
 */
async function hasActiveDeals(orgId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('Deal')
    .select('id', { count: 'exact', head: true })
    .eq('organizationId', orgId)
    .neq('status', 'PASSED')
    .neq('stage', 'CLOSED_LOST');
  if (error) {
    log.warn('Nightly signal scan: active-deal count failed, scanning anyway', { orgId, error: error.message });
    return true;
  }
  return (count ?? 0) > 0;
}

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: orgs, error } = await supabase.from('Organization').select('id').eq('isActive', true);
  if (error || !orgs) {
    log.error('Nightly signal scan: failed to list orgs', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list organizations' });
  }

  let scanned = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
    const batch = orgs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (org) => {
        if (!(await hasActiveDeals(org.id))) return { status: 'skipped' as const };
        return runAsOrgSystem(org.id, 'cron:signal-scan', () => runSignalMonitorViaManagedAgents(org.id)).catch((err) => {
          captureAgentError(err, { context: 'cron-signal-scan', organizationId: org.id });
          return { status: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
        });
      }),
    );
    for (const r of results) {
      if (r.status === 'skipped') skipped++;
      else scanned++;
      if (r.status === 'failed') failed++;
    }
  }

  log.info('Nightly signal scan complete', { scanned, skipped, failed });
  res.json({ scanned, skipped, failed });
});

export default router;
