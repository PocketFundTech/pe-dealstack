// ---------------------------------------------------------------------------
// Period-scope inference for the Financial Analysis charts
// ---------------------------------------------------------------------------
//
// `FinancialStatement.periodType` (server) only captures ACTUAL / PROJECTED —
// it does NOT distinguish Annual / Quarterly / Monthly / YTD-cumulative /
// MTD-single / FY-Estimate scopes. Those distinctions live entirely in the
// period-label string (e.g. "2026 YTD", "Apr-26 MTD", "Feb-26", "FY26 Est").
//
// Mixing scopes on a single growth chart and computing pairwise deltas is
// mathematically meaningless (e.g. cumulative-YTD vs single-month MTD =
// +14079%). This module classifies labels into scope buckets and groups
// periods so growth deltas only compare like-for-like.

import type { FinancialStatement } from "./deal-financials-charts-shared";

export type PeriodScope =
  | "annual"
  | "estimate"
  | "ltm"
  | "ytd"
  | "quarterly"
  | "mtd"
  | "monthly"
  | "other";

export const PERIOD_SCOPE_LABEL: Record<PeriodScope, string> = {
  annual: "Annual",
  estimate: "FY Estimate",
  ltm: "LTM / TTM",
  ytd: "YTD (cumulative)",
  quarterly: "Quarterly",
  mtd: "MTD (single month)",
  monthly: "Monthly",
  other: "Other",
};

/**
 * Classify a period label into one of our scope buckets. Order of checks
 * matters — more specific tokens (YTD, MTD, EST, LTM) are checked before the
 * generic month/quarter shape match.
 *
 * Guards: missing/empty labels fall through to `"other"` so they end up in
 * their own group rather than corrupting another.
 */
export function inferPeriodScope(period: string | null | undefined): PeriodScope {
  if (!period) return "other";
  const p = period.trim();
  if (!p) return "other";
  const upper = p.toUpperCase();

  // YTD cumulative: "2026 YTD", "YTD 2026", "YTD Total", "YTD Total (Jan-Apr 20, 2026)"
  if (/\bYTD\b/.test(upper)) return "ytd";
  // MTD single month: "Apr-26 MTD", "MTD"
  if (/\bMTD\b/.test(upper)) return "mtd";
  // LTM / TTM
  if (/\bLTM\b/.test(upper) || /\bTTM\b/.test(upper)) return "ltm";
  // FY Estimate / Forecast / Budget / Projected — "FY26 Est", "FY26 Est."
  if (/\b(EST|ESTIMATE|FORECAST|BUDGET|PROJ|PROJECTED)\b/.test(upper)) return "estimate";
  // Bare ARR / annualised revenue — "Current ARR", "ARR (Annualised)".
  // Treat as annual scope so it's not grouped with monthly/MRR rows
  // (ARR ≈ MRR × 12 — a unit conversion, not growth).
  if (/\bARR\b/.test(upper) || /\bANNUAL(IZED|ISED)?\b/.test(upper)) return "annual";
  // Annual: bare "2025", "FY2025", "FY25" (no other qualifiers)
  if (/^FY\s?\d{2,4}$/.test(upper) || /^\d{4}$/.test(p)) return "annual";
  // Quarterly: "Q1 2025", "Q4-24", "1Q25", or bare "Quarterly"
  if (/\bQ[1-4]\b/.test(upper) || /^[1-4]Q\d{2,4}$/.test(upper) || /\bQUARTERLY\b/.test(upper)) return "quarterly";
  // Monthly single-month: "Jan-25", "Feb 2026", "Mar-26", "March 2026"
  const monthRe =
    /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/;
  if (monthRe.test(upper)) return "monthly";
  // Bare "Monthly" / "MRR" tokens — "Current Monthly", "MRR (Current)".
  if (/\bMRR\b/.test(upper) || /\bMONTHLY\b/.test(upper)) return "monthly";

  return "other";
}

/**
 * Chronological sort key for a period label. Returns `[year, sub]` where
 * `sub` is a fractional ordering within the year:
 *   monthly      → 0.01–0.12 (Jan = 0.01, Dec = 0.12)
 *   quarterly    → 0.25–1.00 (Q1 = 0.25, Q4 = 1.00)
 *   YTD          → 1.10
 *   LTM / TTM    → 1.20
 *   annual       → 1.50
 *   FY estimate  → 1.80 (after annual — projections come last)
 *   other        → 2.00 (sorted to end)
 *
 * Used as `rows.sort((a, b) => comparePeriodChronologically(a.period, b.period))`
 * to fix the chart bug where alphabetical sort scrambled months
 * ("Apr-26 < Aug-26 < Dec-26 < Feb-26 < Jan-26 …").
 */
const MONTH_INDEX: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

function extractYear(upper: string): number | null {
  // Prefer 4-digit year ("2026"), fall back to 2-digit FY/MMM-YY ("FY26", "Apr-26").
  const four = upper.match(/\b(20\d{2}|19\d{2})\b/);
  if (four) return Number(four[1]);
  const two = upper.match(/\b(\d{2})\b/);
  if (two) return 2000 + Number(two[1]);
  return null;
}

export function periodChronoKey(period: string | null | undefined): [number, number] {
  if (!period) return [Number.POSITIVE_INFINITY, 2.0];
  const upper = period.trim().toUpperCase();
  const year = extractYear(upper) ?? Number.POSITIVE_INFINITY;
  const scope = inferPeriodScope(period);

  if (scope === "monthly" || scope === "mtd") {
    for (const [name, idx] of Object.entries(MONTH_INDEX)) {
      if (new RegExp(`\\b${name}\\b`).test(upper)) return [year, idx / 100];
    }
    return [year, 0.99]; // unknown month within year — sort late inside year
  }
  if (scope === "quarterly") {
    const m = upper.match(/Q([1-4])|([1-4])Q/);
    const q = m ? Number(m[1] ?? m[2]) : 1;
    return [year, q * 0.25];
  }
  if (scope === "ytd") return [year, 1.10];
  if (scope === "ltm") return [year, 1.20];
  if (scope === "annual") return [year, 1.50];
  if (scope === "estimate") return [year, 1.80];
  return [year, 2.00];
}

export function comparePeriodChronologically(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const [ay, asub] = periodChronoKey(a);
  const [by, bsub] = periodChronoKey(b);
  if (ay !== by) return ay - by;
  return asub - bsub;
}

/**
 * Group rows by inferred scope, preserving the original date order within each
 * group (caller is expected to have sorted `rows` already). Returns groups in
 * a stable display order (long-horizon scopes first, then drilldowns) so the
 * rendered X-axis reads naturally. Each group is yielded only if non-empty.
 */
export function groupRowsByScope(
  rows: FinancialStatement[],
): { scope: PeriodScope; rows: FinancialStatement[] }[] {
  const buckets = new Map<PeriodScope, FinancialStatement[]>();
  for (const r of rows) {
    const scope = inferPeriodScope(r.period);
    const arr = buckets.get(scope) ?? [];
    arr.push(r);
    buckets.set(scope, arr);
  }
  const order: PeriodScope[] = [
    "annual",
    "estimate",
    "ltm",
    "ytd",
    "quarterly",
    "monthly",
    "mtd",
    "other",
  ];
  return order
    .filter((s) => buckets.has(s))
    .map((scope) => ({ scope, rows: buckets.get(scope)! }));
}
