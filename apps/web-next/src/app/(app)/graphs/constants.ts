import type { ChartType, MetricDef } from "./types";

// TODO(currency): hardcoded for now. Future work: derive the currency symbol
// and unit scale from the deal's FinancialStatement rows (each row carries
// `currency` and `unitScale`) and thread it through Builder → ChartRenderer
// so a USD-thousands deal renders "$ K" while an INR-crore deal renders "₹ Cr".
export const CURRENCY_LABEL = "$ M";

export const METRIC_CATALOG: MetricDef[] = [
  { key: "revenue",      label: "Revenue",            kind: "absolute", source: "P&L" },
  { key: "cogs",         label: "COGS",               kind: "absolute", source: "P&L" },
  { key: "grossProfit",  label: "Gross Profit",       kind: "absolute", source: "P&L" },
  { key: "opex",         label: "Operating Expenses", kind: "absolute", source: "P&L" },
  { key: "ebitda",       label: "EBITDA",             kind: "absolute", source: "P&L" },
  { key: "netIncome",    label: "Net Income",         kind: "absolute", source: "P&L" },
  { key: "grossMargin",  label: "Gross Margin %",     kind: "percent",  source: "Analysis" },
  { key: "ebitdaMargin", label: "EBITDA Margin %",    kind: "percent",  source: "Analysis" },
  { key: "netMargin",    label: "Net Margin %",       kind: "percent",  source: "Analysis" },
];

export const PALETTE = [
  "#1e3a8a", "#0d9488", "#ea580c", "#7c3aed",
  "#dc2626", "#0891b2", "#ca8a04", "#475569",
];

export const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: "bar",   label: "Bar" },
  { key: "line",  label: "Line" },
  { key: "area",  label: "Area" },
  { key: "combo", label: "Combo" },
];
