// Google Drive REST client. NOT a registered provider — these functions are
// invoked directly from services (legalDocSendService) using the access token
// stored under the `google_calendar` (Workspace) integration row.
//
// Scopes required (already in CALENDAR_SCOPES):
//   - https://www.googleapis.com/auth/drive.file    (create + manage app's own files)
//   - https://www.googleapis.com/auth/documents     (reserved for batchUpdate in v2)
//
// HTML → Google Doc conversion: the multipart upload sets the file's
// mimeType to `application/vnd.google-apps.document`, which makes Drive
// auto-convert the `text/html` body part into a native Google Doc.

import { log } from '../../utils/logger.js';
import {
  GoogleDriveError,
  type CreateDocResult,
  type DocMetadataResult,
  type DriveFileMetadata,
} from './types.js';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Native Google Doc export MIME types. files.export converts the Doc into
// these binary formats server-side — same renderer the counterparty sees.
const DRIVE_EXPORT_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

export type DriveExportFormat = keyof typeof DRIVE_EXPORT_MIME;

// Google-native source MIME → the binary format we export it to for ingest.
// Docs → PDF (best text fidelity for the extractor), Sheets → XLSX (so the
// Excel financial extractor picks it up), Slides → PDF. Native Google files
// have no downloadable bytes, so they must be exported rather than fetched
// with alt=media.
const DRIVE_NATIVE_EXPORT: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
  'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', ext: 'pdf' },
};

/** True for native Google types (Docs/Sheets/Slides) that need `export`. */
export function isGoogleNativeMime(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

/** Export target ({ mimeType, ext }) for a native Google type, or null. */
export function driveExportTargetFor(
  mimeType: string,
): { mimeType: string; ext: string } | null {
  return DRIVE_NATIVE_EXPORT[mimeType] ?? null;
}

const UPLOAD_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Parse a Google Doc file id out of a user-supplied string. Accepts either
 * a full Doc URL (…/d/<id>/edit, /document/d/<id>, etc.) or a bare file id.
 * Returns null when no plausible id can be extracted.
 *
 * Used by the "import an existing Google Doc" path (legalDocImportGdocService)
 * where the user pastes the URL of a Doc they prepared in their own Drive.
 */
export function extractGoogleDocId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // URL form: capture the id after the canonical `/d/<id>` segment.
  const urlMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  // Bare-id fallback: Drive file ids are long base64url-ish strings.
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export function mapDriveError(
  status: number,
  bodyText: string,
  fallbackMessage: string,
): GoogleDriveError {
  // Google returns 401 for an expired/invalid token, 403 for missing scope
  // OR permission denied. Sniff the body for "insufficient" / "scope" to
  // distinguish INSUFFICIENT_SCOPE from PERMISSION_DENIED.
  const lower = bodyText.toLowerCase();
  if (status === 401) {
    return new GoogleDriveError(
      'INVALID_TOKEN',
      'Google access token rejected (expired or revoked)',
      status,
      bodyText.slice(0, 500),
    );
  }
  if (status === 403) {
    if (lower.includes('insufficient') || lower.includes('scope')) {
      return new GoogleDriveError(
        'INSUFFICIENT_SCOPE',
        'Token lacks required Drive/Docs scope — user must re-authorize',
        status,
        bodyText.slice(0, 500),
      );
    }
    return new GoogleDriveError(
      'PERMISSION_DENIED',
      'Google Drive denied this request',
      status,
      bodyText.slice(0, 500),
    );
  }
  return new GoogleDriveError(
    'DRIVE_API_ERROR',
    fallbackMessage,
    status,
    bodyText.slice(0, 500),
  );
}

/**
 * Create a Google Doc by uploading HTML and asking Drive to convert it.
 * Uses a hand-rolled multipart/related body (Drive accepts both
 * multipart/related and multipart/form-data; related is the canonical form
 * documented in the v3 upload guide).
 */
export async function createDocFromHtml(
  accessToken: string,
  name: string,
  html: string,
  folderId?: string,
): Promise<CreateDocResult> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.document',
  };
  if (folderId) metadata.parents = [folderId];

  const boundary = `boundary_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const CRLF = '\r\n';
  const body =
    `--${boundary}${CRLF}` +
    `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}` +
    `${JSON.stringify(metadata)}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Type: text/html; charset=UTF-8${CRLF}${CRLF}` +
    `${html}${CRLF}` +
    `--${boundary}--`;

  const url = `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleDrive.createDocFromHtml: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapDriveError(res.status, text, 'Drive file create failed');
  }

  const json = (await res.json()) as { id?: string; webViewLink?: string };
  if (!json.id || !json.webViewLink) {
    throw new GoogleDriveError(
      'DRIVE_API_ERROR',
      'Drive create response missing id/webViewLink',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return { id: json.id, webViewLink: json.webViewLink };
}

/**
 * Grant a user permission on a file. We pass `sendNotificationEmail=false`
 * because the send service sends its own cover email via Resend.
 */
export async function setDocPermission(
  accessToken: string,
  fileId: string,
  emailAddress: string,
  role: 'writer' | 'commenter' | 'reader',
): Promise<void> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}/permissions?sendNotificationEmail=false`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'user', role, emailAddress }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleDrive.setDocPermission: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapDriveError(res.status, text, 'Drive permission grant failed');
  }
}

/**
 * Fetch lightweight metadata for a Doc. Reserved for future re-sync work
 * (we don't call it from the send path in v1).
 */
export async function getDocMetadata(
  accessToken: string,
  fileId: string,
): Promise<DocMetadataResult> {
  const fields = 'id,name,modifiedTime,webViewLink';
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapDriveError(res.status, text, 'Drive metadata fetch failed');
  }

  const json = (await res.json()) as Partial<DocMetadataResult>;
  if (!json.id || !json.name || !json.modifiedTime || !json.webViewLink) {
    throw new GoogleDriveError(
      'DRIVE_API_ERROR',
      'Drive metadata response missing required fields',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return {
    id: json.id,
    name: json.name,
    modifiedTime: json.modifiedTime,
    webViewLink: json.webViewLink,
  };
}

/**
 * Export a Google Doc to a binary format (docx or pdf) via files.export.
 * Returns the raw bytes as a Buffer.
 *
 * files.export caps at 10 MB — NDAs are far under that, so we don't
 * implement the large-file export-link fallback.
 */
export async function exportDocAs(
  accessToken: string,
  fileId: string,
  format: DriveExportFormat,
): Promise<Buffer> {
  const mimeType = DRIVE_EXPORT_MIME[format];
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}/export?mimeType=${encodeURIComponent(mimeType)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleDrive.exportDocAs: non-2xx', {
      status: res.status,
      format,
      bodyPreview: text.slice(0, 200),
    });
    throw mapDriveError(res.status, text, 'Drive export failed');
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Fetch metadata (name + mimeType + size) for an arbitrary Drive file the
 * user picked for ingest. Used to decide download-vs-export and to name the
 * stored document. Same per-file `drive.file` access model as the NDA import
 * flow — the Picker selection grants the app (and this server token) access.
 */
export async function getDriveFileMetadata(
  accessToken: string,
  fileId: string,
): Promise<DriveFileMetadata> {
  const fields = 'id,name,mimeType,size';
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapDriveError(res.status, text, 'Drive metadata fetch failed');
  }

  const json = (await res.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
  };
  if (!json.id || !json.name || !json.mimeType) {
    throw new GoogleDriveError(
      'DRIVE_API_ERROR',
      'Drive metadata response missing required fields',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return {
    id: json.id,
    name: json.name,
    mimeType: json.mimeType,
    // Drive returns size as a string; absent for native Google types.
    size: json.size ? Number(json.size) : undefined,
  };
}

/**
 * Download the raw bytes of a binary Drive file (PDF, .xlsx, .docx, …) via
 * `alt=media`. NOT valid for native Google types — use `exportDriveFile`.
 */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleDrive.downloadDriveFile: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapDriveError(res.status, text, 'Drive file download failed');
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Export a native Google file (Docs/Sheets/Slides) to a binary format via
 * `files.export`. `exportMimeType` comes from `driveExportTargetFor`.
 * (Generalizes `exportDocAs`, which is limited to a Doc→docx/pdf enum.)
 */
export async function exportDriveFile(
  accessToken: string,
  fileId: string,
  exportMimeType: string,
): Promise<Buffer> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(
    fileId,
  )}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('googleDrive.exportDriveFile: non-2xx', {
      status: res.status,
      exportMimeType,
      bodyPreview: text.slice(0, 200),
    });
    throw mapDriveError(res.status, text, 'Drive export failed');
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Permanently delete a Drive file. Used to clean up the throwaway Doc we
 * spin up when exporting a draft that has no persistent googleDocId yet.
 * A 404 means it's already gone — treat that as success.
 */
export async function deleteFile(
  accessToken: string,
  fileId: string,
): Promise<void> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw mapDriveError(res.status, text, 'Drive file delete failed');
  }
}
