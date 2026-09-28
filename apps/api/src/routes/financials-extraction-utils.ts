/**
 * Shared helpers for financials-extraction.ts. Split out so the route file
 * stays under the 500-line repo cap.
 */

import { classifyProviderRejection } from '../utils/aiErrors.js';

// Prod incident (2026-09-28): both docs on a deal failed extraction — one
// with a 120s agent timeout, one with an Anthropic 400 "credit balance is
// too low" — but the multi-doc route only ever surfaced periodsStored: 0
// with a generic "No financial data found" toast. The real reason (never
// the user's fault in either case) was thrown away. These helpers turn a
// raw per-doc error/agent-warning into a short, human sentence and
// aggregate them into `result.warnings` for the response.

const CREDIT_OUT_MESSAGE =
  'The AI provider account is out of credits. This is not a problem with your documents — contact your administrator.';
const TIMEOUT_MESSAGE =
  'Extraction took too long and was stopped. Try again, or extract one document at a time.';

/**
 * Convert a raw per-doc extraction error string into a short, human
 * sentence. Reuses classifyProviderRejection (aiErrors.ts) for provider
 * billing/auth/quota rejections; falls back to a timeout-phrase check for
 * the per-doc / agent timeout paths (those never reach classifyProviderRejection
 * since they're thrown by our own code, not the SDK). Anything else passes
 * through unchanged — better a raw-but-real reason than a fabricated one.
 */
export function humanizeExtractionError(rawError: string): string {
  const rejection = classifyProviderRejection(new Error(rawError));
  if (rejection?.reason === 'quota') return CREDIT_OUT_MESSAGE;
  if (/timed out|timeout|exceeded .*(budget|ms)/i.test(rawError)) return TIMEOUT_MESSAGE;
  return rawError;
}

/** Minimal per-doc shape buildResultWarnings needs — matches PerDocResult. */
export interface WarningSourceDoc {
  name: string;
  status: 'completed' | 'failed' | 'skipped_no_slot';
  error?: string;
  warnings?: string[];
}

/**
 * Build `result.warnings` for the multi-doc extract response: one humanized
 * entry per failed/skipped document, plus any agent-level warnings from
 * every document (including ones that completed successfully — e.g. "no
 * CASH_FLOW statement found"). Document names are only prefixed when more
 * than one document was processed, so the single-doc case reads cleanly.
 */
export function buildResultWarnings(docs: WarningSourceDoc[]): string[] {
  const multi = docs.length > 1;
  const warnings: string[] = [];
  for (const doc of docs) {
    if (doc.status !== 'completed') {
      const reason = doc.error ? humanizeExtractionError(doc.error) : 'Extraction failed for this document';
      warnings.push(multi ? `${doc.name}: ${reason}` : reason);
    }
    for (const w of doc.warnings ?? []) {
      warnings.push(multi ? `${doc.name}: ${w}` : w);
    }
  }
  return warnings;
}

/**
 * Filename signals that a PDF is a financial statement. Catches CIM-adjacent
 * docs that got auto-tagged OTHER because the classifier didn't have a
 * spreadsheet/CIM keyword to latch onto (e.g. "Mind Movies 2024/2025 Profit
 * and Loss.pdf" — pure P&L, came in as type=OTHER, mimeType=application/pdf).
 *
 * Flexible whitespace, optional `&` / `and`. Case-insensitive.
 * Keep this regex in sync with `isFinancialShaped` in
 * apps/web-next/src/app/(app)/deals/[id]/deal-financials-reextract-list.tsx.
 */
export const FINANCIAL_STATEMENT_FILENAME_PATTERN =
  /\b(?:profit\s*(?:&|and)\s*loss|p\s*(?:&|and)\s*l|income\s*statement|statement\s+of\s+(?:operations|income|cash\s+flows?)|balance\s+sheet|cash\s+flows?)\b/i;

/**
 * "Financial-shaped" predicate for filtering Documents during re-extract.
 * Returns true for:
 *   1. Type-tagged docs: CIM, FINANCIALS, EXCEL, plus financial-statement tags
 *      (PROFIT_LOSS, BALANCE_SHEET, CASH_FLOW, INCOME_STATEMENT).
 *   2. Spreadsheet file extensions (.xlsx / .xls / .csv).
 *   3. Spreadsheet / Excel / CSV mimeTypes.
 *   4. PDFs whose filename matches FINANCIAL_STATEMENT_FILENAME_PATTERN —
 *      handles P&L / income / balance sheet / cash flow PDFs that the
 *      classifier dropped into OTHER.
 *
 * Permissive on purpose — older uploads may have been auto-classified as
 * OTHER when the filename had no obvious keyword. Without this fallback,
 * Re-extract silently skips them and the deal looks like it has no
 * financial data.
 */
export function isFinancialDoc(d: {
  type: string | null;
  name: string | null;
  mimeType: string | null;
}): boolean {
  const t = (d.type ?? '').toUpperCase();
  if (
    t === 'CIM' ||
    t === 'FINANCIALS' ||
    t === 'EXCEL' ||
    t === 'PROFIT_LOSS' ||
    t === 'BALANCE_SHEET' ||
    t === 'CASH_FLOW' ||
    t === 'INCOME_STATEMENT'
  ) return true;
  const n = (d.name ?? '').toLowerCase();
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) return true;
  const m = (d.mimeType ?? '').toLowerCase();
  if (
    m.includes('spreadsheet') ||
    m.includes('excel') ||
    m === 'text/csv' ||
    m === 'application/csv'
  ) return true;
  if (m === 'application/pdf' && FINANCIAL_STATEMENT_FILENAME_PATTERN.test(d.name ?? '')) return true;
  return false;
}
