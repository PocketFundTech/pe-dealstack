import { log } from '../utils/logger.js';
import type { ClassifiedStatement, UnitScale } from './financialClassifier.js';
import { TOLERANCE_LARGE, TOLERANCE_SMALL } from './agents/financialAgent/config.js';
import {
  comparePeriodChronologically,
  inferPeriodScope,
  type PeriodScope,
} from '../utils/periodChrono.js';

// Convert a stored numeric value to actual dollars given the statement's
// unitScale. Used by the revenue-floor gate so we don't false-flag tiny
// startups for "EBITDA margin > 60%" — small SaaS legitimately runs that high.
const SCALE_TO_DOLLARS: Record<string, number> = {
  ACTUALS: 1,
  THOUSANDS: 1_000,
  MILLIONS: 1_000_000,
  BILLIONS: 1_000_000_000,
};
function toActualDollars(value: number | null, unitScale?: UnitScale | string | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const mult = SCALE_TO_DOLLARS[unitScale ?? 'ACTUALS'] ?? 1;
  return value * mult;
}
// Below this revenue threshold, suppress the "unusually high margin" warning —
// small SaaS / IP-licence businesses legitimately run >95% margin and the
// warning is just noise. $5M is the lower-mid-market floor where benchmarks
// start being meaningful.
const HIGH_MARGIN_REVENUE_FLOOR_USD = 5_000_000;

export interface ValidationResult {
  isValid: boolean;
  warnings: string[];
  corrections: Record<string, { original: any; corrected: any; reason: string }>;
}

// ─── 3-Statement Validation Types ────────────────────────────

export interface StatementCheck {
  check: string;              // machine-readable key e.g. "bs_balances"
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;            // human-readable description
  period?: string;            // which period this applies to
}

export interface StatementsValidationResult {
  checks: StatementCheck[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  overallPassed: boolean;     // true if no errors (warnings are OK)
}

// Format a stored numeric line-item value to a human-readable money string.
//
// Bug history: this used to assume `v` was always in millions, so a small-SaaS
// CIM with revenue stored as 16000 at unitScale ACTUALS (= $16,000) would be
// printed as "$16.0B" in validator warnings — terrifying users and triggering
// false-flag conflict reviews on healthy data. The function now accepts the
// statement's unitScale and converts to actual dollars before bucketizing.
//
// Always pass the statement's unitScale at the call site. When omitted (legacy
// callers), we default to ACTUALS — the safest fallback because raw-dollar
// values like 16000 read sanely as "$16.0K" rather than getting inflated.
function fmtVal(v: number, unitScale?: UnitScale | string | null): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  // Resolve scale → multiplier. Unknown / missing scales fall back to ACTUALS
  // so we never silently inflate a stored ACTUALS value into "$16.0B".
  const mult = SCALE_TO_DOLLARS[(unitScale ?? 'ACTUALS') as string] ?? 1;
  const dollars = abs * mult;
  if (dollars >= 1_000_000_000) return `${sign}$${(dollars / 1_000_000_000).toFixed(1)}B`;
  if (dollars >= 1_000_000)     return `${sign}$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000)         return `${sign}$${(dollars / 1_000).toFixed(1)}K`;
  return `${sign}$${dollars.toFixed(0)}`;
}

/**
 * Validate and sanity-check extracted financial data.
 * Supports deals ranging from micro-acquisitions ($1K+) to large PE ($5B).
 *
 * Optional `sourceLength` lets the validator apply tighter bounds for short
 * source documents (teasers / one-pagers / executive summaries), where
 * absurd financial values almost always come from misclassified targets,
 * valuations, or projections.
 */
export function validateFinancials(data: {
  revenue?: number | null;
  ebitda?: number | null;
  ebitdaMargin?: number | null;
  revenueGrowth?: number | null;
  dealSize?: number | null;
  employees?: number | null;
  sourceLength?: number;
}): ValidationResult {
  const warnings: string[] = [];
  const corrections: Record<string, { original: any; corrected: any; reason: string }> = {};

  // The aiExtractor path that feeds this function returns values already
  // normalized to MILLIONS (see aiExtractor.ts: "Revenue must be in millions"),
  // so format those for display at MILLIONS scale. This is distinct from
  // validateStatements() below, which receives raw values + an explicit
  // unitScale per statement.
  const fmt = (v: number) => fmtVal(v, 'MILLIONS');

  const SHORT_DOC_THRESHOLD = 5000;
  const isShortDoc = typeof data.sourceLength === 'number' && data.sourceLength < SHORT_DOC_THRESHOLD;

  // Revenue sanity check (expect values in millions)
  if (data.revenue !== null && data.revenue !== undefined) {
    if (data.revenue > 50000) {
      warnings.push(`Revenue ${fmt(data.revenue)} seems too high. May be in thousands.`);
      corrections.revenue = {
        original: data.revenue,
        corrected: data.revenue / 1000,
        reason: 'Value exceeds $50B — likely reported in thousands, not millions',
      };
    }
    if (data.revenue > 0 && data.revenue < 0.0001) {
      // Only flag if less than $100 — micro-acquisitions with $1K+ revenue are valid
      warnings.push(`Revenue ${fmt(data.revenue)} seems extremely low. Verify units.`);
    }
    if (data.revenue < 0) {
      warnings.push('Revenue is negative — likely an error.');
    }
    // Short-doc cap — values above $500M from a one-pager are almost always
    // a target or projection misclassified as actuals.
    if (isShortDoc && data.revenue > 500) {
      warnings.push(
        `Revenue ${fmt(data.revenue)} from a short source document (~${Math.round((data.sourceLength ?? 0) / 2500)} pages) is unusual — verify it isn't a target, projection, or valuation.`
      );
    }
  }

  // Deal-size sanity check
  if (data.dealSize !== null && data.dealSize !== undefined) {
    if (isShortDoc && data.dealSize > 1000) {
      warnings.push(
        `Deal size ${fmt(data.dealSize)} from a short source document is unusual — verify it isn't a valuation or fundraise target.`
      );
    }
    // Cross-field: revenue vastly exceeding dealSize on a short doc — one of the
    // two is almost certainly a misclassified target/valuation.
    if (
      isShortDoc &&
      data.revenue && data.revenue > 0 &&
      data.dealSize > 0 &&
      data.revenue > data.dealSize * 5
    ) {
      warnings.push(
        `Revenue ${fmt(data.revenue)} >> deal size ${fmt(data.dealSize)} on a one-pager — one of these is likely a target or valuation, not the actual.`
      );
    }
  }

  // EBITDA margin check
  if (data.ebitdaMargin !== null && data.ebitdaMargin !== undefined) {
    if (data.ebitdaMargin > 80) {
      warnings.push(`EBITDA margin of ${data.ebitdaMargin}% is unusually high. Verify.`);
    }
    if (data.ebitdaMargin < -50) {
      warnings.push(`EBITDA margin of ${data.ebitdaMargin}% indicates significant losses.`);
    }
  }

  // Cross-check: EBITDA vs Revenue
  if (data.revenue && data.ebitda && data.revenue > 0) {
    const calculatedMargin = (data.ebitda / data.revenue) * 100;
    if (data.ebitdaMargin && Math.abs(calculatedMargin - data.ebitdaMargin) > 5) {
      warnings.push(
        `EBITDA margin mismatch: extracted ${data.ebitdaMargin}% but calculated ${calculatedMargin.toFixed(1)}% from revenue/EBITDA.`
      );
    }
    if (data.ebitda > data.revenue) {
      warnings.push('EBITDA exceeds revenue — likely an extraction error.');
    }
  }

  // Revenue growth check
  if (data.revenueGrowth !== null && data.revenueGrowth !== undefined) {
    if (data.revenueGrowth > 200) {
      warnings.push(`Revenue growth of ${data.revenueGrowth}% is exceptionally high. Verify.`);
    }
  }

  // Employee count check
  if (data.employees !== null && data.employees !== undefined) {
    if (data.employees > 100000) {
      warnings.push(`${data.employees} employees seems very high for a PE target.`);
    }
    if (data.revenue && data.employees > 0) {
      const revenuePerEmployee = (data.revenue * 1000000) / data.employees;
      if (revenuePerEmployee < 10000) {
        warnings.push(`Revenue per employee ($${(revenuePerEmployee / 1000).toFixed(0)}K) is unusually low.`);
      }
    }
  }

  if (warnings.length > 0) {
    log.warn('Financial validation warnings', { warnings, corrections });
  }

  return {
    isValid: warnings.length === 0,
    warnings,
    corrections,
  };
}

// ─── 3-Statement Cross-Check Validators ──────────────────────
// TOLERANCE_LARGE and TOLERANCE_SMALL are imported from agents/financialAgent/config.ts

function pct(numerator: number, denominator: number): number {
  return (numerator / denominator) * 100;
}

function withinTolerance(a: number, b: number): boolean {
  if (b === 0) return a === 0;
  const tolerance = Math.abs(b) > 1 ? TOLERANCE_LARGE : TOLERANCE_SMALL;
  return Math.abs(a - b) / Math.abs(b) <= tolerance;
}

/** Subtask 4a — Income statement math checks */
function checkIncomeStatement(
  lineItems: Record<string, number | null>,
  period: string,
  unitScale?: UnitScale | string | null,
): StatementCheck[] {
  const checks: StatementCheck[] = [];
  const li = (k: string) => lineItems[k] ?? null;

  const revenue = li('revenue');
  const cogs = li('cogs');
  const grossProfit = li('gross_profit');
  const ebitda = li('ebitda');
  const ebitdaMarginPct = li('ebitda_margin_pct');
  const da = li('da');
  const ebit = li('ebit');

  // 4a: Revenue - COGS = Gross Profit
  if (revenue !== null && cogs !== null && grossProfit !== null) {
    const calc = revenue - cogs;
    checks.push({
      check: 'is_gross_profit_math',
      passed: withinTolerance(calc, grossProfit),
      severity: 'error',
      message: withinTolerance(calc, grossProfit)
        ? `Gross profit checks out: ${fmtVal(revenue, unitScale)} - ${fmtVal(cogs, unitScale)} ≈ ${fmtVal(grossProfit, unitScale)}`
        : `Gross profit mismatch: Revenue ${fmtVal(revenue, unitScale)} - COGS ${fmtVal(cogs, unitScale)} = ${fmtVal(calc, unitScale)}, but extracted ${fmtVal(grossProfit, unitScale)}`,
      period,
    });
  }

  // EBITDA must be less than revenue
  if (revenue !== null && ebitda !== null && revenue > 0) {
    const exceeds = ebitda > revenue;
    checks.push({
      check: 'is_ebitda_lt_revenue',
      passed: !exceeds,
      severity: 'error',
      message: exceeds
        ? `EBITDA ${fmtVal(ebitda, unitScale)} exceeds revenue ${fmtVal(revenue, unitScale)} — likely an extraction error`
        : `EBITDA is within revenue bounds`,
      period,
    });
  }

  // 4d: EBITDA margin sanity (5–60% normal for LMM)
  if (revenue !== null && ebitda !== null && revenue > 0) {
    const calcMargin = pct(ebitda, revenue);
    if (ebitdaMarginPct !== null && !withinTolerance(calcMargin, ebitdaMarginPct)) {
      checks.push({
        check: 'is_ebitda_margin_consistent',
        passed: false,
        severity: 'warning',
        message: `EBITDA margin mismatch: extracted ${ebitdaMarginPct.toFixed(1)}% but calculated ${calcMargin.toFixed(1)}% from revenue/EBITDA`,
        period,
      });
    }
    // Revenue-floor gate: suppress the "unusually high margin" warning for
    // companies below $5M revenue. Small SaaS / IP-licence / early-stage
    // businesses legitimately run >95% margin and the warning is noise.
    // Below the floor we still flag losses, but we don't second-guess high
    // margins — they're expected at that scale.
    const revenueUSD = toActualDollars(revenue, unitScale);
    const isSmallCompany = revenueUSD !== null && revenueUSD < HIGH_MARGIN_REVENUE_FLOOR_USD;
    const highMargin = calcMargin > 60;
    const flagAsHighMargin = highMargin && !isSmallCompany;
    checks.push({
      check: 'is_ebitda_margin_sane',
      passed: calcMargin >= -50 && calcMargin <= 80,
      severity: flagAsHighMargin ? 'warning' : 'info',
      message: flagAsHighMargin
        ? `EBITDA margin of ${calcMargin.toFixed(1)}% is unusually high — verify`
        : highMargin && isSmallCompany
          ? `EBITDA margin of ${calcMargin.toFixed(1)}% — high but expected at this revenue scale`
          : calcMargin < 0
            ? `EBITDA margin of ${calcMargin.toFixed(1)}% indicates losses`
            : `EBITDA margin of ${calcMargin.toFixed(1)}% is within normal range`,
      period,
    });
  }

  // EBITDA - D&A = EBIT
  if (ebitda !== null && da !== null && ebit !== null) {
    const calc = ebitda - da;
    checks.push({
      check: 'is_ebit_math',
      passed: withinTolerance(calc, ebit),
      severity: 'warning',
      message: withinTolerance(calc, ebit)
        ? `EBIT math checks out: EBITDA ${fmtVal(ebitda, unitScale)} - D&A ${fmtVal(da, unitScale)} ≈ EBIT ${fmtVal(ebit, unitScale)}`
        : `EBIT mismatch: EBITDA ${fmtVal(ebitda, unitScale)} - D&A ${fmtVal(da, unitScale)} = ${fmtVal(calc, unitScale)}, but extracted EBIT ${fmtVal(ebit, unitScale)}`,
      period,
    });
  }

  return checks;
}

/** Subtask 4b — Balance sheet: Assets = Liabilities + Equity */
function checkBalanceSheet(
  lineItems: Record<string, number | null>,
  period: string,
  unitScale?: UnitScale | string | null,
): StatementCheck[] {
  const checks: StatementCheck[] = [];
  const li = (k: string) => lineItems[k] ?? null;

  const totalAssets = li('total_assets');
  const totalLiabilities = li('total_liabilities');
  const totalEquity = li('total_equity');
  const totalCurrentAssets = li('total_current_assets');
  const totalCurrentLiabilities = li('total_current_liabilities');

  // Assets = Liabilities + Equity
  if (totalAssets !== null && totalLiabilities !== null && totalEquity !== null) {
    const calc = totalLiabilities + totalEquity;
    checks.push({
      check: 'bs_balances',
      passed: withinTolerance(calc, totalAssets),
      severity: 'error',
      message: withinTolerance(calc, totalAssets)
        ? `Balance sheet balances: Assets ≈ Liabilities + Equity (${fmtVal(totalAssets, unitScale)})`
        : `Balance sheet doesn't balance: Assets ${fmtVal(totalAssets, unitScale)} ≠ Liabilities ${fmtVal(totalLiabilities, unitScale)} + Equity ${fmtVal(totalEquity, unitScale)} = ${fmtVal(calc, unitScale)}`,
      period,
    });
  }

  // Current assets ≤ total assets
  if (totalCurrentAssets !== null && totalAssets !== null && totalCurrentAssets > totalAssets) {
    checks.push({
      check: 'bs_current_assets_sane',
      passed: false,
      severity: 'error',
      message: `Current assets ${fmtVal(totalCurrentAssets, unitScale)} exceed total assets ${fmtVal(totalAssets, unitScale)} — extraction error`,
      period,
    });
  }

  // Current liabilities ≤ total liabilities
  if (totalCurrentLiabilities !== null && totalLiabilities !== null && totalCurrentLiabilities > totalLiabilities) {
    checks.push({
      check: 'bs_current_liabilities_sane',
      passed: false,
      severity: 'error',
      message: `Current liabilities ${fmtVal(totalCurrentLiabilities, unitScale)} exceed total liabilities ${fmtVal(totalLiabilities, unitScale)} — extraction error`,
      period,
    });
  }

  return checks;
}

/** Subtask 4c — Cash flow: FCF = Operating CF - CapEx */
function checkCashFlow(
  lineItems: Record<string, number | null>,
  period: string,
  unitScale?: UnitScale | string | null,
): StatementCheck[] {
  const checks: StatementCheck[] = [];
  const li = (k: string) => lineItems[k] ?? null;

  const operatingCf = li('operating_cf');
  const capex = li('capex');
  const fcf = li('fcf');

  // FCF = Operating CF - CapEx
  if (operatingCf !== null && capex !== null && fcf !== null) {
    // CapEx is typically negative in CF statements but sometimes stored as positive
    const capexAbs = Math.abs(capex);
    const calc = operatingCf - capexAbs;
    checks.push({
      check: 'cf_fcf_math',
      passed: withinTolerance(calc, fcf),
      severity: 'warning',
      message: withinTolerance(calc, fcf)
        ? `FCF checks out: Operating CF ${fmtVal(operatingCf, unitScale)} - CapEx ${fmtVal(capexAbs, unitScale)} ≈ FCF ${fmtVal(fcf, unitScale)}`
        : `FCF mismatch: ${fmtVal(operatingCf, unitScale)} - ${fmtVal(capexAbs, unitScale)} = ${fmtVal(calc, unitScale)}, but extracted FCF ${fmtVal(fcf, unitScale)}`,
      period,
    });
  }

  return checks;
}

/** Subtask 4e — YoY growth sanity across sorted periods.
 *
 * The pairwise growth scan must only compare like-for-like periods. Historical
 * rows are first bucketed by inferred period scope (annual / quarterly /
 * monthly / ytd / ltm / mtd / estimate / other) — we only compute deltas
 * between consecutive rows in the SAME scope. Without this, the scan
 * happily produced nonsense like
 *   "Revenue growth from Current Monthly to Current ARR is 1093.8%"
 * because ARR ≈ MRR × 12 — a unit-of-aggregation difference, not growth.
 *
 * Mirrors the frontend grouping at
 * apps/web-next/src/app/(app)/deals/[id]/deal-financials-period-scope.ts
 * (`groupRowsByScope`) — same bucket set, same intent.
 */
function checkYoYGrowth(
  periods: Array<{ period: string; periodType: string; lineItems: Record<string, number | null> }>,
  unitScale?: UnitScale | string | null,
): StatementCheck[] {
  const checks: StatementCheck[] = [];

  // Only check historical periods. Group by inferred scope FIRST so we don't
  // compute deltas across different aggregations (e.g. monthly → ARR,
  // YTD-cumulative → MTD-single-month, monthly → annual). Then sort within
  // each bucket chronologically and walk pairwise.
  const historical = periods.filter(p => p.periodType === 'HISTORICAL');
  const buckets = new Map<PeriodScope, typeof historical>();
  for (const p of historical) {
    const scope = inferPeriodScope(p.period);
    const arr = buckets.get(scope) ?? [];
    arr.push(p);
    buckets.set(scope, arr);
  }

  for (const rows of buckets.values()) {
    // A single row in a bucket has nothing to compare against — skip.
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) =>
      comparePeriodChronologically(a.period, b.period),
    );

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevRev = prev.lineItems['revenue'] ?? null;
      const currRev = curr.lineItems['revenue'] ?? null;

      if (prevRev !== null && currRev !== null && prevRev > 0) {
        const growth = pct(currRev - prevRev, prevRev);
        // 4e: Flag >100% or < -50% swings
        if (Math.abs(growth) > 100) {
          checks.push({
            check: 'yoy_revenue_growth_sane',
            passed: false,
            severity: 'warning',
            message: `Revenue growth from ${prev.period} to ${curr.period} is ${growth.toFixed(1)}% — verify (${fmtVal(prevRev, unitScale)} → ${fmtVal(currRev, unitScale)})`,
            period: curr.period,
          });
        }
      }

      const prevEbitda = prev.lineItems['ebitda'] ?? null;
      const currEbitda = curr.lineItems['ebitda'] ?? null;
      if (prevRev !== null && prevRev > 0 && currRev !== null && currRev > 0 && prevEbitda !== null && currEbitda !== null) {
        const prevMargin = pct(prevEbitda, prevRev);
        const currMargin = pct(currEbitda, currRev);
        if (Math.abs(currMargin - prevMargin) > 20) {
          checks.push({
            check: 'yoy_margin_swing_sane',
            passed: false,
            severity: 'warning',
            message: `EBITDA margin swung ${(currMargin - prevMargin).toFixed(1)}pp from ${prev.period} (${prevMargin.toFixed(1)}%) to ${curr.period} (${currMargin.toFixed(1)}%) — verify`,
            period: curr.period,
          });
        }
      }
    }
  }

  return checks;
}

/**
 * Subtask 4f — Top-level validator for the full extracted 3-statement model.
 * Input is the ClassifiedStatement[] array from financialClassifier.ts.
 * Returns structured StatementCheck[] with severity levels.
 */
export function validateStatements(statements: ClassifiedStatement[]): StatementsValidationResult {
  const allChecks: StatementCheck[] = [];

  for (const stmt of statements) {
    for (const period of stmt.periods) {
      let periodChecks: StatementCheck[] = [];

      if (stmt.statementType === 'INCOME_STATEMENT') {
        periodChecks = checkIncomeStatement(period.lineItems, period.period, stmt.unitScale);
      } else if (stmt.statementType === 'BALANCE_SHEET') {
        periodChecks = checkBalanceSheet(period.lineItems, period.period, stmt.unitScale);
      } else if (stmt.statementType === 'CASH_FLOW') {
        periodChecks = checkCashFlow(period.lineItems, period.period, stmt.unitScale);
      }

      allChecks.push(...periodChecks);
    }

    // YoY growth checks across all periods for income statements
    if (stmt.statementType === 'INCOME_STATEMENT') {
      allChecks.push(...checkYoYGrowth(stmt.periods, stmt.unitScale));
    }
  }

  const errorCount = allChecks.filter(c => !c.passed && c.severity === 'error').length;
  const warningCount = allChecks.filter(c => !c.passed && c.severity === 'warning').length;
  const infoCount = allChecks.filter(c => c.severity === 'info').length;

  if (errorCount > 0 || warningCount > 0) {
    log.warn('Statement validation issues found', { errorCount, warningCount });
  }

  return {
    checks: allChecks,
    errorCount,
    warningCount,
    infoCount,
    overallPassed: errorCount === 0,
  };
}
