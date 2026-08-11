"use client";

// ---------------------------------------------------------------------------
// Shared chart-toolbar primitives for the Financial Analysis charts
// ---------------------------------------------------------------------------
//
// Per-chart toggle pills used by RevenueChart / GrowthChart / BalanceSheetChart
// to filter rows by inferred period scope, and (Growth-only) to flip the Y-axis
// between linear and logarithmic scaling. Lives in its own module so the main
// charts file stays under the 500-line cap.

import { cn } from "@/lib/cn";
import { type PeriodScope, inferPeriodScope } from "./deal-financials-period-scope";
import type { FinancialStatement } from "./deal-financials-charts-shared";

// ---------------------------------------------------------------------------
// Scope filter pill
// ---------------------------------------------------------------------------

/** Filter buckets exposed in the per-chart pill row. `all` is the default.
 *
 * Two buckets, both include projected:
 * - `monthly` → single-month periods (Jan-26, Apr-26 MTD, etc.)
 * - `yearly`  → every multi-month aggregate (annual / FY estimate /
 *   LTM / TTM / YTD cumulative / quarterly / anything else)
 *
 * `periodType: PROJECTED` is included in both buckets — the filter is
 * about how big a window the row covers, not whether it's actuals or
 * forecasts.
 */
export type ChartScopeFilter = "all" | "monthly" | "yearly";

/** Every scope-filter option except `all`, paired with the underlying
 * `PeriodScope` values it accepts. Drives both the pill row and the row filter. */
const SCOPE_FILTER_TO_SCOPES: Record<Exclude<ChartScopeFilter, "all">, PeriodScope[]> = {
  monthly: ["monthly", "mtd"],
  // Yearly bucket = every aggregate scope. Quarterly + ytd + ltm sit here
  // because they all cover more than a single month. `other` is included
  // so periods we couldn't classify don't silently disappear from the chart.
  yearly: ["annual", "estimate", "quarterly", "ytd", "ltm", "other"],
};

const SCOPE_FILTER_LABEL: Record<ChartScopeFilter, string> = {
  all: "All",
  monthly: "Monthly",
  yearly: "Yearly",
};

const SCOPE_FILTER_ORDER: ChartScopeFilter[] = ["all", "monthly", "yearly"];

/**
 * Apply a scope filter to a row list. Use BEFORE chronological sort + chart
 * construction so empty-state checks see the post-filter row count.
 */
export function filterRowsByScope(
  rows: FinancialStatement[],
  filter: ChartScopeFilter,
): FinancialStatement[] {
  if (filter === "all") return rows;
  const allowed = new Set<PeriodScope>(SCOPE_FILTER_TO_SCOPES[filter]);
  return rows.filter((r) => allowed.has(inferPeriodScope(r.period)));
}

/** Pill row that lets the user pick a scope filter. Inactive pills are slate;
 * the active pill uses the project's Banker Blue (`#003366`) inline. */
export function ScopeFilterPills({
  value,
  onChange,
}: {
  value: ChartScopeFilter;
  onChange: (next: ChartScopeFilter) => void;
}) {
  return (
    <div className="flex gap-1 bg-gray-50 rounded-lg p-0.5 border border-gray-100">
      {SCOPE_FILTER_ORDER.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "px-2.5 py-1 text-[10px] font-medium rounded-md transition-all",
              active ? "text-white shadow-sm" : "text-gray-500 hover:text-gray-800",
            )}
            style={active ? { backgroundColor: "#003366" } : undefined}
          >
            {SCOPE_FILTER_LABEL[opt]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linear / Log axis toggle (Growth chart only)
// ---------------------------------------------------------------------------

export type AxisScale = "linear" | "logarithmic";

const AXIS_SCALE_LABEL: Record<AxisScale, string> = {
  linear: "Linear",
  logarithmic: "Log",
};

/** Two-pill toggle to flip the Y-axis between linear and logarithmic. */
export function AxisScalePills({
  value,
  onChange,
}: {
  value: AxisScale;
  onChange: (next: AxisScale) => void;
}) {
  return (
    <div className="flex gap-1 bg-gray-50 rounded-lg p-0.5 border border-gray-100">
      {(["linear", "logarithmic"] as const).map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "px-2.5 py-1 text-[10px] font-medium rounded-md transition-all",
              active ? "text-white shadow-sm" : "text-gray-500 hover:text-gray-800",
            )}
            style={active ? { backgroundColor: "#003366" } : undefined}
          >
            {AXIS_SCALE_LABEL[opt]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state shown when the post-filter row count is zero
// ---------------------------------------------------------------------------

const SCOPE_FILTER_NICE_NAME: Record<ChartScopeFilter, string> = {
  all: "",
  monthly: "monthly",
  yearly: "yearly",
};

export function ScopeEmptyState({ filter }: { filter: ChartScopeFilter }) {
  const niceName = SCOPE_FILTER_NICE_NAME[filter];
  const msg = niceName
    ? `No ${niceName} data available — try a different filter.`
    : "No data available.";
  return <p className="text-xs text-gray-400 text-center py-8">{msg}</p>;
}

// ---------------------------------------------------------------------------
// Toolbar container — wraps a row of pill controls above the chart canvas
// ---------------------------------------------------------------------------

/** Right-aligned toolbar slot for the pill controls. Shared by all charts so
 * the spacing/styling stays in one place. */
export function ChartToolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 mb-2 flex-wrap">{children}</div>;
}
