/**
 * Shared helpers for financials-extraction.ts. Split out so the route file
 * stays under the 500-line repo cap.
 */

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
