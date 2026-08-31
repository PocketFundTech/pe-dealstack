// ─── Share-link expiring-soon warning sweep ───────────────────────
// POST /api/cron/share-expiry-warnings — finds DealShare links that expire
// within the next 48 hours and haven't been warned about yet, emails the
// creator, then stamps expiryWarningSentAt so the row never fires again.
// Auth is the shared CRON_SECRET, same shape as routes/cron-reactivation.ts.
//
// Runs daily but is idempotent: expiryWarningSentAt is set only after a
// successful send, and the query excludes rows where it's already set —
// so a link only ever gets warned about once.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendShareExpiryWarningEmail } from '../services/shareExpiryWarningEmail.js';

const router = Router();

const WARNING_WINDOW_MS = 48 * 60 * 60 * 1000;

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';

  // An unset secret and a wrong secret must look IDENTICAL to the caller —
  // never leak configuration state to an unauthenticated request. But they
  // are very different operationally: a missing secret means this cron can
  // never run, silently, forever. Make that one findable in the logs.
  if (!process.env.CRON_SECRET) {
    log.error(
      'CRON_SECRET is not set — the share-expiry-warnings cron can never run. Set it in the Vercel project environment.',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + WARNING_WINDOW_MS);

  const { data: shares, error } = await supabase
    .from('DealShare')
    .select('id, dealId, label, createdBy, expiresAt')
    .is('revokedAt', null)
    .is('expiryWarningSentAt', null)
    .not('expiresAt', 'is', null)
    .lte('expiresAt', windowEnd.toISOString())
    .gt('expiresAt', now.toISOString());

  if (error || !shares) {
    log.error('Share expiry warning sweep: failed to list shares', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list share links' });
  }

  let warningsSent = 0;

  for (const share of shares) {
    try {
      if (!share.createdBy) {
        log.warn('Share expiry warning: share has no createdBy, skipping', { shareId: share.id });
        continue;
      }

      const { data: deal, error: dealError } = await supabase
        .from('Deal')
        .select('name')
        .eq('id', share.dealId)
        .single();
      if (dealError || !deal) {
        log.warn('Share expiry warning: deal lookup failed', {
          shareId: share.id,
          dealId: share.dealId,
          error: dealError?.message,
        });
        continue;
      }

      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
        share.createdBy,
      );
      if (userError || !userData?.user?.email) {
        log.warn('Share expiry warning: creator lookup failed', {
          shareId: share.id,
          createdBy: share.createdBy,
          error: userError?.message,
        });
        continue;
      }

      const user = userData.user;
      const email = user.email;
      if (!email) continue;
      const fullName =
        typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null;

      const sent = await sendShareExpiryWarningEmail({
        to: email,
        name: fullName,
        dealName: deal.name,
        shareLabel: share.label ?? null,
        expiresAt: new Date(share.expiresAt),
      });

      if (!sent) {
        // Leave expiryWarningSentAt unset so a later run retries.
        continue;
      }

      const { error: updateError } = await supabase
        .from('DealShare')
        .update({ expiryWarningSentAt: new Date().toISOString() })
        .eq('id', share.id);
      if (updateError) {
        log.error('Share expiry warning: failed to stamp expiryWarningSentAt', {
          shareId: share.id,
          error: updateError.message,
        });
        continue;
      }

      warningsSent += 1;
    } catch (err) {
      log.error('Share expiry warning: unexpected error processing share', {
        shareId: share.id,
        err,
      });
    }
  }

  log.info('Share expiry warning sweep complete', { total: shares.length, warningsSent });

  res.json({ warningsSent });
});

export default router;
