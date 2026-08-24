// POST /api/webhooks/clay-import/:secret — public Clay inbound sourcing
// webhook.
//
// Reverse direction from the existing Clay integration in
// services/outreachEnrichment.ts (we call a Clay per-table webhook to
// submit a contact for enrichment). This route is Clay calling US: a human
// filters/synthesizes a company list inside Clay's own UI (industry,
// location, employee size — Clay has no query API to do this outward, see
// services/outreachClayImport.ts's module header), then pushes the
// resulting rows out via an outbound HTTP webhook action they configure
// inside Clay's table.
//
// Auth follows routes/outreach-webhooks.ts's Reply.io pattern exactly: a
// shared secret WE define, carried as a URL path segment, verified with a
// constant-time compare (utils/webhookSecret.ts, shared with Reply.io's
// verifyReplyIoWebhookSecret) before anything in the payload is trusted.
// Fails closed — CLAY_IMPORT_WEBHOOK_SECRET unset means every request is
// rejected. Non-200 is reserved strictly for that auth failure; a
// malformed/empty payload past that point is logged and acknowledged with
// 200 + all-zero counts so Clay's delivery log doesn't show a false
// failure and Clay doesn't retry-storm us.
//
// Mounted BEFORE the authenticated routers in app.ts / app-lite.ts, same
// as outreachWebhooksRouter — Clay can't carry a Supabase session, so this
// can't go through authMiddleware/orgMiddleware. There is no req.user
// here; the Cicero Capital org is looked up directly by Organization.slug
// (this webhook only exists to serve that one org's Outreach board — see
// requireCiceroCapital in middleware/orgScope.ts for the equivalent
// authenticated-route gate).
//
// See docs/ENVIRONMENT_SETUP.md and .env.example for the operator setup
// steps (generate a secret, register the URL inside Clay, map Clay's
// table columns to the payload shape documented in
// services/outreachClayImport.ts).

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { verifySharedWebhookSecret } from '../utils/webhookSecret.js';
import { normalizeClayPayloadToRows, processClayImportBatch } from '../services/outreachClayImport.js';

const router = Router();

const CLAY_IMPORT_WEBHOOK_SECRET = process.env.CLAY_IMPORT_WEBHOOK_SECRET;

router.post('/:secret', async (req: Request, res: Response) => {
  // Verify the shared secret on EVERY request before doing anything else —
  // reject immediately on mismatch. Never trust payload contents before
  // this check passes.
  if (!verifySharedWebhookSecret(CLAY_IMPORT_WEBHOOK_SECRET, req.params.secret)) {
    log.warn('clay-import webhook: secret mismatch or CLAY_IMPORT_WEBHOOK_SECRET not configured, rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Past this point the caller is authenticated as whoever holds
  // CLAY_IMPORT_WEBHOOK_SECRET — but the payload shape is still untrusted
  // third-party input (a human-configured Clay table, not a fixed schema).
  // Nothing here should ever 500; log and 200 for anything that can't be
  // confidently acted on.
  try {
    const rows = normalizeClayPayloadToRows(req.body);

    if (rows.length === 0) {
      log.info('clay-import webhook: empty or unrecognized payload shape, nothing to import');
      return res.status(200).json({ received: 0, created: 0, updated: 0, flaggedForReview: 0 });
    }

    const { data: org, error: orgError } = await supabase
      .from('Organization')
      .select('id')
      .eq('slug', 'cicero-capital')
      .single();

    if (orgError || !org) {
      log.error('clay-import webhook: cicero-capital org lookup failed', orgError);
      return res.status(200).json({ received: rows.length, created: 0, updated: 0, flaggedForReview: 0 });
    }

    const summary = await processClayImportBatch(org.id, rows);

    log.info('clay-import webhook: batch processed', summary);

    return res.status(200).json(summary);
  } catch (err) {
    log.error('clay-import webhook: unexpected error processing payload', err);
    return res.status(200).json({ received: 0, created: 0, updated: 0, flaggedForReview: 0 });
  }
});

export default router;
