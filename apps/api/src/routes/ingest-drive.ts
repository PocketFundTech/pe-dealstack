// POST /api/ingest/drive — ingest a Google Drive file the user picked in the
// browser Google Picker, reusing the exact same pipeline as multipart uploads.
//
// The browser Picker mints a `drive.file` token; picking a file grants OUR app
// (same OAuth client + user) per-file access, so the server-side `google_calendar`
// ("Google") token can read the bytes — the same trust model the NDA import flow
// relies on. Works for ANY connected Google account (personal or Workspace); no
// extra scope beyond the existing `drive.file`.
//
// Native Google types (Docs/Sheets/Slides) have no downloadable bytes, so we
// export them (Docs→PDF, Sheets→XLSX) before handing off to the ingest pipeline.

import { Router } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import {
  getDriveFileMetadata,
  downloadDriveFile,
  exportDriveFile,
  isGoogleNativeMime,
  driveExportTargetFor,
} from '../integrations/googleDrive/client.js';
import { GoogleDriveError } from '../integrations/googleDrive/types.js';
import { runIngestFromBuffer } from './ingest-upload.js';
import { resolveUserId } from './notifications.js';
import { log } from '../utils/logger.js';

const router = Router();

const bodySchema = z.object({
  fileId: z.string().min(10),
  // Optional — merges the file into an existing deal instead of creating one.
  // Left loosely typed to match the multipart upload route's passthrough.
  dealId: z.string().optional(),
});

/** Append `.ext` to a name that doesn't already end in it (for exports). */
function ensureExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

router.post('/drive', async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'A Google Drive fileId is required',
      code: 'INVALID_BODY',
      details: parsed.error.flatten(),
    });
  }
  const { fileId } = parsed.data;

  const orgId = getOrgId(req);
  const authId = req.user?.id;
  if (!authId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const internalUserId = await resolveUserId(authId);
  if (!internalUserId) {
    return res
      .status(403)
      .json({ error: 'User not provisioned', code: 'USER_NOT_PROVISIONED' });
  }

  // Google Drive piggybacks on the `google_calendar` ("Google") OAuth token.
  const accessToken = await getProviderAccessToken({
    userId: internalUserId,
    organizationId: orgId,
    providerId: 'google_calendar',
  });
  if (!accessToken) {
    return res.status(409).json({
      error: 'Google is not connected. Connect it in Settings → Integrations.',
      code: 'GOOGLE_NOT_CONNECTED',
    });
  }

  try {
    const meta = await getDriveFileMetadata(accessToken, fileId);

    let buffer: Buffer;
    let mimeType = meta.mimeType;
    let documentName = meta.name;

    if (isGoogleNativeMime(meta.mimeType)) {
      const target = driveExportTargetFor(meta.mimeType);
      if (!target) {
        return res.status(415).json({
          error: `Unsupported Google file type for ingest: ${meta.mimeType}`,
          code: 'UNSUPPORTED_DRIVE_TYPE',
        });
      }
      buffer = await exportDriveFile(accessToken, fileId, target.mimeType);
      mimeType = target.mimeType;
      // Name the exported bytes with the right extension so the downstream
      // filename-based classifiers behave exactly like the upload path.
      documentName = ensureExt(meta.name, target.ext);
    } else {
      buffer = await downloadDriveFile(accessToken, fileId);
    }

    log.info('ingest-drive: fetched Drive file', {
      fileId,
      mimeType,
      bytes: buffer.length,
      exported: isGoogleNativeMime(meta.mimeType),
    });

    // Same pipeline as multipart upload. req.body.dealId (if present) routes
    // into the merge-into-existing-deal path inside runIngestFromBuffer.
    const result = await runIngestFromBuffer({
      buffer,
      mimeType,
      documentName,
      fileSize: buffer.length,
      req,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof GoogleDriveError) {
      const status =
        err.code === 'INVALID_TOKEN'
          ? 401
          : err.code === 'INSUFFICIENT_SCOPE' || err.code === 'PERMISSION_DENIED'
            ? 403
            : 502;
      log.warn('ingest-drive: Drive error', { code: err.code, status: err.status });
      return res.status(status).json({ error: err.message, code: err.code });
    }
    log.error('ingest-drive: unexpected error', err);
    const message = err instanceof Error ? err.message : 'Failed to ingest Drive file';
    return res.status(500).json({ error: 'Failed to ingest Drive file', message });
  }
});

export default router;
