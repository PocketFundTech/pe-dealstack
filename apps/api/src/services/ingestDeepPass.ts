// ─── Post-ingest deep pass: financial extraction + auto-score ─────────
// Fired in the background (utils/background.ts runInBackground) after an
// ingest creates/updates a deal, so a freshly-ingested CIM arrives with
// FinancialStatement rows, red-flag analysis inputs, and a scorecard —
// instead of looking empty until someone hits Re-extract.
//
// Engine-agnostic: runFinancialAgent respects EXTRACTION_ENGINE internally
// (claude native PDF / container spreadsheets when flipped, legacy chain
// otherwise), so this improves ingest regardless of flag state.
// Failures are logged and never affect the ingest response — identical to
// the pre-existing behavior where financials simply didn't exist yet.

import { runFinancialAgent, type FileType } from './agents/financialAgent/index.js';
import { acquireExtractionSlot, acquireExtractionSlotBy, releaseExtractionSlot } from './agents/financialAgent/concurrency.js';

/** Background wait for an extraction slot before giving up (fix plan B3). */
const INGEST_SLOT_WAIT_MS = 120_000;
import { maybeScoreAfterExtraction } from './agents/dealScorecard/index.js';
import { isExcelFile } from './excelFinancialExtractor.js';
import { log } from '../utils/logger.js';

export interface IngestDeepPassInput {
  dealId: string;
  orgId: string;
  documentId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}

/**
 * Only spreadsheets (Excel / CSV) carry the deep financials (P&L, balance
 * sheet, cash flow) — founder decision 2026-10-06. PDFs (CIMs, teasers)
 * get the cheap deal-summary read only, never a Fable extraction run; the
 * Re-extract button can still force one on any file.
 */
export function shouldRunIngestDeepPass(mimeType: string, fileName: string): boolean {
  return isExcelFile(mimeType, fileName);
}

export async function runIngestDeepPass(input: IngestDeepPassInput): Promise<void> {
  const { dealId, orgId, documentId, fileBuffer, fileName, mimeType } = input;

  // Runs in the background (runInBackground), so it can afford to queue for
  // a slot — skipping meant a multi-file "New deal" upload extracted only
  // two documents. Give up only near the function's time limit.
  if (!(await acquireExtractionSlotBy(orgId, Date.now() + INGEST_SLOT_WAIT_MS))) {
    // Still no slot — skip; the user can Re-extract manually.
    log.warn('Ingest deep pass skipped — org at extraction concurrency cap', { dealId, documentId, orgId });
    return;
  }

  let extracted = false;
  try {
    const fileType: FileType = isExcelFile(mimeType, fileName) ? 'excel' : 'pdf';
    log.info('Ingest deep pass starting', { dealId, documentId, fileName, fileType });
    const result = await runFinancialAgent({
      dealId,
      documentId,
      fileBuffer,
      fileName,
      fileType,
      organizationId: orgId,
    });
    extracted = result.status === 'completed';
    log.info('Ingest deep pass complete', {
      dealId,
      documentId,
      status: result.status,
      statementsStored: result.statementIds.length,
      periodsStored: result.periodsStored,
      overallConfidence: result.overallConfidence,
    });
  } catch (err) {
    log.error('Ingest deep pass failed', err, { dealId, documentId });
  } finally {
    releaseExtractionSlot(orgId);
  }

  if (extracted) {
    // Already a silent no-op without configured criteria, and never throws.
    void maybeScoreAfterExtraction(dealId, orgId);
  }
}
