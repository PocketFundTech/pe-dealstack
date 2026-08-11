// Public webhook + cron router for NDA signature detection.
//
// Mounted at /api/webhooks/legal-docs in the PUBLIC block of app-lite.ts —
// Google Drive POSTs notifications here with NO auth header. Identity is
// established from the signed channel token (X-Goog-Channel-Token) + resourceId
// match performed inside handleDriveNotification.
//
// The /drive handler ALWAYS responds 200 (even on error): Google retries
// non-2xx responses aggressively, and we never want that retry storm.

import { Router, type Request, type Response } from 'express';
import { log } from '../utils/logger.js';
import {
  handleDriveNotification,
  renewExpiringWatches,
} from '../services/legalDocSignatureWatchService.js';

const router = Router();

/**
 * Drive push-notification receiver. All identity arrives in X-Goog-* headers.
 * Body is empty / non-JSON (parses harmlessly under the global express.json).
 */
router.post('/drive', async (req: Request, res: Response) => {
  const channelId = req.header('x-goog-channel-id') ?? '';
  const resourceId = req.header('x-goog-resource-id') ?? '';
  const resourceState = req.header('x-goog-resource-state') ?? '';
  const channelToken = req.header('x-goog-channel-token') ?? '';
  const messageNumber = req.header('x-goog-message-number') ?? undefined;

  try {
    await handleDriveNotification({
      channelId,
      resourceId,
      resourceState,
      channelToken,
      messageNumber,
    });
  } catch (err) {
    log.warn('legal-doc-webhooks: handleDriveNotification failed', {
      channelId,
      resourceId,
      resourceState,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ALWAYS 200 — never let Google retry.
  res.status(200).end();
});

/**
 * Cron entrypoint to renew Drive watches before they expire. Protected by the
 * shared CRON_SECRET (Bearer header or x-cron-secret header).
 */
router.post('/_cron/renew-watches', async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(401).json({ error: 'Cron not configured' });
  const bearer = (req.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const xHeader = (req.header('x-cron-secret') ?? '').trim();
  if (bearer !== expected && xHeader !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await renewExpiringWatches();
    return res.json({ ok: true, ...result });
  } catch (err) {
    log.error('legal-doc-webhooks: renewExpiringWatches failed', err);
    return res.status(500).json({ error: 'Failed to renew watches' });
  }
});

export default router;
