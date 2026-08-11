"use client";

// ---------------------------------------------------------------------------
// Revenue Growth chart (extracted from deal-financials-charts.tsx for the
// 500-line cap). Owns its own scope-filter and Linear/Log axis state.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Chart } from "react-chartjs-2";
import type { ChartOptions, ChartData } from "chart.js";

import {
  type PeriodScope,
  PERIOD_SCOPE_LABEL,
  groupRowsByScope,
  comparePeriodChronologically,
} from "./deal-financials-period-scope";
import {
  type AxisScale,
  type ChartScopeFilter,
  AxisScalePills,
  ChartToolbar,
  ScopeEmptyState,
  ScopeFilterPills,
  filterRowsByScope,
} from "./deal-financials-chart-controls";
import {
  type FinancialStatement,
  CHART_TOOLTIP,
  CHART_LEGEND,
} from "./deal-financials-charts-shared";
import { toActualDollars } from "@/lib/formatters";

// Per-group palette (distinct colors so the legend communicates scope).
// Negative values get the corresponding red shade for that group's hue.
const GROUP_PALETTE: Record<PeriodScope, { pos: string; neg: string; border: string }> = {
  annual:    { pos: "rgba(0,51,102,0.75)",   neg: "rgba(220,38,38,0.75)", border: "rgba(0,51,102,0.65)" },
  estimate:  { pos: "rgba(124,58,237,0.7)",  neg: "rgba(220,38,38,0.7)",  border: "rgba(124,58,237,0.6)" },
  ltm:       { pos: "rgba(13,148,136,0.7)",  neg: "rgba(220,38,38,0.7)",  border: "rgba(13,148,136,0.6)" },
  ytd:       { pos: "rgba(217,119,6,0.7)",   neg: "rgba(220,38,38,0.7)",  border: "rgba(217,119,6,0.6)" },
  quarterly: { pos: "rgba(37,99,235,0.7)",   neg: "rgba(220,38,38,0.7)",  border: "rgba(37,99,235,0.6)" },
  monthly:   { pos: "rgba(5,150,105,0.7)",   neg: "rgba(220,38,38,0.7)",  border: "rgba(5,150,105,0.6)" },
  mtd:       { pos: "rgba(2,132,199,0.7)",   neg: "rgba(220,38,38,0.7)",  border: "rgba(2,132,199,0.6)" },
  other:     { pos: "rgba(107,114,128,0.7)", neg: "rgba(220,38,38,0.7)",  border: "rgba(107,114,128,0.6)" },
};

export function GrowthChart({ statements }: { statements: FinancialStatement[] }) {
  const [scopeFilter, setScopeFilter] = useState<ChartScopeFilter>("all");
  const [axisScale, setAxisScale] = useState<AxisScale>("linear");

  // Filter by scope BEFORE sort + grouping. With a non-`all` filter, only one
  // scope reaches `groupRowsByScope` so the chart renders a single contiguous
  // series rather than scope clusters.
  const filteredRows = filterRowsByScope(
    statements.filter((s) => s.statementType === "INCOME_STATEMENT"),
    scopeFilter,
  );
  const incomeRows = filteredRows.sort((a, b) =>
    comparePeriodChronologically(a.period, b.period),
  );

  const toolbar = (
    <ChartToolbar>
      <ScopeFilterPills value={scopeFilter} onChange={setScopeFilter} />
      <AxisScalePills value={axisScale} onChange={setAxisScale} />
    </ChartToolbar>
  );

  if (incomeRows.length < 2) {
    return (
      <div className="w-full">
        {toolbar}
        {scopeFilter !== "all" && filteredRows.length === 0 ? (
          <ScopeEmptyState filter={scopeFilter} />
        ) : (
          <p className="text-xs text-gray-400 text-center py-8">Need at least 2 periods to show growth.</p>
        )}
      </div>
    );
  }

  // Group by inferred period scope so growth deltas are only computed between
  // periods of the same kind (e.g. Monthly→Monthly, never Monthly→YTD).
  const groups = groupRowsByScope(incomeRows);

  // Build a contiguous X-axis: each group's labels appear together, in order.
  // Each group becomes its own dataset, with `null` at positions outside the
  // group — this gives a natural visual gap between scope clusters.
  // The first row of each group has no prior period of the same scope, so it
  // is skipped (growth is undefined for the first point in any series).
  const allLabels: string[] = [];
  const groupSpans: { scope: PeriodScope; startIdx: number; labels: string[]; growth: (number | null)[] }[] = [];

  for (const g of groups) {
    const labels: string[] = [];
    const growth: (number | null)[] = [];
    for (let i = 1; i < g.rows.length; i++) {
      // Convert BOTH sides of the growth math to actual dollars first so a
      // row whose unitScale differs from its neighbour doesn't produce a
      // 999,999% jump. With consistent extraction this is a no-op; with
      // mixed scales it gives the analyst a true growth percentage.
      const prev = toActualDollars(
        g.rows[i - 1].lineItems?.revenue ?? null,
        g.rows[i - 1].unitScale,
      );
      const curr = toActualDollars(
        g.rows[i].lineItems?.revenue ?? null,
        g.rows[i].unitScale,
      );
      if (prev != null && curr != null && prev !== 0) {
        const pct = ((curr - prev) / Math.abs(prev)) * 100;
        labels.push(g.rows[i].period);
        growth.push(parseFloat(pct.toFixed(1)));
      }
    }
    if (labels.length > 0) {
      groupSpans.push({ scope: g.scope, startIdx: allLabels.length, labels, growth });
      allLabels.push(...labels);
    }
  }

  if (allLabels.length === 0) {
    return (
      <div className="w-full">
        {toolbar}
        {scopeFilter !== "all" ? (
          <ScopeEmptyState filter={scopeFilter} />
        ) : (
          <p className="text-xs text-gray-400 text-center py-8">No revenue data available for growth calculation.</p>
        )}
      </div>
    );
  }

  // Log-scale clipping: Chart.js's logarithmic axis can't render values <= 0.
  // For the rendered data we clip negatives (and zero) to a visible floor of
  // 0.1%. The tooltip still shows the original signed value via `originalData`
  // so the comparison stays honest.
  const isLog = axisScale === "logarithmic";
  const LOG_FLOOR = 0.1;

  // One dataset per scope group. Each dataset has `null` outside its own span
  // so bars only render in their group's slot — this creates the visual divider.
  const datasets = groupSpans.map((span) => {
    const fullData: (number | null)[] = new Array(allLabels.length).fill(null);
    const originalData: (number | null)[] = new Array(allLabels.length).fill(null);
    const bgColors: string[] = new Array(allLabels.length).fill("rgba(0,0,0,0)");
    const borderColors: string[] = new Array(allLabels.length).fill("rgba(0,0,0,0)");
    const palette = GROUP_PALETTE[span.scope];
    for (let i = 0; i < span.growth.length; i++) {
      const v = span.growth[i];
      const slot = span.startIdx + i;
      originalData[slot] = v;
      // Clip non-positive values when on the log axis so Chart.js doesn't drop
      // the bar entirely (or worse, crash).
      const renderValue =
        v == null ? null : isLog ? (v > 0 ? v : LOG_FLOOR) : v;
      fullData[slot] = renderValue;
      bgColors[slot] = (v ?? 0) >= 0 ? palette.pos : palette.neg;
      borderColors[slot] = (v ?? 0) >= 0 ? palette.border : "rgba(220,38,38,0.6)";
    }
    return {
      label: PERIOD_SCOPE_LABEL[span.scope],
      data: fullData,
      // Carried alongside `data` so the tooltip can show the true (signed) value
      // even when the bar height is the clipped log-floor.
      originalData,
      backgroundColor: bgColors,
      borderColor: borderColors,
      borderWidth: 1,
      borderRadius: 6,
      borderSkipped: false,
      barPercentage: 0.65,
      categoryPercentage: 0.9,
    };
  });

  // Did we actually clip anything? Used to surface a "Negative values shown at
  // floor on log scale" note in the tooltip without spamming it on every bar.
  const hasClippedNegatives =
    isLog && datasets.some((d) => d.originalData.some((v) => v != null && v <= 0));

  const data: ChartData<"bar", (number | null)[], string> = {
    labels: allLabels,
    datasets,
  };

  // Tooltip needs to know which scope a given X position belongs to so the
  // header can label the comparison correctly.
  const scopeForLabelIdx = new Array(allLabels.length).fill("other") as PeriodScope[];
  for (const span of groupSpans) {
    for (let i = 0; i < span.labels.length; i++) {
      scopeForLabelIdx[span.startIdx + i] = span.scope;
    }
  }

  const options: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: groupSpans.length > 1
        ? { ...CHART_LEGEND, labels: { ...CHART_LEGEND.labels } }
        : { display: false },
      tooltip: {
        ...CHART_TOOLTIP,
        callbacks: {
          title: (items) => {
            const idx = items[0]?.dataIndex ?? 0;
            const label = items[0]?.label ?? "";
            const scope = scopeForLabelIdx[idx] ?? "other";
            return `${label} · ${PERIOD_SCOPE_LABEL[scope]}`;
          },
          label: (ctx) => {
            // In log mode the bar height is the clipped floor; show the real
            // signed value from `originalData` so the user sees the true growth.
            const ds = ctx.dataset as { originalData?: (number | null)[] };
            const trueValue = (ds.originalData?.[ctx.dataIndex] ?? ctx.raw) as number | null;
            if (trueValue === null || trueValue === undefined) return "";
            const sign = trueValue >= 0 ? "+" : "";
            return ` Revenue Growth: ${sign}${trueValue.toFixed(1)}%`;
          },
          afterBody: (items) => {
            // One-line note when at least one displayed bar is clipped to the
            // log floor — keeps the chart honest without per-bar noise.
            if (!hasClippedNegatives) return "";
            const ds = items[0]?.dataset as { originalData?: (number | null)[] } | undefined;
            const idx = items[0]?.dataIndex ?? -1;
            const trueValue = ds?.originalData?.[idx];
            if (trueValue != null && trueValue <= 0) {
              return "(Negative — shown at log floor)";
            }
            return "";
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
      y: isLog
        ? {
            type: "logarithmic",
            min: LOG_FLOOR,
            ticks: {
              font: { size: 10, family: "Inter" },
              color: "#9ca3af",
              callback: (v) => (Number(v) >= 1 ? "+" + v : v) + "%",
              padding: 8,
            },
            grid: { color: "rgba(0,0,0,0.04)" },
            border: { display: false },
          }
        : {
            type: "linear",
            ticks: {
              font: { size: 10, family: "Inter" },
              color: "#9ca3af",
              callback: (v) => (Number(v) >= 0 ? "+" : "") + v + "%",
              padding: 8,
            },
            grid: { color: "rgba(0,0,0,0.04)" },
            border: { display: false },
          },
    },
  };

  return (
    <div className="w-full">
      {toolbar}
      <div className="relative w-full bg-white rounded-lg border border-gray-200 p-4" style={{ height: 320 }}>
        <Chart type="bar" data={data} options={options} />
      </div>
    </div>
  );
}
