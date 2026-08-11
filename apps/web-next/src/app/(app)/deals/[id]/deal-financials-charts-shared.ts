"use client";

// ---------------------------------------------------------------------------
// Shared Chart.js setup + tooltip/legend config used by every Financial chart.
// ---------------------------------------------------------------------------
//
// Lives in its own module so each chart file stays under the 500-line cap and
// so Chart.js component registration only happens once across the panel.

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  BarElement,
  BarController,
  LineElement,
  LineController,
  PointElement,
  Filler,
  Tooltip,
  Legend,
  Title,
} from "chart.js";

import {
  type DisplayUnit,
  inferUnitFromMagnitude,
  toActualDollars,
} from "@/lib/formatters";

// Register Chart.js primitives once for the whole financials panel.
ChartJS.register(
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  BarElement,
  BarController,
  LineElement,
  LineController,
  PointElement,
  Filler,
  Tooltip,
  Legend,
  Title,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FinancialStatement {
  id: string;
  statementType: "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";
  period: string;
  periodType?: "ACTUAL" | "PROJECTED";
  currency?: string;
  unitScale?: "ACTUALS" | "THOUSANDS" | "MILLIONS" | "BILLIONS";
  extractionConfidence?: number | null;
  extractionSource?: string | null;
  lineItems?: Record<string, number | null>;
  Document?: { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Shared tooltip / legend defaults (ported from legacy CHART_TOOLTIP / CHART_LEGEND)
// ---------------------------------------------------------------------------

export const CHART_TOOLTIP = {
  backgroundColor: "rgba(255,255,255,0.98)",
  titleColor: "#111827",
  titleFont: { size: 12 as const, family: "Inter", weight: "bold" as const },
  bodyColor: "#4b5563",
  bodyFont: { size: 11 as const, family: "Inter" },
  borderColor: "#e5e7eb",
  borderWidth: 1,
  padding: { top: 10, bottom: 10, left: 14, right: 14 },
  cornerRadius: 10,
  boxPadding: 4,
  usePointStyle: true as const,
  caretSize: 6,
};

export const CHART_LEGEND = {
  position: "bottom" as const,
  labels: {
    font: { size: 11 as const, family: "Inter", weight: "normal" as const },
    boxWidth: 14,
    boxHeight: 8,
    padding: 18,
    color: "#6b7280",
    usePointStyle: true as const,
    pointStyleWidth: 14,
  },
};

// ---------------------------------------------------------------------------
// Outlier / display-unit analysis for the financials chart pack
//
// Problem we are solving (DMpro deal, bug B2):
//   A single mis-classified row (unitScale: MILLIONS on a raw-dollar
//   statement) multiplies through `toActualDollars` by 1,000,000 and that
//   one row dominates the chart — a 1,473 value becomes $1.473B, blowing
//   the y-axis from a sensible range like $0–$50K up to $-2B–$16B and
//   collapsing every legitimate bar to invisible.
//
// Strategy:
//   1. Convert every row to actual dollars using its OWN unitScale (the
//      caller does this; we receive the already-converted values).
//   2. Compute the median of the |non-zero| converted values. Median is
//      robust to a small number of inflated outliers.
//   3. Flag any row whose |converted value| > 1000x the median as an
//      outlier. 1000x is the typical magnitude jump from a single bad
//      unitScale step (ACTUALS -> THOUSANDS, THOUSANDS -> MILLIONS, etc.),
//      so this threshold catches exactly the failure mode without false-
//      flagging genuinely big bars.
//   4. Pick the display unit from the median: 5,000,000 -> "M",
//      1,500 -> "K", etc. Tick callbacks then scale the rendered value
//      from raw dollars to the display unit.
//
// Outliers stay rendered (so the analyst can see the suspicious data) but
// they are excluded from the auto-scale: the chart's `suggestedMax` is
// driven by the non-outlier values, so the y-axis stays usable. The chart
// also surfaces a one-line warning when any outliers were flagged.
// ---------------------------------------------------------------------------

const OUTLIER_RATIO = 1000;

/**
 * Compute the median of the absolute value of the finite, non-zero entries
 * in `values`. Returns `null` when no finite non-zero entry exists.
 * Median of `[]` and median over an all-zero series are both `null` so the
 * caller knows to fall back to a default unit.
 */
export function medianAbs(values: ReadonlyArray<number | null>): number | null {
  const filtered: number[] = [];
  for (const v of values) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const a = Math.abs(n);
    if (a === 0) continue;
    filtered.push(a);
  }
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => a - b);
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0
    ? (filtered[mid - 1] + filtered[mid]) / 2
    : filtered[mid];
}

export interface ChartUnitAnalysis {
  /** Display unit picked for the y-axis. `"units"` when the median magnitude is < $1k. */
  unit: DisplayUnit;
  /** Median |actual-dollar| of non-outlier rows, or `null` when no usable rows. */
  median: number | null;
  /** Per-row outlier flag, parallel to the input. */
  outliers: boolean[];
  /** True when at least one outlier was flagged. */
  hasOutlier: boolean;
}

/**
 * Analyze a single-series list of actual-dollar values for outliers and pick
 * a display unit (K/M/B/units) anchored to the non-outlier median.
 *
 * Inputs that are `null` (missing value) are treated as non-outliers.
 *
 * Outlier predicate: |value| > OUTLIER_RATIO (1000) * median(|non-zero values|).
 * That mirrors a single-step unitScale mismatch (ACTUALS labelled as
 * THOUSANDS multiplies by 1k; THOUSANDS labelled as MILLIONS multiplies by
 * 1k as well). 1000x is the smallest ratio that distinguishes a real "tail"
 * data point from a unit-scale bug.
 */
export function analyzeActualDollarSeries(
  values: ReadonlyArray<number | null>,
): ChartUnitAnalysis {
  const med = medianAbs(values);
  if (med == null) {
    // No usable data — keep the historical default ("M") so the axis stays
    // stable instead of flipping between scales on an empty series.
    return {
      unit: "M",
      median: null,
      outliers: values.map(() => false),
      hasOutlier: false,
    };
  }
  const threshold = med * OUTLIER_RATIO;
  const outliers = values.map((v) => {
    if (v == null) return false;
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
    return Math.abs(n) > threshold;
  });

  // Pick the display unit from the median magnitude — this is the typical
  // bar height, which is what we want anchoring the axis.
  return {
    unit: inferUnitFromMagnitude(med),
    median: med,
    outliers,
    hasOutlier: outliers.some(Boolean),
  };
}

/**
 * Convert a value already in actual dollars to the supplied display unit.
 * Used by the tick callback so we can render `$1.5K` from a raw 1500.
 * `"units"` returns the value as-is.
 */
export function scaleActualToUnit(
  value: number | null | undefined,
  unit: DisplayUnit,
): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === "units") return n;
  if (unit === "K") return n / 1_000;
  if (unit === "M") return n / 1_000_000;
  if (unit === "B") return n / 1_000_000_000;
  return n;
}

/**
 * Compute the cap for the y-axis (`suggestedMax`) from the NON-outlier
 * values plus a 15% headroom. Returns `null` when no usable non-outlier
 * value exists, so the chart can fall back to Chart.js's default scaling.
 */
export function suggestedMaxExcludingOutliers(
  values: ReadonlyArray<number | null>,
  outliers: ReadonlyArray<boolean>,
): number | null {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (outliers[i]) continue;
    const v = values[i];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (n > max) max = n;
  }
  if (max === -Infinity) return null;
  return max * 1.15;
}

// Re-export the formatters helpers so chart files can pull everything from
// the shared module without juggling two import paths.
export { toActualDollars, inferUnitFromMagnitude };
export type { DisplayUnit };
