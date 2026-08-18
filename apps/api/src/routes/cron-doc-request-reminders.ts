// ─── Nightly document-request reminder sweep ──────────────────────
// POST /api/cron/doc-request-reminders — nudges brokers/sellers who
// haven't finished uploading. Auth is the shared CRON_SECRET, same shape
// as routes/cron-signal-scan.ts.
//
// Pacing lives in services/docRequests.ts (isReminderDue): a request must
// be a few days old, past the gap since the last nudge, and under the
// hard cap. We chase, we don't harass — a broker who ignores three emails
// is telling us something, and the deal team can still nudge by hand.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendDocRequestEmail } from '../services/docRequestEmail.js';
import { isReminderDue } from '../services/docRequests.js';

const router = Router();

/** Ceiling per run so one huge tenant can't monopolise the window. */
const MAX_PER_RUN = 200;

function uploadUrl(token: string): string {
  return `${process.env.APP_URL || 'http://localhost:3002'}/upload/${token}`;
}

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';

  // An unset secret and a wrong secret must look IDENTICAL to the caller —
  // never leak configuration state to an unauthenticated request. But they
  // are very different operationally: a missing secret means this cron can
  // never run, silently, forever. Make that one findable in the logs.
  if (!process.env.CRON_SECRET) {
    log.error(
      'CRON_SECRET is not set — the doc-request-reminders cron can never run. Set it in the Vercel project environment.',
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Coarse DB filter; isReminderDue applies the real pacing rules.
    const { data: candidates, error } = await supabase
      .from('DocRequest')
      .select('id, dealId, organizationId, token, recipientEmail, recipientName, message, status, createdAt, expiresAt, revokedAt, lastRemindedAt, reminderCount')
      .in('status', ['OPEN', 'PARTIAL'])
      .is('revokedAt', null)
      .order('createdAt', { ascending: true })
      .limit(MAX_PER_RUN);

    if (error) {
      log.error('Doc request reminder sweep: candidate query failed', { error: error.message });
      return res.status(500).json({ error: 'Failed to list requests' });
    }

    const now = new Date();
    const due = (candidates ?? []).filter((r) => isReminderDue(r as never, now));

    if (due.length === 0) {
      return res.json({ scanned: candidates?.length ?? 0, reminded: 0, failed: 0 });
    }

    // Batch-load the labels the email needs, rather than N queries per request.
    const requestIds = due.map((r) => r.id);
    const dealIds = [...new Set(due.map((r) => r.dealId))];
    const orgIds = [...new Set(due.map((r) => r.organizationId))];

    const [{ data: items }, { data: deals }, { data: orgs }] = await Promise.all([
      supabase
        .from('DocRequestItem')
        .select('requestId, label, required, fulfilledAt')
        .in('requestId', requestIds)
        .order('sortOrder', { ascending: true }),
      supabase.from('Deal').select('id, name').in('id', dealIds),
      supabase.from('Organization').select('id, name').in('id', orgIds),
    ]);

    const itemsByRequest = new Map<string, any[]>();
    for (const item of items ?? []) {
      const list = itemsByRequest.get(item.requestId) ?? [];
      list.push(item);
      itemsByRequest.set(item.requestId, list);
    }
    const dealNames = new Map((deals ?? []).map((d) => [d.id, d.name]));
    const orgNames = new Map((orgs ?? []).map((o) => [o.id, o.name]));

    let reminded = 0;
    let failed = 0;

    for (const docRequest of due) {
      try {
        await sendDocRequestEmail({
          to: docRequest.recipientEmail!,
          recipientName: docRequest.recipientName,
          dealName: dealNames.get(docRequest.dealId) ?? 'a deal',
          firmName: orgNames.get(docRequest.organizationId) ?? null,
          message: docRequest.message,
          url: uploadUrl(docRequest.token),
          items: itemsByRequest.get(docRequest.id) ?? [],
          isReminder: true,
        });

        await supabase
          .from('DocRequest')
          .update({
            lastRemindedAt: new Date().toISOString(),
            reminderCount: (docRequest.reminderCount ?? 0) + 1,
          })
          .eq('id', docRequest.id);

        reminded += 1;
      } catch (err) {
        // One bad address must not abort the sweep for everyone else.
        failed += 1;
        log.error('Doc request reminder failed', {
          requestId: docRequest.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Doc request reminder sweep complete', {
      scanned: candidates?.length ?? 0,
      due: due.length,
      reminded,
      failed,
    });
    res.json({ scanned: candidates?.length ?? 0, reminded, failed });
  } catch (error: any) {
    log.error('Doc request reminder sweep threw', { error: error.message });
    res.status(500).json({ error: 'Reminder sweep failed' });
  }
});

export default router;
