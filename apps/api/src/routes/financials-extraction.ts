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
import { acquireExtractionSlot, releaseExtractionSlot } from '../services/agents/financialAgent/concurrency.js';
import { downloadFileBuffer, extractStoragePath } from '../utils/storage.js';

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
});

// ─── 5d: POST /api/deals/:dealId/financials/extract ──────────
// Trigger financial agent extraction on a deal's documents

router.post('/deals/:dealId/financials/extract', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { documentId, documentType } = extractSchema.parse(req.body);

    // Find the document to extract from
    let doc: any = null;

    if (documentId) {
      const { data } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType')
        .eq('id', documentId)
        .eq('dealId', dealId)
        .single();
      doc = data;
    } else {
      // Prefer most recent CIM or FINANCIALS document
      const { data } = await supabase
        .from('Document')
        .select('id, fileUrl, name, type, mimeType')
        .eq('dealId', dealId)
        .in('type', ['CIM', 'FINANCIALS'])
        .order('createdAt', { ascending: false })
        .limit(1)
        .single();
      doc = data;

      if (!doc) {
        const { data: anyDoc } = await supabase
          .from('Document')
          .select('id, fileUrl, name, type, mimeType')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false })
          .limit(1)
          .single();
        doc = anyDoc;
      }
    }

    if (!doc?.fileUrl) {
      return res.status(404).json({ error: 'No document found to extract from' });
    }

    // Download file buffer for the agent
    const fileBuffer = await fetchBuffer(doc.fileUrl);
    if (!fileBuffer) {
      return res.status(422).json({ error: 'Could not download document file' });
    }

    // Route to appropriate parser based on document type
    if (documentType === 'payment_data' || documentType === 'bank_statement' || documentType === 'accounting_export') {
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
        documentUsed: { id: doc.id, name: doc.name },
        extractionMethod: method,
        result: {
          statementsStored: result.periodsStored,
          periodsStored: result.periodsStored,
          overallConfidence: 100,
          statementIds: result.statementIds,
          warnings: result.warnings,
          hasConflicts: false,
        },
        hasConflicts: false,
        agent: { status: 'completed', retryCount: 0, steps: result.steps },
      });
    }

    // For financial_statements, auto_detect, or unsupported types: use existing agent
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
        dealId,
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

    res.json({
      success: agentResult.status === 'completed',
      documentUsed: { id: doc.id, name: doc.name },
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
      hasConflicts: agentResult.hasConflicts,
      // Agent-specific fields (new)
      agent: {
        status: agentResult.status,
        retryCount: agentResult.retryCount,
        validationResult: agentResult.validationResult,
        steps: agentResult.steps,
        error: agentResult.error,
        crossVerifyResult: agentResult.crossVerifyResult || null,
        fromCache: agentResult.fromCache,
      },
    });
  } catch (err: any) {
    log.error('POST financials extract error', err);
    const status = err.message?.includes('Could not') || err.message?.includes('appears empty') ? 422 : 500;
    res.status(status).json({ error: err.message ?? 'Financial extraction failed' });
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
    res.status(status).json({ error: err.message ?? 'Financial extraction failed' });
  }
});

export default router;
