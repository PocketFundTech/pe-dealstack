// ─── Public deal portal ──────────────────────────────────────────
// Token-gated, read-only external view of a shared deal. Mounted at
// /api/public/portal WITHOUT auth middleware (external viewers have no
// accounts) — the DealShare token is the credential. Semantics mirror
// the public invitation endpoints: 404 unknown, 410 revoked/expired.
//
// SECURITY: the deal payload is a strict whitelist. Never add internal
// fields (team, aiThesis, scorecard, notes) here — external viewers see
// only what the share's section toggles allow.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { getSignedDownloadUrl } from '../utils/storage.js';
import { log } from '../utils/logger.js';

const router = Router();

interface ShareRow {
  id: string;
  dealId: string;
  organizationId: string;
  label: string | null;
  includeFinancials: boolean;
  includeDocuments: boolean;
  includeMemos: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
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
    .select('id, dealId, organizationId, label, includeFinancials, includeDocuments, includeMemos, expiresAt, revokedAt')
    .eq('token', token)
    .single();

  if (!share) return { status: 404, error: 'This link is not valid.' };
  if (share.revokedAt) return { status: 410, error: 'This link has been revoked.' };
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    return { status: 410, error: 'This link has expired.' };
  }
  return { share };
}

// GET /api/public/portal/:token — the shared deal payload
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveShare(req.params.token);
    if (!resolved.share) return res.status(resolved.status!).json({ error: resolved.error });
    const share = resolved.share;

    // Record the view (fire-and-forget — a failed insert never blocks the page)
    void supabase
      .from('DealShareView')
      .insert({ shareId: share.id, userAgent: req.headers['user-agent'] ?? null })
      .then(({ error }: { error: unknown }) => {
        if (error) log.warn('portal view insert failed', { error });
      });

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
        sharedBy: org?.name ?? 'a PE OS user',
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

// GET /api/public/portal/:token/documents/:documentId/download
router.get('/:token/documents/:documentId/download', async (req, res) => {
  try {
    const resolved = await resolveShare(req.params.token);
    if (!resolved.share) return res.status(resolved.status!).json({ error: resolved.error });
    const share = resolved.share;

    if (!share.includeDocuments) return res.status(404).json({ error: 'Not found' });

    const { data: doc } = await supabase
      .from('Document')
      .select('id, dealId, fileUrl')
      .eq('id', req.params.documentId)
      .single();
    if (!doc || doc.dealId !== share.dealId || !doc.fileUrl) {
      return res.status(404).json({ error: 'Not found' });
    }

    const signedUrl = await getSignedDownloadUrl(doc.fileUrl);
    if (!signedUrl) return res.status(500).json({ error: 'Failed to prepare download' });

    res.redirect(302, signedUrl);
  } catch (error: any) {
    log.error('Portal download failed', { error: error.message });
    res.status(500).json({ error: 'Failed to prepare download' });
  }
});

export default router;
