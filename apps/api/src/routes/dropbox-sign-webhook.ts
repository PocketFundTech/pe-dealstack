// POST /api/webhooks/dropbox-sign — public Dropbox Sign event callback.
//
// Dropbox Sign POSTs events as multipart/form-data with a single `json`
// field holding the event payload, and REQUIRES the response body to be the
// literal string "Hello API Event Received" (otherwise it flags the callback
// URL as broken and eventually disables it). No auth header — authenticity is
// proven by the HMAC `event_hash` we verify against our API key.
//
// Mounted BEFORE the authenticated routers in app-lite.ts / app.ts so the
// catch-all auth middleware never sees it.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { log } from '../utils/logger.js';
import {
  getDropboxSignConfig,
  verifyWebhookEvent,
} from '../integrations/dropboxSign/client.js';
import { handleDropboxSignEvent } from '../services/legalDocEsignService.js';

const router = Router();

// Dropbox Sign sends multipart/form-data; pull the `json` text field only.
const upload = multer();

const ACK_BODY = 'Hello API Event Received';

router.post('/dropbox-sign', upload.none(), async (req: Request, res: Response) => {
  const config = getDropboxSignConfig();
  if (!config) {
    log.warn('dropbox-sign webhook: not configured, ignoring');
    // Still ACK so Dropbox Sign's "test callback" succeeds during setup.
    return res.status(200).send(ACK_BODY);
  }

  const rawJson = (req.body as { json?: string } | undefined)?.json;
  if (!rawJson) {
    log.warn('dropbox-sign webhook: missing json field');
    return res.status(400).end();
  }

  let payload: {
    event?: { event_time?: string; event_type?: string; event_hash?: string };
  };
  try {
    payload = JSON.parse(rawJson);
  } catch (err) {
    log.warn('dropbox-sign webhook: malformed json', {
      message: err instanceof Error ? err.message : String(err),
    });
    return res.status(400).end();
  }

  if (!verifyWebhookEvent(config.apiKey, payload.event ?? null)) {
    log.warn('dropbox-sign webhook: signature verification failed', {
      eventType: payload.event?.event_type,
    });
    return res.status(401).end();
  }

  // Ack immediately, then process out-of-band. handleDropboxSignEvent never
  // throws — it logs its own failures — so this fire-and-forget is safe.
  res.status(200).send(ACK_BODY);
  void handleDropboxSignEvent(payload as Parameters<typeof handleDropboxSignEvent>[0]);
});

export default router;
