/**
 * Which extracted statement should be the ACTIVE one (fix plan B1).
 * =================================================================
 *
 * On the SRM deal the balance sheet and cash flow came from
 * SRM_Valuation_Summary.xlsx — a derived valuation model — instead of the
 * LBO workbook's reported "BS Source" / "CFS Source" tabs. Every spreadsheet
 * had the same authority rank, and on a tie the FIRST document to write a
 * period won. Now, in order:
 *
 *   1. source kind — a reported statement beats a model-derived one
 *      (the extractor's own `sourceKind`, else file / sheet name signals);
 *   2. document authority (financialSourceAuthority.ts) — a financials
 *      spreadsheet beats a CIM beats anything else;
 *   3. completeness — more line items, and the statement's totals present.
 *
 * Only a genuine tie on all three keeps the existing row (needs_review).
 * Write order never decides.
 */

import { parsePeriod } from '@ai-crm/shared';
import type { ClassifiedStatement, SourceKind, StatementType } from './financialClassifier.js';
import {
  financialSourceAuthorityRank, isDerivedModelName, type DocAuthorityMeta,
} from './financialSourceAuthority.js';

/** Grouping key so "FY2024 (Jan - Dec 2024)" and "2024" are the same period (fix plan A4). */
export function periodKeyOf(label: string): string {
  return parsePeriod(label)?.canonicalKey ?? label.trim();
}

/** The extractor's verdict, else name signals on the sheet or file. */
export function resolveSourceKind(
  reported: SourceKind | null | undefined,
  sheetName: string | null | undefined,
  docName: string | null | undefined,
): SourceKind {
  if (reported) return reported;
  if (isDerivedModelName(sheetName) || isDerivedModelName(docName)) return 'model_derived';
  return 'source_statement';
}

const TOTAL_KEYS: Record<StatementType, string[]> = {
  INCOME_STATEMENT: ['revenue', 'net_income'],
  BALANCE_SHEET: ['total_assets', 'total_liabilities', 'total_equity'],
  CASH_FLOW: ['operating_cf', 'net_change_cash'],
};

/** Numeric line items, plus a bonus for each of the statement's totals present. */
export function completenessScore(statementType: StatementType, lineItems: Record<string, unknown> | null | undefined): number {
  const li = lineItems ?? {};
  const numeric = Object.entries(li).filter(([k, v]) => !k.endsWith('_source') && typeof v === 'number').length;
  const totals = TOTAL_KEYS[statementType].filter((k) => typeof li[k] === 'number').length;
  return numeric + totals * 5;
}

export interface SourceCandidate {
  sourceKind: SourceKind;
  doc: DocAuthorityMeta | null | undefined;
  statementType: StatementType;
  lineItems: Record<string, unknown> | null | undefined;
  /** Period label as printed — "FY2023 (Restated)" marks a restatement. */
  period?: string | null;
}

/** A restatement — by the period label or the document's name ("FY2023 (Restated)", "Restated FS 2023.pdf"). */
export function isRestated(c: Pick<SourceCandidate, 'period' | 'doc'>): boolean {
  return /\brestated\b/i.test(c.period ?? '') || /\brestated\b/i.test((c.doc?.name ?? '').replace(/[_.-]/g, ' '));
}

/**
 * > 0: `a` should be active; < 0: `b`; 0: genuine tie.
 * Reported statement over model-derived; then a restatement over the
 * figures it corrects (fix plan G14 — without it an original could beat a
 * later restated set on authority or line count); then document authority;
 * then completeness.
 */
export function compareSources(a: SourceCandidate, b: SourceCandidate): number {
  const kind = (c: SourceCandidate) => (c.sourceKind === 'source_statement' ? 1 : 0);
  if (kind(a) !== kind(b)) return kind(a) - kind(b);
  const restated = Number(isRestated(a)) - Number(isRestated(b));
  if (restated !== 0) return restated;
  const rank = financialSourceAuthorityRank(a.doc) - financialSourceAuthorityRank(b.doc);
  if (rank !== 0) return rank;
  return completenessScore(a.statementType, a.lineItems) - completenessScore(b.statementType, b.lineItems);
}

/**
 * Within ONE document: when a statement type comes back both as a reported
 * statement and as a model-derived one (an LBO workbook with "BS Source" and
 * "Valuation" tabs), keep only the reported version — merging them would
 * union the valuation model's lines into the real balance sheet.
 */
export function selectSourceStatements(
  statements: ClassifiedStatement[],
  docName: string | null | undefined,
): { statements: ClassifiedStatement[]; dropped: string[] } {
  const kindOf = (s: ClassifiedStatement) => resolveSourceKind(s.sourceKind, s.sheetName, docName);
  const typesWithSource = new Set(statements.filter((s) => kindOf(s) === 'source_statement').map((s) => s.statementType));
  const dropped: string[] = [];
  const kept = statements.filter((s) => {
    if (kindOf(s) === 'model_derived' && typesWithSource.has(s.statementType)) {
      dropped.push(`${s.statementType}${s.sheetName ? ` (${s.sheetName})` : ''}`);
      return false;
    }
    return true;
  });
  return { statements: kept.map((s) => ({ ...s, sourceKind: kindOf(s) })), dropped };
}
