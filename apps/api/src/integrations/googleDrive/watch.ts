// Google Drive `files.watch` push-notification helpers for NDA signature
// detection. These functions are invoked directly from
// legalDocSignatureWatchService using the access token stored under the
// `google_calendar` (Workspace) integration row (same token used by client.ts).
//
// Google has NO eSignature status API. When a Google Doc eSignature completes,
// Google applies a content restriction (readOnly) to the Doc. We register a
// `files.watch` channel on the Doc; on each notification we re-read the Doc
// metadata and treat `contentRestrictions[].readOnly === true` as a PROBABLE
// (NOT confirmed) "signed" signal — see isFileSignedFromMeta below.

import {
  DRIVE_FILES_URL,
  mapDriveError,
} from './client.js';
import { GoogleDriveError } from './types.js';

const WATCH_REQUEST_TIMEOUT_MS = 15_000;

const CHANNELS_STOP_URL = 'https://www.googleapis.com/drive/v3/channels/stop';

/**
 * Register a Drive push-notification channel on a file via `files.watch`.
 * Google POSTs notifications to `opts.address` (which MUST be an https URL on a
 * GCP/Search-Console-verified domain) carrying the `opts.token` back in the
 * `X-Goog-Channel-Token` header so we can authenticate them.
 */
export async function watchFile(
  accessToken: string,
  fileId: string,
  opts: { channelId: string; token: string; address: string; ttlMs?: number },
): Promise<{ resourceId: string; expiration: number }> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/watch`;
  const body: Record<string, unknown> = {
    id: opts.channelId,
    type: 'web_hook',
    address: opts.address,
    token: opts.token,
    ...(opts.ttlMs ? { expiration: String(Date.now() + opts.ttlMs) } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WATCH_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapDriveError(res.status, text, 'Drive files.watch failed');
  }

  const json = (await res.json()) as {
    resourceId?: string;
    expiration?: string;
  };
  if (!json.resourceId) {
    throw new GoogleDriveError(
      'DRIVE_API_ERROR',
      'Drive files.watch response missing resourceId',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return {
    resourceId: json.resourceId,
    expiration: Number(json.expiration ?? 0),
  };
}

/**
 * Stop a previously-registered notification channel. A 404 means the channel is
 * already gone/expired — treat that (and any 2xx) as success.
 */
export async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const res = await fetch(CHANNELS_STOP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: channelId, resourceId }),
    signal: AbortSignal.timeout(WATCH_REQUEST_TIMEOUT_MS),
  });

  if (res.ok || res.status === 404) return;
  const text = await res.text().catch(() => '');
  throw mapDriveError(res.status, text, 'Drive channels.stop failed');
}

/**
 * Re-read a Doc's metadata and derive whether it looks signed. Returns the full
 * raw parsed JSON so the caller can log it for heuristic tuning in production.
 */
export async function getFileSignatureState(
  accessToken: string,
  fileId: string,
): Promise<{
  raw: unknown;
  signed: boolean;
  name?: string;
  modifiedTime?: string;
}> {
  const fields = 'id,name,mimeType,modifiedTime,contentRestrictions';
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}?fields=${encodeURIComponent(fields)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(WATCH_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapDriveError(res.status, text, 'Drive metadata fetch failed');
  }

  const raw = (await res.json()) as unknown;
  const name =
    isRecord(raw) && typeof raw.name === 'string' ? raw.name : undefined;
  const modifiedTime =
    isRecord(raw) && typeof raw.modifiedTime === 'string'
      ? raw.modifiedTime
      : undefined;

  return {
    raw,
    signed: isFileSignedFromMeta(raw),
    name,
    modifiedTime,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * UNCONFIRMED HEURISTIC — DO NOT treat as definitive.
 *
 * Google exposes no eSignature-completion API. The observed behaviour is that
 * once a Google Doc eSignature flow completes, Google locks the Doc by adding a
 * content restriction with `readOnly: true`. We therefore interpret the
 * PRESENCE of any `contentRestrictions[]` entry whose `readOnly === true` as a
 * PROBABLE "signed" signal.
 *
 * Caveats this heuristic deliberately ignores (and why we log raw metadata on
 * every notification so we can validate/tune later):
 *   - A human could manually mark a Doc read-only for reasons unrelated to
 *     signing, producing a false positive.
 *   - Google could change the locking mechanism (e.g. a different restriction
 *     shape or a `reason` field) at any time, producing a false negative.
 *
 * Narrowing note: `meta` is `unknown`. We walk it defensively without `any`,
 * checking each level is the expected shape before reading the next.
 */
export function isFileSignedFromMeta(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const restrictions = meta.contentRestrictions;
  if (!Array.isArray(restrictions)) return false;
  return restrictions.some(
    (r) => isRecord(r) && r.readOnly === true,
  );
}
