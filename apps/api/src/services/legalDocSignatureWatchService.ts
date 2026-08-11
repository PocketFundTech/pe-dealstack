// Automatic NDA-signature detection via Google Drive push notifications.
//
// HOW IT WORKS
//   When an NDA is "sent" (legalDocSendService), we create a Google Doc copy
//   shared with the counterparty. Google exposes NO eSignature status API, but
//   when a Google Doc eSignature completes Google locks the Doc with a content
//   restriction (`readOnly: true`). We register a Drive `files.watch` channel
//   on the Doc and, on each notification, re-read the Doc metadata. We treat
//   `contentRestrictions[].readOnly === true` as a PROBABLE (NOT confirmed)
//   "signed" signal — so we ALWAYS log the full raw metadata on every
//   notification to validate/tune this heuristic in production.
//
// GCP DOMAIN-VERIFICATION REQUIREMENT
//   Drive only delivers push notifications to a callback whose DOMAIN is
//   verified in GCP / Google Search Console. `*.vercel.app` domains cannot be
//   verified, so watches only function on the production custom domain. If
//   APP_URL is missing or not https, we SKIP watch registration (log.warn) and
//   never throw — sending still succeeds, signatures just won't auto-detect.
//
// STATE STORAGE
//   No DB migration is available, so ALL watch state lives inside the
//   LegalDocument `metadata.signatureWatch` jsonb blob.

import crypto from 'crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import {
  watchFile,
  stopChannel,
  getFileSignatureState,
} from '../integrations/googleDrive/watch.js';

// 7-day channel TTL (Drive caps file watches around this; we renew via cron).
const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Renew when a watch is within 24h of expiring.
const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

const WEBHOOK_PATH = '/api/webhooks/legal-docs/drive';

interface SignatureWatchState {
  channelId: string;
  resourceId: string;
  token: string;
  fileId: string;
  expiration: number;
  startedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract a typed `signatureWatch` from a row's `metadata` jsonb without `any`.
 * Returns null if absent or malformed.
 */
function readWatchState(metadata: unknown): SignatureWatchState | null {
  if (!isRecord(metadata)) return null;
  const sw = metadata.signatureWatch;
  if (!isRecord(sw)) return null;
  if (
    typeof sw.channelId !== 'string' ||
    typeof sw.resourceId !== 'string' ||
    typeof sw.token !== 'string' ||
    typeof sw.fileId !== 'string'
  ) {
    return null;
  }
  return {
    channelId: sw.channelId,
    resourceId: sw.resourceId,
    token: sw.token,
    fileId: sw.fileId,
    expiration: typeof sw.expiration === 'number' ? sw.expiration : 0,
    startedAt: typeof sw.startedAt === 'string' ? sw.startedAt : '',
  };
}

function getWebhookAddress(): string | null {
  const appUrl = process.env.APP_URL;
  if (!appUrl || !appUrl.startsWith('https://')) return null;
  return `${appUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`;
}

/**
 * Register a Drive watch on a sent NDA's Google Doc. BEST-EFFORT: the entire
 * body is wrapped so it NEVER throws — a failed watch must not affect sending.
 */
export async function registerSignatureWatch(args: {
  documentId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const { documentId, userId, organizationId } = args;
  try {
    const { data, error } = await supabase
      .from('LegalDocument')
      .select('id, organizationId, status, googleDocId, metadata')
      .eq('id', documentId)
      .maybeSingle();
    if (error) {
      log.warn('registerSignatureWatch: failed to load document', {
        documentId,
        message: error.message,
      });
      return;
    }
    if (!data) {
      log.warn('registerSignatureWatch: document not found', { documentId });
      return;
    }

    const row = data as {
      id: string;
      organizationId: string;
      status: string;
      googleDocId: string | null;
      metadata: unknown;
    };

    if (!row.googleDocId || row.status !== 'SENT') {
      log.info('registerSignatureWatch: skipping (no googleDocId or not SENT)', {
        documentId,
        status: row.status,
        hasGoogleDocId: Boolean(row.googleDocId),
      });
      return;
    }

    const address = getWebhookAddress();
    if (!address) {
      log.warn(
        'registerSignatureWatch: APP_URL missing or not https — skipping Drive watch (domain must be GCP-verified)',
        { documentId },
      );
      return;
    }

    const accessToken = await getProviderAccessToken({
      userId,
      organizationId,
      providerId: 'google_calendar',
    });
    if (!accessToken) {
      log.warn(
        'registerSignatureWatch: no Google Workspace token — skipping Drive watch',
        { documentId, userId, organizationId },
      );
      return;
    }

    const channelId = crypto.randomUUID();
    const secret = crypto.randomBytes(16).toString('hex');
    const token = `${documentId}:${secret}`;

    const { resourceId, expiration } = await watchFile(
      accessToken,
      row.googleDocId,
      { channelId, token, address, ttlMs: WATCH_TTL_MS },
    );

    const watchState: SignatureWatchState = {
      channelId,
      resourceId,
      token,
      fileId: row.googleDocId,
      expiration,
      startedAt: new Date().toISOString(),
    };

    const existingMetadata = isRecord(row.metadata) ? row.metadata : {};
    const nextMetadata = { ...existingMetadata, signatureWatch: watchState };

    const { error: updateErr } = await supabase
      .from('LegalDocument')
      .update({ metadata: nextMetadata, updatedAt: new Date().toISOString() })
      .eq('id', documentId);
    if (updateErr) {
      log.warn('registerSignatureWatch: failed to persist watch state', {
        documentId,
        message: updateErr.message,
      });
      return;
    }

    log.info('registerSignatureWatch: drive watch registered', {
      documentId,
      channelId,
      resourceId,
      expiration,
    });
  } catch (err) {
    log.warn('registerSignatureWatch: best-effort failure (non-fatal)', {
      documentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle one Drive push notification. Authenticates via the signed channel
 * token + resourceId match before trusting it, re-reads Doc metadata, logs the
 * raw payload, and flips status to SIGNED when the readOnly heuristic fires.
 */
export async function handleDriveNotification(args: {
  channelId: string;
  resourceId: string;
  resourceState: string;
  channelToken: string;
  messageNumber?: string;
}): Promise<void> {
  const { channelId, resourceId, resourceState, channelToken } = args;

  // The first message after a watch is registered is a `sync` handshake — ack
  // it and do nothing else.
  if (resourceState === 'sync') {
    log.info('handleDriveNotification: sync handshake', {
      channelId,
      resourceId,
    });
    return;
  }

  const documentId = channelToken.split(':')[0];
  if (!documentId) {
    log.warn('handleDriveNotification: empty documentId in channel token', {
      channelId,
      resourceId,
    });
    return;
  }

  const { data, error } = await supabase
    .from('LegalDocument')
    .select('id, organizationId, createdById, status, googleDocId, metadata')
    .eq('id', documentId)
    .maybeSingle();
  if (error) {
    log.warn('handleDriveNotification: failed to load document', {
      documentId,
      message: error.message,
    });
    return;
  }
  if (!data) {
    log.warn('handleDriveNotification: document not found', { documentId });
    return;
  }

  const doc = data as {
    id: string;
    organizationId: string;
    createdById: string;
    status: string;
    googleDocId: string | null;
    metadata: unknown;
  };

  const existing = readWatchState(doc.metadata);
  if (
    !existing ||
    existing.token !== channelToken ||
    existing.resourceId !== resourceId
  ) {
    log.warn('handleDriveNotification: stale/spoofed drive notification', {
      documentId,
      channelId,
      resourceId,
      hasWatchState: Boolean(existing),
      tokenMatch: existing ? existing.token === channelToken : false,
      resourceMatch: existing ? existing.resourceId === resourceId : false,
    });
    return;
  }

  if (doc.status === 'SIGNED') return;

  if (!doc.googleDocId) {
    log.warn('handleDriveNotification: document has no googleDocId', {
      documentId,
    });
    return;
  }

  const accessToken = await getProviderAccessToken({
    userId: doc.createdById,
    organizationId: doc.organizationId,
    providerId: 'google_calendar',
  });
  if (!accessToken) {
    log.warn('handleDriveNotification: no Google Workspace token', {
      documentId,
      userId: doc.createdById,
      organizationId: doc.organizationId,
    });
    return;
  }

  const state = await getFileSignatureState(accessToken, doc.googleDocId);

  // ALWAYS log the full raw metadata so we can validate/tune the (unconfirmed)
  // readOnly heuristic in production.
  log.info('legalDocSignatureWatch: drive notification metadata', {
    documentId,
    signed: state.signed,
    raw: state.raw,
  });

  if (!state.signed) return;

  const now = new Date().toISOString();
  const existingMetadata = isRecord(doc.metadata) ? doc.metadata : {};
  const nextMetadata = {
    ...existingMetadata,
    signatureDetectedVia: 'drive-watch',
    signatureDetectedAt: now,
  };

  const { error: updateErr } = await supabase
    .from('LegalDocument')
    .update({
      status: 'SIGNED',
      signedAt: now,
      metadata: nextMetadata,
      updatedAt: now,
    })
    .eq('id', documentId);
  if (updateErr) {
    log.warn('handleDriveNotification: failed to persist SIGNED status', {
      documentId,
      message: updateErr.message,
    });
    return;
  }

  // Stop the channel — we've got our signal, no need for further pings.
  try {
    await stopChannel(accessToken, channelId, resourceId);
  } catch (stopErr) {
    log.warn('handleDriveNotification: stopChannel failed (non-fatal)', {
      documentId,
      channelId,
      message: stopErr instanceof Error ? stopErr.message : String(stopErr),
    });
  }

  log.info('handleDriveNotification: NDA marked SIGNED via drive-watch', {
    documentId,
    googleDocId: doc.googleDocId,
  });
}

/**
 * Cron entrypoint: re-register watches that are missing or near expiry. Drive
 * file watches are capped (~7 days), so a periodic job keeps them alive for the
 * lifetime of an unsigned NDA.
 */
export async function renewExpiringWatches(): Promise<{
  checked: number;
  renewed: number;
}> {
  const { data, error } = await supabase
    .from('LegalDocument')
    .select('id, organizationId, createdById, status, googleDocId, metadata')
    .eq('status', 'SENT');

  if (error) {
    // Missing-table errors mean nothing to renew — return zero counts.
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return { checked: 0, renewed: 0 };
    }
    log.warn('renewExpiringWatches: query failed', { message: error.message });
    return { checked: 0, renewed: 0 };
  }

  const rows = (data ?? []) as Array<{
    id: string;
    organizationId: string;
    createdById: string;
    status: string;
    googleDocId: string | null;
    metadata: unknown;
  }>;

  let checked = 0;
  let renewed = 0;
  const renewBefore = Date.now() + RENEW_WINDOW_MS;

  for (const row of rows) {
    checked++;
    if (!row.googleDocId) continue;

    const existing = readWatchState(row.metadata);
    const needsRenew = !existing || existing.expiration <= renewBefore;
    if (!needsRenew) continue;

    // Best-effort stop of the old channel before re-registering, so we don't
    // leak orphaned Drive channels.
    if (existing) {
      try {
        const accessToken = await getProviderAccessToken({
          userId: row.createdById,
          organizationId: row.organizationId,
          providerId: 'google_calendar',
        });
        if (accessToken) {
          await stopChannel(
            accessToken,
            existing.channelId,
            existing.resourceId,
          );
        }
      } catch (stopErr) {
        log.warn('renewExpiringWatches: stopChannel failed (non-fatal)', {
          documentId: row.id,
          message:
            stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    }

    await registerSignatureWatch({
      documentId: row.id,
      userId: row.createdById,
      organizationId: row.organizationId,
    });
    renewed++;
  }

  return { checked, renewed };
}
