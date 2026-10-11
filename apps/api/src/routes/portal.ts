// ─── Public deal portal ──────────────────────────────────────────
// Token-gated, read-only external view of a shared deal. Mounted at
// /api/public/portal WITHOUT auth middleware (external viewers have no
// accounts) — the DealShare token is the credential. Semantics mirror
// the public invitation endpoints: 404 unknown, 410 revoked/expired.
//
// SECURITY: the deal payload is a strict whitelist. Never add internal
// fields (team, aiThesis, scorecard, notes) here — external viewers see
// only what the share's section toggles allow.

import { Router, type Response } from 'express';
import { Readable } from 'node:stream';
import { supabase } from '../supabase.js';
import { downloadFileBuffer, fetchStorageObject } from '../utils/storage.js';
import { log } from '../utils/logger.js';
import { sendDocumentViewedEmail } from '../services/documentViewedEmail.js';
import { recordDocumentDownload } from '../services/documentActivity.js';
import { runInBackground } from '../utils/background.js';

const router = Router();

interface ShareRow {
  id: string;
  dealId: string;
  organizationId: string;
  label: string | null;
  invitedEmail?: string | null;
  includeFinancials: boolean;
  includeDocuments: boolean;
  includeMemos: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt?: string | null;
}

/**
 * Supabase typegen shapes an embedded relation as an object or a one-element
 * array depending on the FK's cardinality inference — normalise either.
 */
function extractCompanyName(company: unknown): string | null {
  const c = Array.isArray(company) ? company[0] : company;
  return (c as { name?: string | null } | null | undefined)?.name ?? null;
}

/** Resolve + validate a share token. Returns {share} or {status, error}. */
async function resolveShare(token: string): Promise<{ share?: ShareRow; status?: number; error?: string }> {
  const { data: share } = await supabase
    .from('DealShare')
    .select('id, dealId, organizationId, label, invitedEmail, includeFinancials, includeDocuments, includeMemos, expiresAt, revokedAt, createdBy, createdAt')
    .eq('token', token)
    .single();

  if (!share) return { status: 404, error: 'This link is not valid.' };
  if (share.revokedAt) return { status: 410, error: 'This link has been revoked.' };
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    return { status: 410, error: 'This link has expired.' };
  }
  return { share };
}

/**
 * Email the share's creator that their link was just viewed for the very
 * first time. Only called once we already know this is view #1 (see
 * recordViewAndNotify) — best-effort, every failure just logs.
 */
async function notifyShareCreatorOfFirstView(share: ShareRow): Promise<void> {
  if (!share.createdBy) return;
  try {
    const [{ data: deal }, { data: creator }] = await Promise.all([
      supabase.from('Deal').select('name').eq('id', share.dealId).single(),
      supabase.from('User').select('email, name').eq('authId', share.createdBy).single(),
    ]);
    if (!deal?.name || !creator?.email) return;

    await sendDocumentViewedEmail({
      to: creator.email,
      name: creator.name,
      dealName: deal.name,
      shareLabel: share.label,
    });
  } catch (error) {
    log.warn('portal first-view email failed', { error });
  }
}

/**
 * Record a portal view and, only for a share's very first view, notify its
 * creator by email. Never throws: every failure (count query, insert, or
 * the email itself) just logs.
 */
/** A repeat open from the same browser within this window is one view (refreshes, double fetches). */
const VIEW_DEDUPE_WINDOW_MS = 60_000;

async function recordViewAndNotify(share: ShareRow, userAgent: string | null): Promise<void> {
  // The view row is written BEFORE the response (awaited by the caller):
  // as a fire-and-forget promise it was killed when Vercel froze the
  // function after res.json, so share view counts never moved (QA #25b).
  // Only the first-view email runs in the background (runInBackground keeps
  // the invocation alive via waitUntil).
  try {
    const { count, error: countError } = await supabase
      .from('DealShareView')
      .select('id', { count: 'exact', head: true })
      .eq('shareId', share.id);
    if (countError) log.warn('portal view count failed', { error: countError });
    const isFirstView = !countError && (count ?? 0) === 0;

    if (!isFirstView && userAgent) {
      const since = new Date(Date.now() - VIEW_DEDUPE_WINDOW_MS).toISOString();
      const { data: recent } = await supabase
        .from('DealShareView')
        .select('id')
        .eq('shareId', share.id)
        .eq('userAgent', userAgent)
        .gte('viewedAt', since)
        .limit(1);
      if (recent && recent.length > 0) return; // same viewer, moments ago
    }

    const { error: insertError } = await supabase
      .from('DealShareView')
      .insert({ shareId: share.id, userAgent });
    if (insertError) {
      log.warn('portal view insert failed', { error: insertError });
      return;
    }

    if (isFirstView) {
      runInBackground('share-first-view-email', notifyShareCreatorOfFirstView(share));
    }
  } catch (error) {
    log.warn('portal view tracking failed', { error });
  }
}

// GET /api/public/portal/:token — the shared deal payload
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveShare(req.params.token);
    if (!resolved.share) return res.status(resolved.status!).json({ error: resolved.error });
    const share = resolved.share;

    // Record the view before responding (never throws — a failed insert
    // never blocks the page). First-ever view also emails the share's
    // creator, in the background — see recordViewAndNotify.
    await recordViewAndNotify(share, (req.headers['user-agent'] as string | undefined) ?? null);

    const { data: deal } = await supabase
      .from('Deal')
      .select('id, name, industry, stage, description, dealSize, revenue, ebitda, currency, company:Company(name)')
      .eq('id', share.dealId)
      .single();
    if (!deal) return res.status(404).json({ error: 'This link is not valid.' });

    const { data: org } = await supabase
      .from('Organization')
      .select('name')
      .eq('id', share.organizationId)
      .single();

    const payload: Record<string, unknown> = {
      share: {
        label: share.label,
        sharedBy: org?.name ?? 'an Avise user',
        sharedAt: share.createdAt ?? null,
        includeFinancials: share.includeFinancials,
        includeDocuments: share.includeDocuments,
        includeMemos: share.includeMemos,
      },
      // Strict whitelist — see module comment.
      deal: {
        name: deal.name,
        // Deal has no companyName column — it's a relation (Deal.companyId → Company).
        // Selecting the non-existent column made this query fail and 404 EVERY valid
        // share link (found 2026-08-18 by the authenticated QA pass).
        companyName: extractCompanyName(deal.company),
        industry: deal.industry,
        stage: deal.stage,
        description: deal.description,
        dealSize: deal.dealSize,
        revenue: deal.revenue,
        ebitda: deal.ebitda,
        currency: deal.currency,
      },
    };

    if (share.includeFinancials) {
      const { data: statements } = await supabase
        .from('FinancialStatement')
        .select('statementType, period, lineItems, unitScale, currency')
        .eq('dealId', share.dealId)
        .eq('isActive', true)
        .order('period', { ascending: false });
      // Strip `*_source` provenance keys before they leave the building. They
      // are internal extraction breadcrumbs ("Adjusted EBITDA 6,900 8,400
      // 10,200"), not metrics — an external viewer was seeing them rendered
      // as line items with dollar signs (found 2026-08-18 by browser QA).
      payload.financials = (statements ?? []).map((s: { lineItems: Record<string, unknown> | null }) => ({
        ...s,
        lineItems: Object.fromEntries(
          Object.entries(s.lineItems ?? {}).filter(([k]) => !k.endsWith('_source')),
        ),
      }));
    }

    if (share.includeDocuments) {
      const { data: documents } = await supabase
        .from('Document')
        .select('id, name, type, fileSize')
        .eq('dealId', share.dealId)
        .order('createdAt', { ascending: false });
      payload.documents = documents ?? [];
    }

    if (share.includeMemos) {
      const { data: memoRows } = await supabase
        .from('Memo')
        .select('id, title')
        .eq('dealId', share.dealId)
        .order('createdAt', { ascending: false });
      const memoIds = (memoRows ?? []).map((m) => m.id);
      let sections: Array<{ memoId: string; title: string; content: string; sortOrder: number }> = [];
      if (memoIds.length > 0) {
        const { data } = await supabase
          .from('MemoSection')
          .select('memoId, title, content, sortOrder')
          .in('memoId', memoIds)
          .order('sortOrder', { ascending: true });
        sections = data ?? [];
      }
      payload.memos = (memoRows ?? []).map((m) => ({
        id: m.id,
        title: m.title,
        sections: sections.filter((s) => s.memoId === m.id).map((s) => ({ title: s.title, content: s.content })),
      }));
    }

    res.json(payload);
  } catch (error: any) {
    log.error('Portal fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load this deal.' });
  }
});

// ─── Portal document download ─────────────────────────────────────
// SECURITY: the file is streamed THROUGH the API — the browser is never
// handed a storage signed URL. A signed URL (the old 302 redirect) kept
// working for its full hour after the owner revoked the share, and served
// the original un-watermarked file. Now every request re-checks the share
// (revoked/expired → 410, no bytes) and PDFs carry the same viewer
// watermark as internal Data Room downloads (routes/documents.ts).

// Same cap as internal downloads (routes/documents.ts): above this, PDFs
// pass through unwatermarked so the function doesn't OOM.
const WATERMARK_MAX_BYTES = 25 * 1024 * 1024;

/** Keep only characters the watermark's Helvetica (WinAnsi) font can draw —
 *  anything else makes pdf-lib throw, which would skip the watermark. */
function toWatermarkSafe(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

/** The identity stamped on a portal download: there's no viewer login, so
 *  identify the share link (label + short id) and who it was sent to. */
function portalViewerIdentity(share: ShareRow): string {
  const label = toWatermarkSafe(share.label ?? '');
  const shortId = share.id.slice(0, 8);
  const link = label ? `"${label}" (${shortId})` : shortId;
  const email = toWatermarkSafe(share.invitedEmail ?? '');
  return `Shared via portal link ${link}${email ? ` sent to ${email}` : ''}`;
}

function setDownloadHeaders(res: Response, filename: string, contentType: string): void {
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '') || 'document';
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  // Never let a browser/proxy cache serve the file after the link is revoked.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// GET /api/public/portal/:token/documents/:documentId/download
router.get('/:token/documents/:documentId/download', async (req, res) => {
  try {
    // Re-validated on EVERY request — revoking a share stops downloads at once.
    const resolved = await resolveShare(req.params.token);
    if (!resolved.share) return res.status(resolved.status!).json({ error: resolved.error });
    const share = resolved.share;

    if (!share.includeDocuments) return res.status(404).json({ error: 'Not found' });

    const { data: doc } = await supabase
      .from('Document')
      .select('id, dealId, fileUrl, name, mimeType, fileSize')
      .eq('id', req.params.documentId)
      .single();
    if (!doc || doc.dealId !== share.dealId || !doc.fileUrl) {
      return res.status(404).json({ error: 'Not found' });
    }

    const filename = doc.name || 'document';
    const shareRef = share.label || 'share link';
    const isPdf = (doc.mimeType ?? '').toLowerCase() === 'application/pdf' ||
      filename.toLowerCase().endsWith('.pdf');
    const sizeOk = typeof doc.fileSize !== 'number' || doc.fileSize <= WATERMARK_MAX_BYTES;

    if (isPdf && sizeOk) {
      try {
        const buffer = await downloadFileBuffer(doc.fileUrl);
        if (!buffer) throw new Error('Storage download returned null');
        const { watermarkPdf } = await import('../services/pdfWatermark.js');
        const stamped = await watermarkPdf(buffer, {
          email: portalViewerIdentity(share),
          ip: req.ip ?? null,
          timestamp: new Date(),
        });

        // QA #19: share-link downloads are logged on the deal timeline.
        await recordDocumentDownload({
          dealId: doc.dealId, documentId: doc.id, documentName: doc.name,
          by: shareRef, via: 'share_link', watermarked: true,
        });

        setDownloadHeaders(res, filename, 'application/pdf');
        res.setHeader('X-Watermarked', '1');
        res.setHeader('Content-Length', String(stamped.length));
        return res.end(stamped);
      } catch (wmErr) {
        // Same rule as internal downloads: still deliver the file (streamed
        // through the API below, never a signed URL). Logged to investigate.
        log.warn('Portal PDF watermark failed; streaming unwatermarked', {
          docId: doc.id,
          err: wmErr instanceof Error ? wmErr.message : String(wmErr),
        });
      }
    }

    // Passthrough: non-PDF, oversized PDF, or watermark failure — streamed.
    const upstream = await fetchStorageObject(doc.fileUrl);
    if (!upstream?.body) return res.status(500).json({ error: 'Failed to prepare download' });

    await recordDocumentDownload({
      dealId: doc.dealId, documentId: doc.id, documentName: doc.name,
      by: shareRef, via: 'share_link', watermarked: false,
    });

    setDownloadHeaders(
      res,
      filename,
      doc.mimeType || upstream.headers.get('content-type') || 'application/octet-stream',
    );
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);

    const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream);
    body.on('error', (err) => {
      log.error('Portal download stream failed', err, { docId: doc.id });
      res.destroy(err);
    });
    body.pipe(res);
  } catch (error: any) {
    log.error('Portal download failed', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare download' });
  }
});

export default router;
