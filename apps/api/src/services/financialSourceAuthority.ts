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
