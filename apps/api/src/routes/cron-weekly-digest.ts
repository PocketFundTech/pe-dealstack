// ─── Weekly team activity digest sweep ─────────────────────────────
// POST /api/cron/weekly-digest — once a week, mails each org's admins
// a summary of the last 7 days of AuditLog activity. Auth is the
// shared CRON_SECRET, same shape as routes/cron-reactivation.ts.
//
// An org with no activity in the window gets skipped entirely — an
// empty digest ("0 deal created, 0 documents uploaded...") is worse
// than no email at all.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendWeeklyDigestEmail } from '../services/weeklyDigestEmail.js';

const router = Router();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';

  // An unset secret and a wrong secret must look IDENTICAL to the caller —
  // never leak configuration state to an unauthenticated request. But they
  // are very different operationally: a missing secret means this cron can
  // never run, silently, forever. Make that one findable in the logs.
  if (!process.env.CRON_SECRET) {
    log.error(
      'CRON_SECRET is not set — the weekly-digest cron can never run. Set it in the Vercel project environment.',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const windowStart = new Date(Date.now() - WEEK_MS);
  const weekOf = windowStart.toISOString().slice(0, 10);

  const { data: orgs, error } = await supabase.from('Organization').select('id, name');

  if (error || !orgs) {
    log.error('Weekly digest sweep: failed to list orgs', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list organizations' });
  }

  let orgsProcessed = 0;
  let emailsSent = 0;

  for (const org of orgs) {
    try {
      const { data: auditLogs, error: auditError } = await supabase
        .from('AuditLog')
        .select('action')
        .eq('organizationId', org.id)
        .gte('createdAt', windowStart.toISOString());

      if (auditError) {
        log.error('Weekly digest sweep: audit log query failed', {
          organizationId: org.id,
          error: auditError.message,
        });
        continue;
      }

      if (!auditLogs || auditLogs.length === 0) {
        // No activity this week — skip silently, don't send an empty digest.
        continue;
      }

      orgsProcessed += 1;

      const counts: Record<string, number> = {};
      for (const row of auditLogs) {
        const action = row.action as string;
        counts[action] = (counts[action] ?? 0) + 1;
      }

      const { data: admins, error: adminError } = await supabase
        .from('User')
        .select('id, email, name')
        .eq('organizationId', org.id)
        .eq('role', 'ADMIN');

      if (adminError) {
        log.error('Weekly digest sweep: admin lookup failed', {
          organizationId: org.id,
          error: adminError.message,
        });
        continue;
      }

      if (!admins || admins.length === 0) {
        continue;
      }

      for (const admin of admins) {
        if (!admin.email) continue;
        const sent = await sendWeeklyDigestEmail({
          to: admin.email,
          name: admin.name,
          orgName: org.name,
          counts,
          weekOf,
        });
        if (sent) emailsSent += 1;
      }
    } catch (err) {
      log.error('Weekly digest sweep: org processing threw', {
        organizationId: org.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Weekly digest sweep complete', { orgsProcessed, emailsSent });
  res.json({ orgsProcessed, emailsSent });
});

export default router;
