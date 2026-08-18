// ─── Public document-request portal ───────────────────────────────
// Token-gated, account-free page where a broker or seller fulfils a
// document request. Mounted at /api/public/doc-requests WITHOUT auth
// middleware — the DocRequest token is the credential. Semantics mirror
// routes/portal.ts: 404 unknown, 410 revoked/expired.
//
// SECURITY — read before editing:
//   * The GET payload is a STRICT whitelist. The counterparty is an
//     outsider: they see the deal's display name, the requesting firm's
//     name, and the checklist. Never add financials, memos, scorecard,
//     stage, ids, or the token itself. tests/doc-request-portal.test.ts
//     pins the exact key set — if you widen it, you must widen the test
//     deliberately.
//   * Uploads run through handleDocumentUpload (the single document
//     pipeline: magic-byte validation, storage, dedup, extraction) with
//     an organizationId taken from the DocRequest row. Nothing about the
//     destination is caller-controlled.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { ALLOWED_MIME_TYPES } from '../services/fileValidator.js';
import { handleDocumentUpload } from './documents-upload.js';
import { notifyDealTeam } from './notifications.js';
import { checkRequestAccess, computeRequestStatus } from '../services/docRequests.js';

/**
 * Deal has NO `companyName` column — the company is a relation
 * (Deal.companyId -> Company). Selecting it errors the whole PostgREST
 * query and returns null data, which reads as "deal not found". That bug
 * 404'd every valid share link in routes/portal.ts (fixed in #118); this
 * route had the identical defect.
 */
function extractCompanyName(company: unknown): string | null {
  const c = Array.isArray(company) ? company[0] : company;
  if (c && typeof c === 'object' && 'name' in c) {
    const name = (c as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

const router = Router();

// Tighter than the general /api/ limiter: this endpoint is unauthenticated
// and writes to storage, so it's the most abusable surface in the app.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please wait a few minutes and try again.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Allowed: PDF, Excel, CSV, Word, Email, Images'));
  },
});

interface RequestRow {
  id: string;
  dealId: string;
  organizationId: string;
  message: string | null;
  status: string;
  recipientName: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  completedAt: string | null;
}

/** Resolve + validate a request token. Returns {request} or {status,error}. */
async function resolveRequest(
  token: string,
): Promise<{ request?: RequestRow; status?: number; error?: string }> {
  const { data } = await supabase
    .from('DocRequest')
    .select('id, dealId, organizationId, message, status, recipientName, expiresAt, revokedAt, completedAt')
    .eq('token', token)
    .single();

  const access = checkRequestAccess(data ?? null);
  if (!access.ok) return { status: access.status, error: access.error };
  return { request: data as RequestRow };
}

async function loadItems(requestId: string) {
  const { data } = await supabase
    .from('DocRequestItem')
    .select('id, requestId, label, docType, notes, required, sortOrder, documentId, fulfilledAt')
    .eq('requestId', requestId)
    .order('sortOrder', { ascending: true });
  return data ?? [];
}

/** Fire-and-forget event log — a failed insert never blocks the page. */
function recordEvent(requestId: string, kind: 'VIEWED' | 'UPLOADED' | 'COMPLETED', extra: Record<string, unknown> = {}) {
  return supabase
    .from('DocRequestEvent')
    .insert({ requestId, kind, ...extra })
    .then(({ error }: { error: unknown }) => {
      if (error) log.warn('doc request event insert failed', { error, kind });
    });
}

// GET /api/public/doc-requests/:token — the checklist page payload
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveRequest(req.params.token);
    if (!resolved.request) return res.status(resolved.status!).json({ error: resolved.error });
    const docRequest = resolved.request;

    await recordEvent(docRequest.id, 'VIEWED', { userAgent: req.headers['user-agent'] ?? null });

    const { data: deal } = await supabase
      .from('Deal')
      .select('name, company:Company(name)')
      .eq('id', docRequest.dealId)
      .single();
    if (!deal) return res.status(404).json({ error: 'This link is not valid.' });

    const { data: org } = await supabase
      .from('Organization')
      .select('name')
      .eq('id', docRequest.organizationId)
      .single();

    const items = await loadItems(docRequest.id);

    // Strict whitelist — see module comment.
    res.json({
      dealName: deal.name,
      companyName: extractCompanyName((deal as { company?: unknown }).company),
      firmName: org?.name ?? 'A deal team',
      recipientName: docRequest.recipientName,
      message: docRequest.message,
      status: docRequest.status,
      items: items.map((i) => ({
        id: i.id,
        label: i.label,
        notes: i.notes,
        required: i.required,
        fulfilled: !!i.fulfilledAt,
      })),
    });
  } catch (error: any) {
    log.error('Doc request portal fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load this request.' });
  }
});

/**
 * Multer rejects (bad MIME type, oversized file) surface as thrown errors.
 * Without this wrapper they reach Express's default handler and the broker
 * sees an opaque 500 for what is really "we don't accept .exe" — turn them
 * into an actionable 400 at the edge.
 */
function acceptSingleFile(field: string) {
  const middleware = upload.single(field);
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    middleware(req, res, (err?: unknown) => {
      if (!err) return next();
      const message = err instanceof Error ? err.message : 'Upload rejected';
      log.warn('Doc request upload rejected at the edge', { message });
      res.status(400).json({ error: message });
    });
  };
}

// POST /api/public/doc-requests/:token/items/:itemId/upload
router.post('/:token/items/:itemId/upload', uploadLimiter, acceptSingleFile('file'), async (req: Request, res: Response) => {
  try {
    const resolved = await resolveRequest(req.params.token);
    if (!resolved.request) return res.status(resolved.status!).json({ error: resolved.error });
    const docRequest = resolved.request;

    if (!req.file) return res.status(400).json({ error: 'No file was attached.' });

    // Scope the item to THIS request — an item id from another request must
    // be indistinguishable from one that doesn't exist.
    const items = await loadItems(docRequest.id);
    const item = items.find((i) => i.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Not found' });

    // Feed the shared pipeline. Org + deal come from the token's row.
    const uploadReq = {
      params: { dealId: docRequest.dealId },
      body: {
        name: req.file.originalname,
        type: item.docType || undefined,
        uploadedBy: null,
      },
      file: req.file,
      headers: req.headers,
      user: { organizationId: docRequest.organizationId },
    } as unknown as Request;

    let captured: { status: number; body: any } | null = null;
    const uploadRes = {
      status(code: number) {
        captured = { status: code, body: null };
        return this;
      },
      json(body: any) {
        captured = { status: captured?.status ?? 200, body };
        return this;
      },
    } as unknown as Response;

    await handleDocumentUpload(uploadReq, uploadRes);

    const result = captured as { status: number; body: any } | null;
    if (!result || result.status >= 400) {
      return res
        .status(result?.status ?? 500)
        .json(result?.body ?? { error: 'Upload failed' });
    }

    const documentId = result.body?.id ?? null;
    const now = new Date().toISOString();

    const { error: itemError } = await supabase
      .from('DocRequestItem')
      .update({ documentId, fulfilledAt: now })
      .eq('id', item.id)
      .eq('requestId', docRequest.id);
    if (itemError) throw itemError;

    await recordEvent(docRequest.id, 'UPLOADED', {
      itemId: item.id,
      userAgent: req.headers['user-agent'] ?? null,
    });

    // Recompute request status from the post-update checklist.
    const updated = items.map((i) =>
      i.id === item.id ? { ...i, fulfilledAt: now } : i,
    );
    const status = computeRequestStatus(
      updated.map((i) => ({ required: i.required, fulfilledAt: i.fulfilledAt })),
    );
    await supabase
      .from('DocRequest')
      .update({ status })
      .eq('id', docRequest.id);

    // The whole point of the feature: the deal team learns the moment
    // something lands, without watching an inbox.
    notifyDealTeam(
      docRequest.dealId,
      'DOCUMENT_UPLOADED',
      `${item.label} received`,
      `Uploaded via the document request link${docRequest.recipientName ? ` by ${docRequest.recipientName}` : ''}.`,
    ).catch((err) => log.error('Doc request notify failed', { err }));

    res.status(201).json({ success: true, itemId: item.id, status });
  } catch (error: any) {
    log.error('Doc request upload failed', { error: error.message });
    res.status(500).json({ error: 'Failed to upload the file.' });
  }
});

// POST /api/public/doc-requests/:token/complete — "I'm done"
router.post('/:token/complete', async (req, res) => {
  try {
    const resolved = await resolveRequest(req.params.token);
    if (!resolved.request) return res.status(resolved.status!).json({ error: resolved.error });
    const docRequest = resolved.request;

    const { error } = await supabase
      .from('DocRequest')
      .update({ completedAt: new Date().toISOString() })
      .eq('id', docRequest.id);
    if (error) throw error;

    await recordEvent(docRequest.id, 'COMPLETED', {
      userAgent: req.headers['user-agent'] ?? null,
    });

    notifyDealTeam(
      docRequest.dealId,
      'DOCUMENT_UPLOADED',
      'Document request marked complete',
      `${docRequest.recipientName ?? 'The recipient'} has finished uploading.`,
    ).catch((err) => log.error('Doc request complete notify failed', { err }));

    res.json({ success: true });
  } catch (error: any) {
    log.error('Doc request complete failed', { error: error.message });
    res.status(500).json({ error: 'Failed to complete the request.' });
  }
});

export default router;
