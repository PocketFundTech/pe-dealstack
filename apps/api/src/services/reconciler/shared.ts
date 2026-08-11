// ─── Quantitative Reconciler — Shared Types & Helpers ──────────────
//
// Pure-TS deterministic computations over the deal's stored
// FinancialStatement rows. No LLM calls in Phase 1 — every output is
// derived from the numbers we already have in the DB.
//
// Output shape mirrors the spec the user drafted (see commit message
// for the linked Website Speedy reference doc).

import type { UnitScale } from '../financialClassifier.js';

// ─── Unit normalisation ────────────────────────────────────────────
//
// FinancialStatement.lineItems are stored in whatever scale the source
// document used (ACTUALS for raw dollars, MILLIONS for `$M` tables, etc.).
// Every aggregation MUST normalise to actual dollars before summing —
// otherwise a deal with one statement in ACTUALS and one in MILLIONS
// will silently inflate by 6 orders of magnitude.

export const SCALE_TO_DOLLARS: Record<string, number> = {
  ACTUALS: 1,
  THOUSANDS: 1_000,
  MILLIONS: 1_000_000,
  BILLIONS: 1_000_000_000,
};

export function toActualDollars(
  value: number | null | undefined,
  unitScale?: UnitScale | string | null,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const mult = SCALE_TO_DOLLARS[unitScale ?? 'ACTUALS'] ?? 1;
  return value * mult;
}

// ─── Statement input shape ─────────────────────────────────────────
//
// The reconciler reads from FinancialStatement DB rows. Each row is
// already one (statementType, period). We normalise to a slim view —
// callers convert from Supabase rows or in-memory ClassifiedStatement
// before invoking the modules.

export interface ReconcilerStatementInput {
  /** DB row id, used for trace correlation */
  id: string;
  documentId: string | null;
  statementType: 'INCOME_STATEMENT' | 'BALANCE_SHEET' | 'CASH_FLOW';
  /** Raw period label as extracted (e.g. "Mar-26", "2025", "FY26 Est") */
  period: string;
  periodType: 'HISTORICAL' | 'PROJECTED' | 'LTM';
  /** Source unit scale — values in lineItems must be multiplied by
   * SCALE_TO_DOLLARS[unitScale] to get actual dollars. */
  unitScale: UnitScale;
  currency: string;
  /** lineItems in the SOURCE unit scale, NOT actual dollars. */
  lineItems: Record<string, number | null>;
  extractionConfidence: number | null;
  isActive: boolean;
}

// ─── Reconciler context (asking price, etc.) ───────────────────────

export interface ReconcilerContext {
  /** Deal asking price in actual dollars, if known. Optional —
   * valuation framing block is omitted when null. */
  askingPriceUsd?: number | null;
  /** Currency of the deal — most reconciler logic assumes USD; if
   * the statements are in another currency we still emit numbers but
   * tag the output for the UI to format correctly. */
  currency?: string;
}

// ─── Output blocks (mirror spec exactly) ───────────────────────────

export interface ComputedGroundTruth {
  /** Annual gross revenue, keyed by year string ("2024_full",
   * "2025_partial_AprDec") so partial years are visible. */
  annualGrossRevenue: Record<string, number>;
  annualNetIncome: Record<string, number>;
  annualNetMargin: Record<string, number>;
  latestMonthMRR: {
    month: string;            // "2026-03"
    grossRevenue: number;
    impliedAnnualizedRevenue: number;
    netIncome: number;
    netMargin: number;
  } | null;
  /** Sum across all months in the trailing 12-month window. */
  TTM_revenue: number | null;
  TTM_netIncome: number | null;
  TTM_netMargin: number | null;
  /** Average MRR over the trailing 3 months. */
  trailingThreeMonthAvgMRR: number | null;
  impliedARR_3MoAvg: number | null;
  /** Optional — populated only when ctx.askingPriceUsd is provided. */
  valuationContextAtAskingPrice?: {
    askingPrice: number;
    multipleOf_TTM_GrossRevenue: number | null;
    multipleOf_TTM_NetIncome: number | null;
    multipleOf_3MoARR: number | null;
  };
}

export interface ChannelConcentrationAnalysis {
  asOfPeriod: string;
  channels: Array<{ name: string; amount: number; pctOfTotal: number }>;
  /** Herfindahl-Hirschman Index (0-10000) on channel revenue shares. */
  platformConcentrationHHI: number;
  /** Verdict bucket: UNCONCENTRATED (<1500), MODERATELY_CONCENTRATED
   * (1500-2500), HIGHLY_CONCENTRATED (>2500). Spec uses
   * MODERATELY_CONCENTRATED at HHI=3850 — buckets here use the FTC's
   * adjusted thresholds for "platform" risk: <2000 / 2000-3500 / >3500. */
  platformConcentrationVerdict:
    | 'UNCONCENTRATED'
    | 'MODERATELY_CONCENTRATED'
    | 'HIGHLY_CONCENTRATED';
  topChannelDependency: string;
}

export type ValuationVerdict =
  | 'BELOW_BAND'
  | 'BOTTOM_OF_BAND_FAVORABLE'
  | 'WITHIN_BAND'
  | 'UPPER_HALF_OF_BAND'
  | 'ABOVE_BAND';

export interface ValuationFraming {
  askingPrice: number;
  framings: Array<{
    basis: string;
    value: number;
    multiple: number;
    comp_band_for_microSaaS: string;
    verdict: ValuationVerdict;
  }>;
}

export interface MaterialFinding {
  id: string;          // "F-002" etc.
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  evidence: string;
  implication: string;
}

// ─── Combined Phase-1 output ───────────────────────────────────────

export interface QuantitativeReconciliationPhase1 {
  computedGroundTruth: ComputedGroundTruth;
  channelConcentrationAnalysis: ChannelConcentrationAnalysis | null;
  valuationFraming: ValuationFraming | null;
  /** Phase 1 only fills in the deterministic findings (currently the
   * OpEx step-up detector). Phase 2 will append LLM-derived findings. */
  materialFindings: MaterialFinding[];
  /** Diagnostics — empty when no input issues. */
  warnings: string[];
}

// ─── Phase 2 — narrative input (LLM-augmented blocks) ──────────────
//
// Phase 2 modules read narrative documents (CIM, teaser, IM) — NOT
// the FinancialStatement rows Phase 1 already aggregated. The agent
// extracts explicit claims from prose, then deterministic logic
// matches each claim to the computed ground truth and emits a verdict.

export interface NarrativeDocumentInput {
  /** Document.id for trace correlation */
  id: string;
  name: string;
  /** Document.type — "CIM", "TEASER", "FINANCIAL_DATA", etc. */
  type: string | null;
  /** mimeType for additional context */
  mimeType: string | null;
  /** Full extracted text, capped by caller (Phase 2 prompts are big
   * enough that we typically slice to ~20K chars per doc). */
  extractedText: string;
}

export interface DealRecordInput {
  id: string;
  name: string;
  companyName: string | null;
  industry: string | null;
  currency: string;
  /** Stored top-line numbers (in millions per schema convention). May
   * be null if extraction never set them. Used by extractionQualityFeedback
   * to compare what the agent claimed against what the data sums to. */
  revenue: number | null;       // millions
  ebitda: number | null;        // millions
  dealSize: number | null;      // millions (= asking price / 1M)
}

// ─── Phase 2 — output blocks ───────────────────────────────────────

export type ClaimVerdict =
  | 'VERIFIED'
  | 'VERIFIED_LOWER_END'
  | 'VERIFIED_UPPER_END'
  | 'MINOR_DISCREPANCY'
  | 'MATERIAL_UNDERSTATEMENT'
  | 'MATERIAL_OVERSTATEMENT'
  | 'UNDERSTATEMENT_FAVORABLE_TO_BUYER'
  | 'OVERSTATEMENT_UNFAVORABLE_TO_BUYER'
  | 'UNVERIFIABLE_FROM_FINANCIALS';

export interface CimClaimValidation {
  claim: string;
  claimSource: string;        // "CIM", "TEASER", filename, etc.
  /** Computed ground-truth value. null when claim is unverifiable from financials. */
  computedValue: number | string | null;
  computedSource: string;     // "Spreadsheet, 3-month avg MRR × 12 (Jan-Mar 2026)"
  /** Variance % (claim vs computed). null when not numeric or unverifiable. */
  variance_pct: number | null;
  verdict: ClaimVerdict;
  implication: string;
}

export interface RecommendedAction {
  priority: number;
  owner: string;              // "Buyer" | "Seller" | "Auditor"
  action: string;
}

export interface ExtractionQualityFeedback {
  issuesWithPriorExtraction: string[];
  rootCauseDiagnosis: string;
  promptingFixForPEOS: string;
}

export interface DocumentSet {
  primaryFinancialFile: string | null;
  primaryNarrativeFile: string | null;
  asOfDate: string;           // ISO date — latest period in the financials
  extractionRunDate: string;  // ISO date — when this reconciliation ran
}

// ─── Combined Phase-2 output (Phase 1 + LLM-augmented blocks) ──────

export interface QuantitativeReconciliationPhase2 extends QuantitativeReconciliationPhase1 {
  documentSet: DocumentSet;
  cimClaimValidation: CimClaimValidation[];
  /** Phase 2 LLM call appends to the materialFindings array Phase 1 produced.
   * The combined list lives on the parent QuantitativeReconciliationPhase1.materialFindings
   * field — Phase 2 callers should not introduce a separate array. */
  recommendedNextActions: RecommendedAction[];
  extractionQualityFeedback: ExtractionQualityFeedback;
  /** True when at least one Phase 2 block ran successfully. False when
   * LLM unavailable / API key missing — caller falls back to Phase 1
   * output without the LLM blocks. */
  llmAugmented: boolean;
}

// ─── Period helpers (used by every module) ─────────────────────────
//
// Statements have heterogeneous period labels — "Mar-26", "Apr-2026",
// "2026-03", "2025", "FY25", "Q1 2026", "TTM", "LTM Mar-26", etc.
// These helpers normalise to a year + month index when possible so
// modules can group/sort consistently. Re-uses existing periodChrono
// where possible.

const MONTH_INDEX: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

/** Returns { year, month } for monthly labels ("Mar-26", "2026-03",
 * "Mar 2026"), { year } for annual labels, or null when unparseable. */
export function parsePeriodToYearMonth(
  period: string | null | undefined,
): { year: number; month?: number } | null {
  if (!period) return null;
  const upper = period.trim().toUpperCase();

  // ISO-ish "2026-03"
  const iso = upper.match(/^(\d{4})-(\d{2})$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };

  // "Mar-26" / "Mar-2026" / "MARCH 2026"
  for (const [name, idx] of Object.entries(MONTH_INDEX)) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(upper)) {
      const four = upper.match(/\b(20\d{2}|19\d{2})\b/);
      const two = upper.match(/-(\d{2})\b/);
      const year = four
        ? Number(four[1])
        : two
        ? 2000 + Number(two[1])
        : null;
      if (year != null) return { year, month: idx };
    }
  }

  // Bare "2025", "FY25", "FY2025"
  const fy = upper.match(/^FY\s?(\d{2,4})$/);
  if (fy) {
    const n = Number(fy[1]);
    return { year: n < 100 ? 2000 + n : n };
  }
  const bare = upper.match(/^(\d{4})$/);
  if (bare) return { year: Number(bare[1]) };

  return null;
}

/** Get a numeric line-item value normalised to actual dollars,
 * trying multiple candidate keys (line items use snake_case but
 * occasionally appear with camelCase or aliases). Returns null when
 * none of the candidates yield a finite number. */
export function getLineItemDollars(
  lineItems: Record<string, number | null>,
  candidates: string[],
  unitScale: UnitScale,
): number | null {
  for (const key of candidates) {
    const v = lineItems[key];
    if (v == null || !Number.isFinite(v)) continue;
    return toActualDollars(v, unitScale);
  }
  return null;
}

// Common alias sets used across modules so they stay consistent.
export const REVENUE_KEYS = [
  'revenue', 'total_revenue', 'gross_revenue', 'net_revenue',
  'sales', 'total_sales', 'top_line', 'mrr', 'arr',
];
export const NET_INCOME_KEYS = [
  'net_income', 'net_profit', 'profit', 'earnings',
  'net_earnings', 'bottom_line',
];
export const OPEX_KEYS = [
  'opex', 'operating_expenses', 'total_operating_expenses',
  'total_expenses', 'expenses', 'sga', 'overhead',
];
