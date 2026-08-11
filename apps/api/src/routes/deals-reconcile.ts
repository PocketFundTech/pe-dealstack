// ─── Per-deal quantitative reconciliation endpoint ───────────────
// GET /api/deals/:id/reconcile
//
// Phase 1 of the extraction-quality audit tool: aggregates the deal's
// stored FinancialStatement rows into computed ground truth (annual
// sums, TTM, MRR, margins), channel concentration + HHI, asking-price
// vs micro-SaaS comp bands, and OpEx step-up findings. No LLM calls —
// pure TS over data already in the DB.
//
// Returns JSON. Sets Content-Disposition: attachment so the browser
// downloads `reconcile-{dealId}-{ISO-date}.json` for diff/grep.
//
// Auth: same gate as every other deal-child route — getOrgId +
// verifyDealAccess. Mounted in deals.ts before /:id catch-all in
// deals-list so the literal "reconcile" segment matches first.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import type {
  FinancialStatementRow,
  NarrativeDocumentInput,
  DealRecordInput,
} from '../services/quantitativeReconciler.js';

const router = Router();

// Per-doc text slice cap fed to LLM modules in Phase 2. Each doc gets
// ~20K chars (~5K tokens) so the combined narrative context stays
// under the model's input window even with 4-5 docs.
const PHASE2_TEXT_LIMIT_PER_DOC = 20_000;

router.get('/:id/reconcile', async (req, res) => {
  try {
    const dealId = req.params.id;
    const orgId = getOrgId(req);
    // ?level=full opts into Phase 2 (LLM-augmented). Default = Phase 1
    // only (deterministic, ~100ms, free). Phase 2 takes ~30-60s and
    // costs a few cents in LLM tokens, hence opt-in.
    const level = (req.query.level === 'full' ? 'full' : 'phase1') as 'phase1' | 'full';

    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Pull deal row — needed for asking price (Phase 1) AND for the
    // dealRecord input that Phase 2's extractionFeedback module
    // critiques against computed truth. dealSize is stored in millions
    // per schema convention; we convert to actual dollars for Phase 1.
    //
    // select('*') because the Deal table doesn't have a `companyName`
    // column (company name lives on the related Company table via
    // companyId). An earlier explicit list included companyName and
    // every reconcile request 404'd because Supabase returned 400 on
    // the missing column → outer catch translated to "Deal not found".
    const { data: deal, error: dealErr } = await supabase
      .from('Deal')
      .select('*')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    if (dealErr || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Active rows only — reconciler should not double-count superseded
    // extractions.
    const { data: stmts, error: stmtsErr } = await supabase
      .from('FinancialStatement')
      .select(
        'id, documentId, statementType, period, periodType, lineItems, unitScale, currency, extractionConfidence, isActive',
      )
      .eq('dealId', dealId)
      .eq('isActive', true);

    if (stmtsErr) throw stmtsErr;

    const rows = (stmts ?? []) as FinancialStatementRow[];
    const {
      rowsToReconcilerInput,
      runQuantitativeReconciliationPhase1,
      runQuantitativeReconciliationPhase2,
    } = await import('../services/quantitativeReconciler.js');
    const reconcilerInput = rowsToReconcilerInput(rows);
    const askingPriceUsd =
      typeof deal.dealSize === 'number' && deal.dealSize > 0
        ? deal.dealSize * 1_000_000
        : null;
    const ctx = {
      askingPriceUsd,
      currency: (deal.currency as string) ?? 'USD',
    };

    let result: Record<string, unknown>;
    let phase: number = 1;

    if (level === 'full') {
      // Phase 2 — also fetch narrative documents for the LLM modules.
      // Skip docs without extracted text (vision-only PDFs, etc.) since
      // the LLM has nothing to read.
      const { data: docs, error: docsErr } = await supabase
        .from('Document')
        .select('id, name, type, mimeType, extractedText')
        .eq('dealId', dealId)
        .order('createdAt', { ascending: false });

      if (docsErr) throw docsErr;

      const narrativeDocuments: NarrativeDocumentInput[] = (docs ?? [])
        .filter((d) => typeof d.extractedText === 'string' && d.extractedText.length > 100)
        .map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          mimeType: d.mimeType,
          extractedText: (d.extractedText as string).slice(0, PHASE2_TEXT_LIMIT_PER_DOC),
        }));

      const dealRecord: DealRecordInput = {
        id: deal.id,
        name: deal.name,
        companyName: (deal.companyName as string) ?? null,
        industry: (deal.industry as string) ?? null,
        currency: (deal.currency as string) ?? 'USD',
        revenue: typeof deal.revenue === 'number' ? deal.revenue : null,
        ebitda: typeof deal.ebitda === 'number' ? deal.ebitda : null,
        dealSize: typeof deal.dealSize === 'number' ? deal.dealSize : null,
      };

      // Compute asOfDateIso — pick the latest period from active
      // statements. Falls back to today if no parseable periods.
      const asOfDateIso = pickAsOfDate(rows);

      const phase2Result = await runQuantitativeReconciliationPhase2({
        statements: reconcilerInput,
        ctx,
        narrativeDocuments,
        dealRecord,
        asOfDateIso,
        dealId,
        orgId,
      });
      result = phase2Result as unknown as Record<string, unknown>;
      phase = 2;
    } else {
      const phase1Result = runQuantitativeReconciliationPhase1({
        statements: reconcilerInput,
        ctx,
      });
      result = phase1Result as unknown as Record<string, unknown>;
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      phase,
      deal: {
        id: deal.id,
        name: deal.name,
        currency: deal.currency ?? 'USD',
        askingPriceUsd,
        askingPriceSource: 'Deal.dealSize × 1,000,000',
      },
      inputSummary: {
        totalActiveStatements: rows.length,
        statementsByType: rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.statementType] = (acc[r.statementType] ?? 0) + 1;
          return acc;
        }, {}),
      },
      ...result,
    };

    const datePart = new Date().toISOString().split('T')[0];
    const namePart = phase === 2 ? 'reconcile-full' : 'reconcile';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${namePart}-${dealId}-${datePart}.json"`,
    );
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    log.error('GET /api/deals/:id/reconcile error', err);
    res.status(500).json({ error: 'Failed to build reconciliation payload' });
  }
});

// Pick the latest period across active statements as ISO date. Returns
// today's date when no parseable monthly/annual periods exist — never
// throws (used as a metadata field, not a hard input).
function pickAsOfDate(rows: FinancialStatementRow[]): string {
  let latestYear = 0;
  let latestMonth = 0;
  for (const r of rows) {
    const upper = (r.period ?? '').trim().toUpperCase();
    const iso = upper.match(/^(\d{4})-(\d{2})$/);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      if (y > latestYear || (y === latestYear && m > latestMonth)) {
        latestYear = y;
        latestMonth = m;
      }
      continue;
    }
    const monShort = upper.match(/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-(\d{2})$/);
    if (monShort) {
      const monthIdx: Record<string, number> = {
        JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
        JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
      };
      const m = monthIdx[monShort[1]];
      const y = 2000 + Number(monShort[2]);
      if (y > latestYear || (y === latestYear && m > latestMonth)) {
        latestYear = y;
        latestMonth = m;
      }
      continue;
    }
    const four = upper.match(/^(\d{4})$/);
    if (four) {
      const y = Number(four[1]);
      if (y > latestYear) {
        latestYear = y;
        latestMonth = 12;
      }
    }
  }
  if (latestYear === 0) return new Date().toISOString().split('T')[0];
  return `${latestYear}-${String(latestMonth || 1).padStart(2, '0')}-01`;
}

export default router;
