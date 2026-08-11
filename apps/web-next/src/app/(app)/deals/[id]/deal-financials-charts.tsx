"use client";

import { useRef, useState } from "react";
import type { Chart as ChartJS, ChartOptions, ChartData } from "chart.js";
import { Chart } from "react-chartjs-2";

import { comparePeriodChronologically } from "./deal-financials-period-scope";
import {
  type ChartScopeFilter,
  ChartToolbar,
  ScopeEmptyState,
  ScopeFilterPills,
  filterRowsByScope,
} from "./deal-financials-chart-controls";
import {
  type FinancialStatement,
  CHART_TOOLTIP,
  CHART_LEGEND,
  analyzeActualDollarSeries,
  scaleActualToUnit,
  suggestedMaxExcludingOutliers,
} from "./deal-financials-charts-shared";
import {
  formatChartAxisValue,
  formatFinancialValue,
  toActualDollars,
} from "@/lib/formatters";

// Re-export so existing consumers (deal-financials.tsx) don't have to change
// their import paths after the file split.
export type { FinancialStatement } from "./deal-financials-charts-shared";
export { GrowthChart } from "./deal-financials-chart-growth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Avoid mixing annual totals with quarterly data on the same chart. */
function filterConsistentPeriods(rows: FinancialStatement[]): FinancialStatement[] {
  const isFY = (p: string) => /^FY\b/i.test(p) || /^\d{4}$/i.test(p);
  const fyRows = rows.filter((r) => isFY(r.period));
  const nonFyRows = rows.filter((r) => !isFY(r.period));
  if (fyRows.length > 0 && nonFyRows.length >= 2) return nonFyRows;
  return rows;
}

// ---------------------------------------------------------------------------
// Revenue + EBITDA + Margin chart
// ---------------------------------------------------------------------------

export function RevenueChart({ statements }: { statements: FinancialStatement[] }) {
  const canvasRef = useRef<ChartJS | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ChartScopeFilter>("all");

  // Filter by scope BEFORE sort + chart construction so the empty-state check
  // sees the post-filter row count.
  let rows = statements.filter((s) => s.statementType === "INCOME_STATEMENT");
  rows = filterRowsByScope(rows, scopeFilter);
  rows = rows.sort((a, b) => comparePeriodChronologically(a.period, b.period));

  // Only fall back to FY-vs-non-FY consistency filtering when the user hasn't
  // already locked the scope down. With an explicit scope filter, all rows
  // share a scope by definition.
  if (scopeFilter === "all") {
    rows = filterConsistentPeriods(rows);
  }

  const toolbar = (
    <ChartToolbar>
      <ScopeFilterPills value={scopeFilter} onChange={setScopeFilter} />
    </ChartToolbar>
  );

  if (rows.length === 0) {
    return (
      <div className="w-full">
        {toolbar}
        {scopeFilter === "all" ? (
          <p className="text-xs text-gray-400 text-center py-8">No income statement data available.</p>
        ) : (
          <ScopeEmptyState filter={scopeFilter} />
        )}
      </div>
    );
  }

  const labels = rows.map((r) => r.period);
  // Convert each row's stored value into actual dollars using its own
  // `unitScale` so the y-axis auto-scales correctly even when periods mix scales.
  const revenuesActual = rows.map((r) =>
    toActualDollars(r.lineItems?.revenue ?? null, r.unitScale),
  );
  const ebitdasActual = rows.map((r) =>
    toActualDollars(r.lineItems?.ebitda ?? null, r.unitScale),
  );
  const margins = rows.map((r) => r.lineItems?.ebitda_margin_pct ?? null);
  const currency = rows[0]?.currency ?? "USD";

  // Detect outlier rows (typical cause: a single statement mis-tagged with
  // the wrong unitScale, multiplying its value by 1e3 or 1e6 vs the rest).
  // We analyse the combined revenue + EBITDA series so the threshold reflects
  // the chart's real magnitude band — flagging an outlier in either field
  // counts as an outlier for that row.
  const revAnalysis = analyzeActualDollarSeries(revenuesActual);
  const ebdAnalysis = analyzeActualDollarSeries(ebitdasActual);
  // Pick the display unit from whichever series has a usable median; revenue
  // is the larger series typically, so prefer it when both exist.
  const displayUnit = revAnalysis.median != null ? revAnalysis.unit : ebdAnalysis.unit;
  const rowOutliers = revAnalysis.outliers.map((o, i) => o || ebdAnalysis.outliers[i]);
  const hasOutlier = rowOutliers.some(Boolean);

  // Scale dataset values into the chosen display unit so Chart.js's tick
  // callback can render the tick as-is. Outlier rows keep their (huge)
  // value so the analyst can see them — but they are excluded from the
  // suggestedMax computation so the y-axis stays anchored to the sane
  // majority of the dataset.
  const revenues = revenuesActual.map((v) => scaleActualToUnit(v, displayUnit));
  const ebitdas = ebitdasActual.map((v) => scaleActualToUnit(v, displayUnit));

  const revMax = suggestedMaxExcludingOutliers(revenuesActual, rowOutliers);
  const ebdMax = suggestedMaxExcludingOutliers(ebitdasActual, rowOutliers);
  const suggestedMaxActual =
    revMax != null && ebdMax != null
      ? Math.max(revMax, ebdMax)
      : revMax ?? ebdMax;
  const suggestedMax =
    suggestedMaxActual != null ? scaleActualToUnit(suggestedMaxActual, displayUnit) : null;

  const data: ChartData<"bar" | "line", (number | null)[], string> = {
    labels,
    datasets: [
      {
        type: "bar" as const,
        label: "Revenue",
        data: revenues,
        backgroundColor: "rgba(0,51,102,0.7)",
        borderColor: "transparent",
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
        yAxisID: "y",
        order: 2,
        barPercentage: 0.7,
        categoryPercentage: 0.8,
      },
      {
        type: "bar" as const,
        label: "EBITDA",
        data: ebitdas,
        backgroundColor: "rgba(5,150,105,0.7)",
        borderColor: "transparent",
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
        yAxisID: "y",
        order: 2,
        barPercentage: 0.7,
        categoryPercentage: 0.8,
      },
      {
        type: "line" as const,
        label: "EBITDA Margin %",
        data: margins,
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245,158,11,0.08)",
        fill: true,
        pointBackgroundColor: "#fff",
        pointBorderColor: "#f59e0b",
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        borderWidth: 2.5,
        tension: 0.4,
        yAxisID: "y1",
        order: 1,
        spanGaps: true,
      },
    ],
  };

  const options: ChartOptions<"bar" | "line"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: CHART_LEGEND,
      tooltip: {
        ...CHART_TOOLTIP,
        callbacks: {
          title: (items) => {
            const r = rows[items[0]?.dataIndex ?? 0];
            return r ? `${r.period}${r.periodType === "PROJECTED" ? " (Projected)" : ""}` : "";
          },
          label(ctx) {
            const v = ctx.raw as number | null;
            if (v === null || v === undefined) return "";
            if (ctx.dataset.yAxisID === "y1") return ` EBITDA Margin: ${Number(v).toFixed(1)}%`;
            // `v` is in the picked display unit; convert back to actual
            // dollars for `formatFinancialValue` so it picks the best
            // human-readable scale and the user sees the true magnitude
            // (especially helpful when a row is an outlier).
            const idx = ctx.dataIndex;
            const actual =
              ctx.dataset.label === "Revenue"
                ? revenuesActual[idx]
                : ctx.dataset.label === "EBITDA"
                  ? ebitdasActual[idx]
                  : null;
            const display = actual != null
              ? formatFinancialValue(actual, "ACTUALS", { currency })
              : formatChartAxisValue(v, displayUnit, { currency });
            const flag = rowOutliers[idx] ? " ⚠ inconsistent unit" : "";
            return ` ${ctx.dataset.label}: ${display}${flag}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 11, family: "Inter" }, color: "#9ca3af", maxRotation: 45 },
        border: { display: false },
      },
      y: {
        type: "linear",
        position: "left",
        ticks: {
          font: { size: 10, family: "Inter" },
          color: "#9ca3af",
          // `v` is already in the picked display unit (K/M/B/units) — render
          // the tick using `formatChartAxisValue` so the suffix is consistent
          // across the axis and never mis-labels e.g. raw $1,500 as $0.0M.
          callback: (v) => formatChartAxisValue(Number(v), displayUnit, { currency }),
          padding: 8,
        },
        grid: { color: "rgba(0,0,0,0.04)" },
        border: { display: false },
        beginAtZero: true,
        // Anchor the y-axis to the sane majority of the dataset so a single
        // mis-tagged outlier row doesn't blow the scale (DMpro bug B2).
        ...(suggestedMax != null ? { suggestedMax } : {}),
      },
      y1: {
        type: "linear",
        position: "right",
        title: { display: true, text: "Margin %", font: { size: 11, family: "Inter", weight: "normal" }, color: "#d97706" },
        ticks: {
          font: { size: 10, family: "Inter" },
          color: "#d97706",
          callback: (v) => v + "%",
          padding: 8,
        },
        grid: { drawOnChartArea: false },
        border: { display: false },
      },
    },
  };

  return (
    <div className="w-full">
      {toolbar}
      {hasOutlier ? (
        <div
          className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-2"
          role="status"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            Inconsistent unit detected — one or more statements have a value{" "}
            {">"}1000x the median. The y-axis is scaled to the rest of the
            dataset; outlier rows still render but their bars may overflow.
            Review extraction on the flagged period(s).
          </span>
        </div>
      ) : null}
      <div className="relative w-full bg-white rounded-lg border border-gray-200 p-4" style={{ height: 320 }}>
        {/* @ts-expect-error -- react-chartjs-2 mixed type chart has loose generics */}
        <Chart ref={canvasRef} type="bar" data={data} options={options} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Balance Sheet Composition chart
// ---------------------------------------------------------------------------

export function BalanceSheetChart({ statements }: { statements: FinancialStatement[] }) {
  const [scopeFilter, setScopeFilter] = useState<ChartScopeFilter>("all");

  // Filter by scope BEFORE sort so empty-state checks see the right count.
  const filteredBaseRows = filterRowsByScope(
    statements.filter((s) => s.statementType === "BALANCE_SHEET"),
    scopeFilter,
  );
  const rows = filteredBaseRows.sort((a, b) => comparePeriodChronologically(a.period, b.period));

  const toolbar = (
    <ChartToolbar>
      <ScopeFilterPills value={scopeFilter} onChange={setScopeFilter} />
    </ChartToolbar>
  );

  if (rows.length === 0) {
    return (
      <div className="w-full">
        {toolbar}
        {scopeFilter !== "all" ? (
          <ScopeEmptyState filter={scopeFilter} />
        ) : (
          <p className="text-xs text-gray-400 text-center py-8">No balance sheet data available.</p>
        )}
      </div>
    );
  }

  const chartKeys = [
    "cash", "accounts_receivable", "inventory", "ppe_net", "goodwill", "intangibles",
    "total_current_liabilities", "long_term_debt", "total_equity", "total_assets", "total_liabilities",
  ];
  const hasChartData = rows.some((r) => chartKeys.some((k) => r.lineItems?.[k] != null && r.lineItems[k] !== 0));
  if (!hasChartData) {
    return (
      <div className="w-full">
        {toolbar}
        <p className="text-xs text-gray-400 text-center py-8">Balance sheet data exists but key values are not yet extracted.</p>
      </div>
    );
  }

  const labels = rows.map((r) => r.period);
  // Convert per-row to actual dollars so the y-axis auto-scales uniformly.
  const liActual = (row: FinancialStatement, key: string) =>
    toActualDollars(row.lineItems?.[key] ?? 0, row.unitScale) ?? 0;
  const currency = rows[0]?.currency ?? "USD";

  // Outlier detection on the balance sheet: pick the largest balance-sheet
  // signal per row (total_assets when present, otherwise sum of asset
  // line items) and analyze that series. A row mis-tagged with the wrong
  // unitScale inflates every line item by the same factor, so a single
  // metric is enough to catch it.
  const rowSignals = rows.map((r) => {
    const ta = toActualDollars(r.lineItems?.total_assets ?? null, r.unitScale);
    if (ta != null && ta !== 0) return ta;
    // Fallback: sum the asset stack so we still flag rows missing total_assets.
    return (
      liActual(r, "cash") +
      liActual(r, "accounts_receivable") +
      liActual(r, "inventory") +
      liActual(r, "ppe_net") +
      liActual(r, "goodwill") +
      liActual(r, "intangibles")
    );
  });
  const bsAnalysis = analyzeActualDollarSeries(rowSignals);
  const displayUnit = bsAnalysis.unit;
  const rowOutliers = bsAnalysis.outliers;
  const hasOutlier = bsAnalysis.hasOutlier;

  // Scale every line-item value into the picked display unit. Outliers keep
  // their (huge) value — the suggestedMax below clamps the axis to the
  // sane majority so the chart stays usable.
  const li = (row: FinancialStatement, key: string) =>
    scaleActualToUnit(liActual(row, key), displayUnit) ?? 0;

  // Compute per-row totals (assets stack and liab+equity stack) in actual
  // dollars, then use the larger of the two non-outlier maxes as the
  // suggestedMax. This is what would normally drive the y-axis scaling.
  const assetTotalsActual = rows.map(
    (r) =>
      liActual(r, "cash") +
      liActual(r, "accounts_receivable") +
      liActual(r, "inventory") +
      liActual(r, "ppe_net") +
      liActual(r, "goodwill") +
      liActual(r, "intangibles"),
  );
  const liabTotalsActual = rows.map(
    (r) =>
      liActual(r, "total_current_liabilities") +
      liActual(r, "long_term_debt") +
      liActual(r, "total_equity"),
  );
  const assetsMax = suggestedMaxExcludingOutliers(assetTotalsActual, rowOutliers);
  const liabMax = suggestedMaxExcludingOutliers(liabTotalsActual, rowOutliers);
  const suggestedMaxActual =
    assetsMax != null && liabMax != null
      ? Math.max(assetsMax, liabMax)
      : assetsMax ?? liabMax;
  const suggestedMax =
    suggestedMaxActual != null
      ? scaleActualToUnit(suggestedMaxActual, displayUnit)
      : null;

  const data: ChartData<"bar", number[], string> = {
    labels,
    datasets: [
      { label: "Cash", data: rows.map((r) => li(r, "cash")), backgroundColor: "#003366", stack: "assets", borderWidth: 0, borderRadius: 3 },
      { label: "Receivables", data: rows.map((r) => li(r, "accounts_receivable")), backgroundColor: "#2563eb", stack: "assets", borderWidth: 0, borderRadius: 3 },
      { label: "Inventory", data: rows.map((r) => li(r, "inventory")), backgroundColor: "#60a5fa", stack: "assets", borderWidth: 0, borderRadius: 3 },
      { label: "PP&E", data: rows.map((r) => li(r, "ppe_net")), backgroundColor: "#93c5fd", stack: "assets", borderWidth: 0, borderRadius: 3 },
      { label: "Goodwill + Intangibles", data: rows.map((r) => li(r, "goodwill") + li(r, "intangibles")), backgroundColor: "#bfdbfe", stack: "assets", borderWidth: 0, borderRadius: 3 },
      { label: "Current Liab.", data: rows.map((r) => li(r, "total_current_liabilities")), backgroundColor: "#dc2626", stack: "liabilities", borderWidth: 0, borderRadius: 3 },
      { label: "LT Debt", data: rows.map((r) => li(r, "long_term_debt")), backgroundColor: "#f87171", stack: "liabilities", borderWidth: 0, borderRadius: 3 },
      { label: "Equity", data: rows.map((r) => li(r, "total_equity")), backgroundColor: "#059669", stack: "liabilities", borderWidth: 0, borderRadius: 3 },
    ],
  };

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        ...CHART_LEGEND,
        labels: { ...CHART_LEGEND.labels, font: { size: 10, family: "Inter", weight: "normal" }, boxWidth: 10, padding: 12 },
      },
      tooltip: {
        ...CHART_TOOLTIP,
        callbacks: {
          label: (ctx) => {
            const v = ctx.raw as number;
            if (!v) return "";
            // `v` is in `displayUnit`; convert back to actual dollars so
            // `formatFinancialValue` picks the right human magnitude.
            const actual =
              displayUnit === "units"
                ? v
                : displayUnit === "K"
                  ? v * 1_000
                  : displayUnit === "M"
                    ? v * 1_000_000
                    : v * 1_000_000_000;
            const flag = rowOutliers[ctx.dataIndex] ? " ⚠ inconsistent unit" : "";
            return ` ${ctx.dataset.label}: ${formatFinancialValue(actual, "ACTUALS", { currency })}${flag}`;
          },
        },
      },
      title: {
        display: true,
        text: "Assets  vs  Liabilities + Equity",
        font: { size: 11, family: "Inter", weight: "normal" },
        color: "#9ca3af",
        padding: { bottom: 8 },
      },
    },
    scales: {
      x: {
        stacked: true,
        grid: { display: false },
        ticks: { font: { size: 11, family: "Inter" }, color: "#9ca3af" },
        border: { display: false },
      },
      y: {
        stacked: true,
        ticks: {
          font: { size: 10, family: "Inter" },
          color: "#9ca3af",
          callback: (v) => formatChartAxisValue(Number(v), displayUnit, { currency }),
          padding: 8,
        },
        grid: { color: "rgba(0,0,0,0.04)" },
        border: { display: false },
        ...(suggestedMax != null ? { suggestedMax } : {}),
      },
    },
  };

  return (
    <div className="w-full">
      {toolbar}
      {hasOutlier ? (
        <div
          className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-2"
          role="status"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            Inconsistent unit detected on at least one balance-sheet period —
            value {">"}1000x the median. Axis scaled to the rest of the
            dataset; review extraction on the flagged period(s).
          </span>
        </div>
      ) : null}
      <div className="relative w-full bg-white rounded-lg border border-gray-200 p-4" style={{ height: 320 }}>
        <Chart type="bar" data={data} options={options} />
      </div>
    </div>
  );
}
