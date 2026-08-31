// ─── Re-engagement / inactivity nudge sweep ────────────────────────
// POST /api/cron/reengagement-nudge — finds users whose most recent
// AuditLog activity is older than 14 days and sends them a light nudge
// email. Auth is the shared CRON_SECRET, same shape as
// routes/cron-reactivation.ts.
//
// Users with zero AuditLog rows ever (never-active accounts) are skipped
// on purpose — that's a different problem (onboarding), not re-engagement.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendReengagementEmail } from '../services/reengagementEmail.js';

const router = Router();
const INACTIVITY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';

  // An unset secret and a wrong secret must look IDENTICAL to the caller —
  // never leak configuration state to an unauthenticated request. But they
  // are very different operationally: a missing secret means this cron can
  // never run, silently, forever. Make that one findable in the logs.
  if (!process.env.CRON_SECRET) {
    log.error(
      'CRON_SECRET is not set — the reengagement-nudge cron can never run. Set it in the Vercel project environment.',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: users, error } = await supabase
    .from('User')
    .select('id, email, name, organizationId');

  if (error || !users) {
    log.error('Reengagement sweep: failed to list users', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list users' });
  }

  let nudgesSent = 0;
  let skippedNeverActive = 0;
  let skippedRecentlyActive = 0;
  let failed = 0;
  const cutoff = Date.now() - INACTIVITY_THRESHOLD_MS;

  for (const user of users) {
    try {
      const { data: lastLog, error: logError } = await supabase
        .from('AuditLog')
        .select('createdAt')
        .eq('userId', user.id)
        .order('createdAt', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (logError) {
        log.error('Reengagement sweep: failed to fetch last activity', {
          userId: user.id,
          error: logError.message,
        });
        failed += 1;
        continue;
      }

      // Never-active accounts are a different problem (onboarding), not
      // re-engagement — skip them on purpose.
      if (!lastLog) {
        skippedNeverActive += 1;
        continue;
      }

      const lastActiveAt = new Date(lastLog.createdAt).getTime();
      if (lastActiveAt >= cutoff) {
        skippedRecentlyActive += 1;
        continue;
      }

      if (!user.email) {
        failed += 1;
        continue;
      }

      const sent = await sendReengagementEmail({ to: user.email, name: user.name });
      if (sent) {
        nudgesSent += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      // Never let one user's failure abort the loop for the rest.
      log.error('Reengagement sweep: user iteration threw', { userId: user.id, err });
      failed += 1;
    }
  }

  log.info('Reengagement sweep complete', {
    users: users.length,
    nudgesSent,
    skippedNeverActive,
    skippedRecentlyActive,
    failed,
  });

  res.json({ nudgesSent, skippedNeverActive, skippedRecentlyActive, failed });
});

export default router;
