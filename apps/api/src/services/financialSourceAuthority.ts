/**
 * Financial source authority.
 * ===========================
 *
 * When two documents extract the SAME period (e.g. a P&L spreadsheet and a CIM
 * both report 2024 revenue), which one owns the active FinancialStatement row?
 * Confidence alone is wrong — a polished CIM often scores HIGHER than the raw
 * spreadsheet, yet the spreadsheet is the authoritative financial record. So we
 * rank by SOURCE TYPE first: a dedicated financials spreadsheet outranks a
 * narrative deal doc (CIM / teaser / LOI), which outranks anything else.
 *
 * Mirrors the isFinancialDoc / isNarrativeDoc heuristic in
 * quantitativeReconciler.ts (type → mimeType → filename fallback) so the two
 * stay consistent.
 */

export interface DocAuthorityMeta {
  type?: string | null;
  mimeType?: string | null;
  name?: string | null;
}

export const SOURCE_AUTHORITY = {
  /** Dedicated financial statements — spreadsheet/CSV. Authoritative for numbers. */
  FINANCIAL_SHEET: 3,
  /** Narrative deal doc (CIM / teaser / LOI) — contains financials but secondary. */
  NARRATIVE: 2,
  /** Unknown / other. */
  OTHER: 1,
} as const;

/**
 * Rank a document as a source of financial numbers. Higher wins.
 * Pure and total — undefined/empty metadata ranks OTHER.
 */
export function financialSourceAuthorityRank(doc: DocAuthorityMeta | null | undefined): number {
  if (!doc) return SOURCE_AUTHORITY.OTHER;
  const t = (doc.type ?? '').toUpperCase();
  const m = (doc.mimeType ?? '').toLowerCase();
  const n = (doc.name ?? '').toLowerCase();

  // Financial spreadsheet — the authoritative numeric source.
  if (t === 'FINANCIALS' || t === 'EXCEL') return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  if (m.includes('spreadsheet') || m.includes('excel') || m.includes('csv')) {
    return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  }
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) {
    return SOURCE_AUTHORITY.FINANCIAL_SHEET;
  }

  // Narrative deal documents — contain financials but are secondary to the sheet.
  if (t === 'CIM' || t === 'TEASER' || t === 'LOI') return SOURCE_AUTHORITY.NARRATIVE;
  if (m.includes('pdf') || m.includes('word') || m.includes('document')) {
    return SOURCE_AUTHORITY.NARRATIVE;
  }

  return SOURCE_AUTHORITY.OTHER;
}

/**
 * File-name signals for a DERIVED model — a valuation / returns / DCF /
 * sensitivity output built on top of the statements rather than the
 * statements themselves (SRM_Valuation_Summary.xlsx on the SRM deal).
 * "model" alone is NOT a signal: LBO workbooks often carry the reported
 * statements on their own tabs.
 */
// "summary" alone is NOT a signal either (fix plan G12): companies name their
// reporting packs "Financial Summary" / "FY24 Summary P&L", and a CIM has an
// "Executive Summary". "Valuation Summary" is still caught by "valuation".
const DERIVED_MODEL_NAME_RE =
  /\b(valuation|returns?|dcf|sensitivit(y|ies)|irr|model[\s_-]*output|scenario[s]?)\b/i;

export function isDerivedModelName(name: string | null | undefined): boolean {
  if (!name) return false;
  return DERIVED_MODEL_NAME_RE.test(name.replace(/[_.]/g, ' '));
}

/**
 * Processing order for multi-document extraction (lower first): reported
 * statement files, then narrative docs, then derived models. Merge decisions
 * never depend on this order (see runDeepPass) — it only decides which
 * documents are reached first when the request budget runs out.
 */
export function extractionOrder(doc: DocAuthorityMeta | null | undefined): number {
  if (isDerivedModelName(doc?.name)) return 3;
  const rank = financialSourceAuthorityRank(doc);
  if (rank === SOURCE_AUTHORITY.FINANCIAL_SHEET) return 0;
  if (rank === SOURCE_AUTHORITY.NARRATIVE) return 1;
  return 2;
}
