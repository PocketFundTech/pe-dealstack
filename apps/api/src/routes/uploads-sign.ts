import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { sanitizeFilename, ALLOWED_MIME_TYPES as DATA_ROOM_MIME_TYPES } from '../services/fileValidator.js';

const router = Router();

// Mirrors the multer fileFilter allow-list in ingest-shared.ts (the ingest
// pipeline: /api/ingest, /api/ingest/bulk single-doc fallback, /api/ai/ingest).
// Keep this in lockstep with that list — drift here means the client is
// allowed to stage a file the ingest endpoint then rejects outright.
const INGEST_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel.sheet.macroEnabled.12', // .xlsm
  'message/rfc822',
];
const INGEST_ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.xlsm', '.doc', '.docx', '.txt', '.csv', '.eml'];

// Mirrors ALLOWED_MIME_TYPES in fileValidator.ts (the data-room upload
// pipeline: POST /api/deals/:dealId/documents).
const DATA_ROOM_ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv', '.doc', '.docx', '.msg', '.eml', '.jpg', '.jpeg', '.png'];

const MAX_SIZE_BY_PURPOSE: Record<'ingest' | 'data-room', number> = {
  ingest: 50 * 1024 * 1024,
  'data-room': 100 * 1024 * 1024,
};

const signBodySchema = z.object({
  fileName: z.string().min(1, 'fileName is required'),
  contentType: z.string().min(1, 'contentType is required'),
  size: z.number().positive('size must be greater than 0'),
  purpose: z.enum(['ingest', 'data-room']),
  dealId: z.string().uuid().optional(),
});

function extensionOf(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

function isAllowedForPurpose(purpose: 'ingest' | 'data-room', contentType: string, fileName: string): boolean {
  const ext = extensionOf(fileName);
  if (purpose === 'ingest') {
    return INGEST_ALLOWED_MIME_TYPES.includes(contentType) || INGEST_ALLOWED_EXTENSIONS.includes(ext);
  }
  return DATA_ROOM_MIME_TYPES.includes(contentType) || DATA_ROOM_ALLOWED_EXTENSIONS.includes(ext);
}

// POST /api/uploads/sign — mint a short-lived signed upload URL so the
// browser can upload a large file DIRECTLY to Supabase Storage, bypassing
// Vercel's 4.5MB serverless request-body cap (a 5.5MB multipart POST to
// /api/ingest returns 413 FUNCTION_PAYLOAD_TOO_LARGE before the app ever
// runs, even though the app advertises a 50MB limit). The client stages the
// file here, uploads directly to `signedUrl`, then calls the real
// ingest/upload endpoint with a JSON body carrying only `storagePath` — see
// ingest-shared.ts#resolveUploadedFile for the server-side counterpart.
router.post('/sign', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const parsed = signBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { fileName, contentType, size, purpose, dealId } = parsed.data;

    const maxSize = MAX_SIZE_BY_PURPOSE[purpose];
    if (size > maxSize) {
      return res.status(413).json({
        error: `File is too large. Maximum size for ${purpose === 'ingest' ? 'document ingest' : 'data room uploads'} is ${Math.round(maxSize / (1024 * 1024))}MB.`,
      });
    }

    if (!isAllowedForPurpose(purpose, contentType, fileName)) {
      return res.status(400).json({
        error: 'Invalid file type',
        fileName,
        contentType,
      });
    }

    if (dealId) {
      const dealAccess = await verifyDealAccess(dealId, orgId);
      if (!dealAccess) {
        return res.status(403).json({ error: 'Forbidden: deal not found in your organization' });
      }
    }

    const safeName = sanitizeFilename(fileName);
    const storagePath = `staging/${orgId}/${randomUUID()}/${safeName}`;

    const { data, error } = await supabase.storage.from('documents').createSignedUploadUrl(storagePath);
    if (error || !data) {
      log.error('uploads/sign: createSignedUploadUrl failed', error, { storagePath });
      return res.status(500).json({ error: 'Failed to create signed upload URL' });
    }

    log.info('uploads/sign: issued signed upload URL', { orgId, purpose, storagePath, size });

    res.status(200).json({
      storagePath,
      token: data.token,
      signedUrl: data.signedUrl,
    });
  } catch (error) {
    log.error('uploads/sign error', error);
    res.status(500).json({ error: 'Failed to create signed upload URL' });
  }
});

export default router;
