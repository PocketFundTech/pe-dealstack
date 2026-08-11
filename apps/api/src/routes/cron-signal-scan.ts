import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { runSignalMonitorViaManagedAgents } from '../services/managedAgents/signalMonitorOrchestrator.js';

const router = Router();
const BATCH_SIZE = 5;

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

  let failed = 0;
  for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
    const batch = orgs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((org) =>
        runSignalMonitorViaManagedAgents(org.id).catch((err) => {
          captureAgentError(err, { context: 'cron-signal-scan', organizationId: org.id });
          return { status: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
        }),
      ),
    );
    failed += results.filter((r) => r.status === 'failed').length;
  }

  log.info('Nightly signal scan complete', { scanned: orgs.length, failed });
  res.json({ scanned: orgs.length, failed });
});

export default router;
