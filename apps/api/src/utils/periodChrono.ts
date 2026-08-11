/**
 * Server-side chronological sort for FinancialStatement.period labels.
 *
 * Mirrors the frontend helper at
 * apps/web-next/src/app/(app)/deals/[id]/deal-financials-period-scope.ts —
 * any change here should be applied there too. Long-term we should expose a
 * canonical `periodScope` field on FinancialStatement so client + server both
 * read the same value (see open follow-ups in
 * docs/financial-extraction-fixes.md).
 *
 * Returns `[year, sub]` where sub is a fractional ordering within the year:
 *   monthly / MTD → 0.01–0.12 (Jan = 0.01, Dec = 0.12)
 *   quarterly     → 0.25 / 0.50 / 0.75 / 1.00
 *   YTD           → 1.10
 *   LTM / TTM     → 1.20
 *   annual        → 1.50
 *   FY estimate   → 1.80 (after annual — projections come last)
 *   other         → 2.00
 *
 * Used as `rows.sort((a, b) => comparePeriodChronologically(a.period, b.period))`
 * to fix the bug where alphabetical sort scrambled months
 * ("Apr-26 < Aug-26 < Dec-26 < Feb-26 < Jan-26 …").
 */

const MONTH_INDEX: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

export type PeriodScope =
  | 'annual' | 'estimate' | 'ltm' | 'ytd'
  | 'quarterly' | 'mtd' | 'monthly' | 'other';

/**
 * Classify a period label into one of our scope buckets.
 *
 * Mirrors `inferPeriodScope` in
 * apps/web-next/src/app/(app)/deals/[id]/deal-financials-period-scope.ts —
 * keep the two implementations in sync. Used by the validator's pairwise
 * growth scan so we don't compute deltas across different period scopes
 * (e.g. MRR → ARR or monthly → annual): those aren't growth, they're the
 * same quantity at a different aggregation.
 */
export function inferPeriodScope(period: string | null | undefined): PeriodScope {
  if (!period) return 'other';
  const upper = period.trim().toUpperCase();
  if (!upper) return 'other';
  if (/\bYTD\b/.test(upper)) return 'ytd';
  if (/\bMTD\b/.test(upper)) return 'mtd';
  if (/\bLTM\b/.test(upper) || /\bTTM\b/.test(upper)) return 'ltm';
  if (/\b(EST|ESTIMATE|FORECAST|BUDGET|PROJ|PROJECTED)\b/.test(upper)) return 'estimate';
  // Bare ARR / annualised revenue tokens — "Current ARR", "ARR (Annualised)".
  // Treat as annual scope so it's not grouped with monthly/MRR rows
  // (ARR ≈ MRR × 12 — a unit conversion, not growth).
  if (/\bARR\b/.test(upper) || /\bANNUAL(IZED|ISED)?\b/.test(upper)) return 'annual';
  if (/^FY\s?\d{2,4}$/.test(upper) || /^\d{4}$/.test(upper)) return 'annual';
  if (/\bQ[1-4]\b/.test(upper) || /^[1-4]Q\d{2,4}$/.test(upper) || /\bQUARTERLY\b/.test(upper)) return 'quarterly';
  const monthRe = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/;
  if (monthRe.test(upper)) return 'monthly';
  // Bare "Monthly" / "MRR" tokens — "Current Monthly", "MRR (Current)".
  if (/\bMRR\b/.test(upper) || /\bMONTHLY\b/.test(upper)) return 'monthly';
  return 'other';
}

function extractYear(upper: string): number | null {
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
  if (scope === 'monthly' || scope === 'mtd') {
    for (const [name, idx] of Object.entries(MONTH_INDEX)) {
      if (new RegExp(`\\b${name}\\b`).test(upper)) return [year, idx / 100];
    }
    return [year, 0.99];
  }
  if (scope === 'quarterly') {
    const m = upper.match(/Q([1-4])|([1-4])Q/);
    const q = m ? Number(m[1] ?? m[2]) : 1;
    return [year, q * 0.25];
  }
  if (scope === 'ytd') return [year, 1.10];
  if (scope === 'ltm') return [year, 1.20];
  if (scope === 'annual') return [year, 1.50];
  if (scope === 'estimate') return [year, 1.80];
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
