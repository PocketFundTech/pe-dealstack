import { Router } from 'express';
import { z } from 'zod';
import { createRequire } from 'module';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { runDeepPass } from '../services/financialExtractionOrchestrator.js';
import { classifyFinancialsVision } from '../services/visionExtractor.js';
import { extractTextFromExcel, isExcelFile } from '../services/excelFinancialExtractor.js';
import { validateStatements } from '../services/financialValidator.js';
import { extractTablesFromPdf, isAzureConfigured } from '../services/azureDocIntelligence.js';
import type { ClassifiedStatement } from '../services/financialClassifier.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { runFinancialAgent } from '../services/agents/financialAgent/index.js';
import type { FileType } from '../services/agents/financialAgent/index.js';
import {
  acquireExtractionSlot, acquireExtractionSlotBy, releaseExtractionSlot, MAX_CONCURRENT_PER_ORG,
} from '../services/agents/financialAgent/concurrency.js';
import { extractionOrder } from '../services/financialSourceAuthority.js';
import { mapWithConcurrencyLimit } from '../utils/limitConcurrency.js';
import { downloadFileBuffer, extractStoragePath } from '../utils/storage.js';
import { maybeScoreAfterExtraction } from '../services/agents/dealScorecard/index.js';
import { maybeReactivateAfterExtraction } from '../services/agents/dealReactivation/index.js';
import { isFinancialDoc, buildResultWarnings } from './financials-extraction-utils.js';
import { publicErrorMessage } from '../utils/aiErrors.js';
import { setDocExtraction, getRunProgress } from '../services/extractionProgress.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────

/** Download a file from Supabase storage (supports both storage paths and legacy full URLs) */
async function fetchBuffer(fileUrlOrPath: string): Promise<Buffer | null> {
  return downloadFileBuffer(fileUrlOrPath);
}

/** Extract text from a PDF stored in Supabase */
async function extractTextFromUrl(fileUrl: string): Promise<string | null> {
  const buffer = await fetchBuffer(fileUrl);
  if (!buffer) return null;
  try {
    const data = await pdfParse(buffer);
    return data.text || null;
  } catch (err) {
    log.error('PDF parse error in financials route', err);
    return null;
  }
}

/** Convert DB FinancialStatement rows back into ClassifiedStatement[] for validation */
function rowsToClassifiedStatements(rows: any[]): ClassifiedStatement[] {
  const byType = new Map<string, ClassifiedStatement>();

  for (const row of rows) {
    if (!byType.has(row.statementType)) {
      byType.set(row.statementType, {
        statementType: row.statementType,
        unitScale: row.unitScale,
        currency: row.currency,
        periods: [],
      });
    }
    byType.get(row.statementType)!.periods.push({
      period: row.period,
      periodType: row.periodType,
      lineItems: row.lineItems as Record<string, number | null>,
      confidence: row.extractionConfidence,
    });
  }

  return Array.from(byType.values());
}

/** Detect file type for the financial agent */
function detectFileType(mimeType?: string | null, fileName?: string | null): FileType {
  if (isExcelFile(mimeType, fileName)) return 'excel';
  return 'pdf';
}

// ─── Validation Schemas ───────────────────────────────────────

const extractSchema = z.object({
  documentId: z.string().uuid().optional(),
  documentType: z.enum(['financial_statements', 'payment_data', 'bank_statement', 'accounting_export', 'auto_detect']).optional().default('auto_detect'),
  // 'single'         — most-recent CIM/FINANCIALS, fallback to any (default, BC).
  // 'all_financials' — every CIM/FINANCIALS doc on the deal, sequentially.
  // 'all'            — every doc on the deal regardless of type.
  // Always coerced to 'single' when documentId is provided.
  mode: z.enum(['single', 'all_financials', 'all']).optional().default('single'),
  // Multi-doc continuation: restrict the batch to these documents (the
  // `pendingDocumentIds` a previous call couldn't reach in its time budget).
  documentIds: z.array(z.string().uuid()).max(200).optional(),
  // Client-generated id for live per-document progress (QA #12).
  runId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

// Per-doc helper: runs slot acquire/release + runFinancialAgent for one doc
// and returns a normalized record for the aggregate response.

interface PerDocResult {
  id: string;
  name: string;
  /** 'pending' = queued but not reached within this request's time budget — send it again. */
  status: 'completed' | 'failed' | 'skipped_no_slot' | 'pending';
  statementsStored: number;
  periodsStored: number;
  overallConfidence: number | null;
  hasConflicts: boolean;
  extractionMethod?: string;
  agent?: any;
  error?: string;
  /** Agent-level warnings (e.g. "no CASH_FLOW statement found") — always present. */
  warnings: string[];
}

async function processOneDoc(
  doc: { id: string; fileUrl: string; name: string | null; type?: string | null; mimeType?: string | null },
  dealId: string,
  orgId: string,
  /** Multi-doc: wait for a slot until this time (epoch ms) instead of skipping. */
  slotDeadline?: number,
): Promise<PerDocResult> {
  const baseName = doc.name ?? 'document';
  const fail = (status: 'failed' | 'skipped_no_slot' | 'pending', error: string): PerDocResult => ({
    id: doc.id, name: baseName, status, statementsStored: 0, periodsStored: 0, overallConfidence: null, hasConflicts: false, error, warnings: [],
  });

  const fileBuffer = await fetchBuffer(doc.fileUrl);
  if (!fileBuffer) return fail('failed', 'Could not download document file');
  if (slotDeadline !== undefined) {
    if (!(await acquireExtractionSlotBy(orgId, slotDeadline))) {
      return fail('pending', 'Queued — not reached in this request');
    }
  } else if (!acquireExtractionSlot(orgId)) {
    return fail('skipped_no_slot', 'Extraction slot unavailable');
  }

  try {
    const agentResult = await runFinancialAgent({
      dealId,
      documentId: doc.id,
      fileBuffer,
      fileName: baseName,
      fileType: detectFileType(doc.mimeType, doc.name),
      organizationId: orgId,
    });
    return {
      id: doc.id,
      name: baseName,
      status: agentResult.status === 'completed' ? 'completed' : 'failed',
      statementsStored: agentResult.statementIds.length,
      periodsStored: agentResult.periodsStored,
      overallConfidence: agentResult.overallConfidence,
      hasConflicts: agentResult.hasConflicts,
      extractionMethod: agentResult.extractionSource,
      agent: {
        status: agentResult.status,
        retryCount: agentResult.retryCount,
        validationResult: agentResult.validationResult,
        steps: agentResult.steps,
        error: agentResult.error,
        crossVerifyResult: agentResult.crossVerifyResult || null,
      },
      error: agentResult.error ?? undefined,
      warnings: agentResult.warnings ?? [],
    };
  } catch (err: any) {
    log.error('processOneDoc failed', { dealId, docId: doc.id, err: err?.message });
    return fail('failed', err?.message ?? 'Agent run failed');
  } finally {
    releaseExtractionSlot(orgId);
  }
}

// ─── 5d: POST /api/deals/:dealId/financials/extract ──────────
// Trigger financial agent extraction on a deal's documents

router.post('/deals/:dealId/financials/extract', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { documentId, documentType, mode, documentIds, runId } = extractSchema.parse(req.body);
    const requestStartedAt = Date.now();

    // Resolve target documents based on mode + documentId precedence.
    // documentId always wins (single-doc behaviour) regardless of mode.
    let docs: any[] = [];
    let effectiveMode: 'single' | 'all_financials' | 'all' = mode;

    if (documentId) {
      effectiveMode = 'single';
      const { data } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType, createdAt')
        .eq('id', documentId)
        .eq('dealId', dealId)
        .single();
      if (data) docs = [data];
    } else if (mode === 'all_financials') {
      // Pull every doc, then JS-filter for "looks-financial" (type-tagged
      // OR spreadsheet-mimeType OR PDF whose filename screams "P&L"). The
      // earlier `.in('type', [...])` filter skipped uploads classified as
      // OTHER — common for files like "Master Sheet.xlsx" or
      // "Mind Movies 2024 Profit and Loss.pdf" that the classifier missed.
      //
      // Fallback: if the predicate matches NOTHING but the deal has docs
      // with fileUrls, treat the request as `mode === 'all'` so we don't
      // 404. Better to extract from a possibly-wrong doc and let the agent
      // bail with a clear reason than to tell the user "no document found"
      // when their P&L PDF is sitting right there.
      const { data } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType, createdAt')
        .eq('dealId', dealId)
        .order('createdAt', { ascending: false });
      const withFileUrl = (data ?? []).filter((d) => !!d.fileUrl);
      const filtered = withFileUrl.filter((d) => isFinancialDoc(d));
      if (filtered.length > 0) {
        docs = filtered;
      } else if (withFileUrl.length > 0) {
        log.warn('all_financials fallback: no financial-shaped docs, using all docs with fileUrl', {
          dealId,
          docCount: withFileUrl.length,
        });
        docs = withFileUrl;
      }
    } else if (mode === 'all') {
      const { data } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType, createdAt')
        .eq('dealId', dealId)
        .order('createdAt', { ascending: false });
      docs = (data ?? []).filter((d) => !!d.fileUrl);
    } else {
      // mode === 'single': prefer most recent financial-shaped doc
      // (type CIM/FINANCIALS or spreadsheet mimeType). Fallback to any.
      const { data: allDocs } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType, createdAt')
        .eq('dealId', dealId)
        .order('createdAt', { ascending: false });
      const financialDocs = (allDocs ?? []).filter((d) => !!d.fileUrl && isFinancialDoc(d));
      if (financialDocs.length > 0) {
        docs = [financialDocs[0]];
      } else if (allDocs && allDocs.length > 0) {
        const fallback = allDocs.find((d) => !!d.fileUrl);
        if (fallback) docs = [fallback];
      }
    }

    if (effectiveMode !== 'single') {
      if (documentIds && documentIds.length > 0) {
        const wanted = new Set(documentIds);
        docs = docs.filter((d) => wanted.has(d.id));
      }
      // Reported statements first, narrative docs next, derived valuation
      // models last — so the budget is spent on the authoritative sources.
      // (Array.prototype.sort is stable: newest-first is kept within a tier.)
      docs = [...docs].sort((a, b) => extractionOrder(a) - extractionOrder(b));
    }

    if (docs.length === 0 || !docs[0]?.fileUrl) {
      return res.status(404).json({ error: 'No document found to extract from' });
    }

    // CSV-style parsers (payment/bank/accounting) are single-doc only — explicit
    // user choices, no multi-doc loop. Preserves pre-existing single-doc shape.
    if (
      effectiveMode === 'single' &&
      (documentType === 'payment_data' || documentType === 'bank_statement' || documentType === 'accounting_export')
    ) {
      const doc = docs[0];
      const fileBuffer = await fetchBuffer(doc.fileUrl);
      if (!fileBuffer) {
        return res.status(422).json({ error: 'Could not download document file' });
      }

      let result;
      let method = 'csv_parser';

      if (documentType === 'payment_data') {
        const { parsePaymentData } = await import('../services/parsers/parserRouter.js');
        result = await parsePaymentData(fileBuffer, doc.name, dealId, doc.id);
      } else if (documentType === 'bank_statement') {
        const { parseBankCSV } = await import('../services/parsers/bankParser.js');
        result = await parseBankCSV(fileBuffer, doc.name, dealId, doc.id);
        method = 'bank_parser';
      } else {
        const { parseAccountingCSV } = await import('../services/parsers/accountingParser.js');
        result = await parseAccountingCSV(fileBuffer, doc.name, dealId, doc.id);
        method = 'accounting_parser';
      }

      return res.json({
        success: true,
        mode: effectiveMode,
        documentUsed: { id: doc.id, name: doc.name },
        documentsProcessed: [
          {
            id: doc.id,
            name: doc.name ?? 'document',
            status: 'completed',
            statementsStored: result.periodsStored,
            periodsStored: result.periodsStored,
            overallConfidence: 100,
          },
        ],
        extractionMethod: method,
        result: {
          statementsStored: result.periodsStored,
          periodsStored: result.periodsStored,
          documentsUsed: 1,
          documentsFailed: 0,
          overallConfidence: 100,
          statementIds: result.statementIds,
          warnings: result.warnings,
          hasConflicts: false,
        },
        hasConflicts: false,
        agent: { status: 'completed', retryCount: 0, steps: result.steps },
      });
    }

    // Agent-based extraction. Each doc acquires/releases its own slot inside
    // processOneDoc, keeping the 2-concurrent-per-org invariant.
    //
    // Single-mode: surface 429 up-front if no slot (BC). Multi-doc modes:
    // record 'skipped_no_slot' per doc and continue.
    //
    // Multi-doc execution: PARALLEL via Promise.allSettled so total wall time
    // is max(t1, t2, ...) instead of t1+t2+... — sequential blew the 300s
    // Vercel function limit when both a CIM (250s) and a 36-month XLSX (290s)
    // were on the same deal. Each doc also wrapped in a per-doc timeout
    // race so a single runaway doc can't take down the whole batch — when the
    // timeout fires we mark that doc 'timeout' and let the others continue.
    const perDoc: PerDocResult[] = [];

    // Per-doc time budget. 240s leaves ~60s headroom under Vercel's 300s
    // hard limit for response serialization, slot release, etc.
    const PER_DOC_BUDGET_MS = 240_000;
    // Whole-request budget for the multi-doc queue, and the least time a doc
    // needs left to be worth starting (most finish in 30-90s; the cache
    // makes a re-sent doc near-instant).
    const REQUEST_BUDGET_MS = 270_000;
    const MIN_DOC_START_BUDGET_MS = 75_000;

    const withDocTimeout = (
      doc: { id: string; fileUrl: string; name: string | null; type?: string | null; mimeType?: string | null },
      budgetMs: number = PER_DOC_BUDGET_MS,
      slotDeadline?: number,
    ): Promise<PerDocResult> => {
      const baseName = doc.name ?? 'document';
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<PerDocResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
          log.warn('Per-doc extraction timeout — abandoning so others can complete', {
            dealId, docId: doc.id, budgetMs,
          });
          resolve({
            id: doc.id,
            name: baseName,
            status: 'failed',
            statementsStored: 0,
            periodsStored: 0,
            overallConfidence: null,
            hasConflicts: false,
            error: `Extraction exceeded ${Math.round(budgetMs / 1000)}s per-doc budget`,
            warnings: [],
          });
        }, budgetMs);
      });
      return Promise.race([processOneDoc(doc, dealId, orgId, slotDeadline), timeoutPromise])
        .finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle); });
    };

    if (effectiveMode === 'single') {
      // Single-doc: keep the up-front 429 check (BC contract for callers).
      if (!acquireExtractionSlot(orgId)) {
        return res.status(429).json({
          error: 'Too many concurrent extractions. Please wait for the current extraction to complete.',
        });
      }
      releaseExtractionSlot(orgId); // processOneDoc re-acquires its own slot.
      const r = await withDocTimeout(docs[0]);
      perDoc.push(r);
      if (r.status !== 'completed') {
        log.warn('Per-doc extraction issue', { dealId, docId: docs[0].id, status: r.status, error: r.error });
      }
    } else {
      // Multi-doc modes: a bounded QUEUE, not a race for slots. Previously
      // every doc ran at once and all but two came back 'skipped_no_slot'
      // — on the SRM deal the two that won were the smallest files (the
      // valuation summary). Now at most MAX_CONCURRENT_PER_ORG run at a
      // time, each waiting its turn. The request is still capped by the
      // 300s function limit, so a doc is only STARTED while enough budget
      // remains; the rest come back 'pending' and the client re-sends them
      // (pendingDocumentIds). Already-extracted docs hit the extraction
      // cache on a re-run, so a continuation doesn't redo work.
      const requestDeadline = requestStartedAt + REQUEST_BUDGET_MS;
      await setDocExtraction(docs.map((d) => d.id), runId, 'queued');
      const pending = (doc: (typeof docs)[number]): PerDocResult => ({
        id: doc.id, name: doc.name ?? 'document', status: 'pending',
        statementsStored: 0, periodsStored: 0, overallConfidence: null, hasConflicts: false,
        error: 'Queued — not reached in this request', warnings: [],
      });
      const settled = await mapWithConcurrencyLimit(docs, MAX_CONCURRENT_PER_ORG, async (doc) => {
        const startBy = requestDeadline - MIN_DOC_START_BUDGET_MS;
        if (Date.now() > startBy) {
          await setDocExtraction([doc.id], runId, 'pending');
          return pending(doc);
        }
        await setDocExtraction([doc.id], runId, 'running');
        const r = await withDocTimeout(doc, Math.min(PER_DOC_BUDGET_MS, requestDeadline - Date.now()), startBy);
        await setDocExtraction([doc.id], runId, r.status === 'completed' ? 'done' : r.status === 'pending' ? 'pending' : 'failed', {
          periodsStored: r.periodsStored,
          ...(r.status === 'failed' && r.error ? { error: r.error.slice(0, 200) } : {}),
        });
        return r;
      });
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const doc = docs[i];
        const baseName = doc.name ?? 'document';
        if (s.status === 'fulfilled') {
          perDoc.push(s.value);
          if (s.value.status !== 'completed') {
            log.warn('Per-doc extraction issue', { dealId, docId: doc.id, status: s.value.status, error: s.value.error });
          }
        } else {
          // Promise.allSettled fulfilled with rejected — should be rare since
          // processOneDoc + withDocTimeout both catch internally. Capture
          // anyway as a defensive belt-and-suspenders.
          perDoc.push({
            id: doc.id, name: baseName, status: 'failed',
            statementsStored: 0, periodsStored: 0,
            overallConfidence: null, hasConflicts: false,
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            warnings: [],
          });
          log.error('Per-doc extraction rejected', { dealId, docId: doc.id, err: s.reason });
        }
      }
    }

    const totals = perDoc.reduce(
      (acc, r) => {
        acc.statementsStored += r.statementsStored;
        acc.periodsStored += r.periodsStored;
        if (r.status === 'completed') acc.documentsUsed += 1;
        else if (r.status === 'pending') acc.documentsPending += 1;
        else acc.documentsFailed += 1;
        if (r.hasConflicts) acc.hasConflicts = true;
        return acc;
      },
      { statementsStored: 0, periodsStored: 0, documentsUsed: 0, documentsFailed: 0, documentsPending: 0, hasConflicts: false },
    );

    const aggregateSuccess = perDoc.some((r) => r.status === 'completed');
    // Prod incident (2026-09-28): every doc failed (timeout / provider
    // credit exhaustion) but the response still looked like a benign
    // "0 periods found" — `allFailed` lets the frontend distinguish "no
    // financial data in otherwise-successful docs" from "extraction itself
    // never worked". HTTP status stays 200 (BC — callers already branch on
    // `success` / `periodsStored`, not status code).
    const pendingDocumentIds = perDoc.filter((r) => r.status === 'pending').map((r) => r.id);
    const allFailed = perDoc.length > 0 && !aggregateSuccess && pendingDocumentIds.length < perDoc.length;
    // Pending docs aren't failures — don't warn about them.
    const resultWarnings = buildResultWarnings(perDoc.filter((r) => r.status !== 'pending'));

    // Single-doc back-compat: flat fields alongside the new aggregate.
    const first = perDoc[0];
    const singleDocFields =
      effectiveMode === 'single' && first
        ? { documentUsed: { id: first.id, name: first.name }, extractionMethod: first.extractionMethod, agent: first.agent ?? null }
        : {};

    // Fire-and-forget: re-score the deal against firm criteria now that
    // fresh financials exist. Never awaited, never affects this response.
    if (aggregateSuccess) {
      void maybeScoreAfterExtraction(dealId, orgId);
      // Dormant deals take the reactivation path instead — fresh financials
      // on a passed deal are the strongest "look again" signal there is.
      void maybeReactivateAfterExtraction(dealId, orgId);
    }

    return res.json({
      success: aggregateSuccess,
      mode: effectiveMode,
      ...singleDocFields,
      documentsProcessed: perDoc.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        statementsStored: r.statementsStored,
        periodsStored: r.periodsStored,
        overallConfidence: r.overallConfidence,
        agent: r.agent ?? null,
        ...(r.error ? { error: r.error } : {}),
      })),
      result: {
        statementsStored: totals.statementsStored,
        periodsStored: totals.periodsStored,
        documentsUsed: totals.documentsUsed,
        documentsFailed: totals.documentsFailed,
        documentsPending: totals.documentsPending,
        overallConfidence: first?.overallConfidence ?? null,
        hasConflicts: totals.hasConflicts,
        warnings: resultWarnings,
        allFailed,
      },
      hasConflicts: totals.hasConflicts,
      // Re-send these (mode all_financials + documentIds) to continue the batch.
      pendingDocumentIds,
    });
  } catch (err: any) {
    log.error('POST financials extract error', err);
    const status = err.message?.includes('Could not') || err.message?.includes('appears empty') ? 422 : 500;
    const pub = publicErrorMessage(err, 'Financial extraction failed');
    res.status(pub.statusCode ?? status).json({ error: pub.message, code: pub.code });
  }
});

// ─── GET /api/deals/:dealId/financials/extraction-progress?runId= ──
// Live per-document progress of an "Extract all" run (QA #12). The page
// polls this while its extract request is in flight.
router.get('/deals/:dealId/financials/extraction-progress', async (req, res) => {
  try {
    const { dealId } = req.params;
    const runId = String(req.query.runId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(runId)) return res.status(400).json({ error: 'runId is required' });
    const orgId = getOrgId(req);
    if (!(await verifyDealAccess(dealId, orgId))) return res.status(404).json({ error: 'Deal not found' });
    res.json(await getRunProgress(dealId, runId));
  } catch (err: any) {
    log.error('extraction progress error', err);
    res.status(500).json({ error: 'Failed to read extraction progress' });
  }
});

// ─── 5e: GET /api/deals/:dealId/financials/validation ────────
// Run validation checks on stored statements + return red flags

router.get('/deals/:dealId/financials/validation', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { data: rows, error } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('statementType', { ascending: true })
      .order('period', { ascending: true });

    if (error) throw error;

    if (!rows || rows.length === 0) {
      return res.json({
        hasData: false,
        checks: [],
        errorCount: 0,
        warningCount: 0,
        overallPassed: true,
      });
    }

    const statements = rowsToClassifiedStatements(rows);
    const result = validateStatements(statements);

    // Only return failed checks to the client — passed checks are noise
    const flagged = result.checks.filter(c => !c.passed);

    res.json({
      hasData: true,
      checks: flagged,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      infoCount: result.infoCount,
      overallPassed: result.overallPassed,
    });
  } catch (err) {
    log.error('GET financials validation error', err);
    res.status(500).json({ error: 'Failed to run validation' });
  }
});

// ─── 2: POST /api/documents/:documentId/extract-financials ────
// Document-level extraction — looks up dealId from the document itself.

router.post('/documents/:documentId/extract-financials', async (req, res) => {
  try {
    const { documentId } = req.params;

    const { data: doc } = await supabase
      .from('Document')
      .select('id, fileUrl, name, type, mimeType, dealId')
      .eq('id', documentId)
      .single();

    if (!doc?.fileUrl || !doc?.dealId) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(doc.dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    // Download file buffer for the agent
    const fileBuffer = await fetchBuffer(doc.fileUrl);
    if (!fileBuffer) {
      return res.status(422).json({ error: 'Could not download document file' });
    }

    // Run the LangGraph financial agent
    if (!acquireExtractionSlot(orgId)) {
      return res.status(429).json({
        error: 'Too many concurrent extractions. Please wait for the current extraction to complete.',
      });
    }

    const forceExtraction =
      req.query.force === 'true' ||
      req.query.force === '1' ||
      req.body?.force === true;

    let agentResult;
    try {
      agentResult = await runFinancialAgent({
        dealId: doc.dealId,
        documentId: doc.id,
        fileBuffer,
        fileName: doc.name ?? 'document',
        fileType: detectFileType(doc.mimeType, doc.name),
        organizationId: orgId,
        forceExtraction,
      });
    } finally {
      releaseExtractionSlot(orgId);
    }

    // Fire-and-forget: re-score the deal against firm criteria now that
    // fresh financials exist. Never awaited, never affects this response.
    if (agentResult.status === 'completed') {
      void maybeScoreAfterExtraction(doc.dealId, orgId);
      void maybeReactivateAfterExtraction(doc.dealId, orgId);
    }

    res.json({
      success: agentResult.status === 'completed',
      documentUsed: { id: doc.id, name: doc.name },
      dealId: doc.dealId,
      extractionMethod: agentResult.extractionSource,
      fromCache: agentResult.fromCache,
      result: {
        statementsStored: agentResult.statementIds.length,
        periodsStored: agentResult.periodsStored,
        overallConfidence: agentResult.overallConfidence,
        statementIds: agentResult.statementIds,
        warnings: agentResult.warnings,
        hasConflicts: agentResult.hasConflicts,
      },
      agent: {
        status: agentResult.status,
        retryCount: agentResult.retryCount,
        validationResult: agentResult.validationResult,
        steps: agentResult.steps,
        error: agentResult.error,
        fromCache: agentResult.fromCache,
        crossVerifyResult: agentResult.crossVerifyResult || null,
      },
    });
  } catch (err: any) {
    log.error('POST document extract-financials error', err);
    const status = err.message?.includes('Could not') || err.message?.includes('appears empty') ? 422 : 500;
    const pub = publicErrorMessage(err, 'Financial extraction failed');
    res.status(pub.statusCode ?? status).json({ error: pub.message, code: pub.code });
  }
});

export default router;
