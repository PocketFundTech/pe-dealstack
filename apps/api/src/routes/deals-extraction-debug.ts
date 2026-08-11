// ─── Per-deal extraction debug endpoint ──────────────────────────
// GET /api/deals/:id/extraction-debug
//
// Read-only audit dump that lets the user compare what the AI extracted
// for a deal vs what's actually in the source document. Returns a single
// JSON document with:
//   - deal: top-line Deal row (name, currency, revenue, ebitda, dealSize)
//   - documents: every Document on the deal with mimeType + a
//                first-2000-char sample of extractedText (so the user can
//                eyeball what the parser actually saw)
//   - statements: every FinancialStatement row keyed by id, full lineItems
//                 jsonb included plus all extraction-provenance columns
//   - summary:    counts (totalDocuments, totalStatements, totalPeriods,
//                 byStatementType breakdown)
//
// The browser receives `Content-Disposition: attachment` so the response
// downloads as `extraction-{dealId}-{ISO-date}.json` instead of rendering
// inline. Less invasive than instrumenting the extraction pipeline:
// reads only existing tables, no schema changes.
//
// Auth: standard authMiddleware + orgMiddleware (mounted in app.ts);
// route additionally calls verifyDealAccess to guarantee the deal belongs
// to the caller's org. Mounted in deals.ts before the /:id catch-all so
// the literal "extraction-debug" segment matches first.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

const TEXT_SAMPLE_LIMIT = 2000;

router.get('/:id/extraction-debug', async (req, res) => {
  try {
    const dealId = req.params.id;
    const orgId = getOrgId(req);

    // verifyDealAccess gates by organizationId — same pattern every other
    // deal-child route uses (see financials.ts, documents.ts, etc.).
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // 1. Full Deal row — pulls top-line numbers stored on the Deal record
    //    itself (these are what the deals listing card shows; useful to
    //    cross-check against the FinancialStatement-derived figures).
    //    select('*') over a typed list because (a) some columns the agent
    //    initially listed aren't actually on the Deal table and a typo
    //    causes Supabase to return 400 → route 404s with "Deal not found"
    //    even though the row exists, (b) we want every column anyway for
    //    audit purposes.
    const { data: deal, error: dealErr } = await supabase
      .from('Deal')
      .select('*')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    if (dealErr || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // 2. All Documents on the deal. extractedText can be hundreds of KB —
    //    cap each sample at TEXT_SAMPLE_LIMIT so the JSON stays manageable.
    //    extractedTextLength is reported separately so the user knows when
    //    the sample was truncated.
    //    Column names: Document table uses `status` (not extractionStatus)
    //    and `aiAnalysis` (not aiSummary) — original SELECT had typos that
    //    triggered Supabase column-not-found errors. select('*') sidesteps
    //    the issue and pulls everything for audit.
    const { data: docs, error: docsErr } = await supabase
      .from('Document')
      .select('*')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false });

    if (docsErr) throw docsErr;

    const documents = (docs ?? []).map((d) => {
      const text = (d.extractedText as string | null) ?? null;
      const len = text?.length ?? 0;
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        mimeType: d.mimeType,
        fileSize: d.fileSize,
        fileUrl: d.fileUrl,
        status: d.status,
        extractedTextLength: len,
        extractedTextSample:
          text && len > TEXT_SAMPLE_LIMIT ? text.slice(0, TEXT_SAMPLE_LIMIT) : text,
        extractedTextSampleTruncated: len > TEXT_SAMPLE_LIMIT,
        aiAnalysis: d.aiAnalysis,
        tags: d.tags,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
    });

    // 3. All FinancialStatement rows — full row, including raw lineItems
    //    jsonb. We include both active and inactive rows so the user can
    //    audit superseded extractions too (extraction reruns mark old
    //    rows isActive=false instead of hard-deleting them).
    const { data: statements, error: stmtsErr } = await supabase
      .from('FinancialStatement')
      .select(
        'id, dealId, documentId, statementType, period, periodType, lineItems, unitScale, currency, extractionConfidence, extractionSource, extractedAt, isActive, mergeStatus, reviewedAt, reviewedBy, createdAt, updatedAt',
      )
      .eq('dealId', dealId)
      .order('statementType', { ascending: true })
      .order('period', { ascending: true });

    if (stmtsErr) throw stmtsErr;

    const stmtRows = statements ?? [];

    // 4. Summary counts — keyed off active rows only since that's what the
    //    UI surfaces. Period count is unique periods per statementType.
    const activeStmts = stmtRows.filter((s) => s.isActive);
    const byStatementType: Record<string, number> = {};
    const periodSet = new Set<string>();
    for (const s of activeStmts) {
      const t = s.statementType as string;
      byStatementType[t] = (byStatementType[t] ?? 0) + 1;
      if (s.period) periodSet.add(`${t}::${s.period}`);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      deal,
      documents,
      statements: stmtRows,
      summary: {
        totalDocuments: documents.length,
        totalStatements: stmtRows.length,
        totalActiveStatements: activeStmts.length,
        totalPeriods: periodSet.size,
        byStatementType,
      },
    };

    // Force-download the JSON so the user gets a file they can diff/grep
    // rather than a browser-rendered tree. Filename embeds dealId + an
    // ISO date stamp so successive downloads don't overwrite each other.
    const datePart = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="extraction-${dealId}-${datePart}.json"`,
    );
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    log.error('GET /api/deals/:id/extraction-debug error', err);
    res.status(500).json({ error: 'Failed to build extraction debug payload' });
  }
});

export default router;
