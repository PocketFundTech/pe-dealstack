// Types + pure helpers for the "Build model" panel (deal-model-panel.tsx).
// The arithmetic itself lives in @ai-crm/shared (projectModel) so the
// preview is the same calculation the API and the workbook's formulas do.

import type { CalcAssumptions, DriverMethod, LineDriver, ModelLine } from "@ai-crm/shared";

export interface Assumptions extends CalcAssumptions {
  wacc: number;
  dscrTarget: number;
  unitScale: "MILLIONS" | "THOUSANDS";
  currency: string;
}

export interface HistoryRow {
  period: string;
  revenue?: number;
  ebitda?: number;
}

export interface ModelResponse {
  assumptions: Assumptions;
  isDerived: boolean;
  history: HistoryRow[];
  /** Every P&L line of the deal (fix plan E1), in statement order. */
  lines: ModelLine[];
  /** Base-column (LTM / last full year) figure per input line. */
  baseValues: Record<string, number>;
  /** Base / entry column the workbook projects from (LTM or last full year). */
  base?: { label: string; basis: string; revenue: number | null; ebitda: number | null; entrySource?: string } | null;
  currency: string;
  unitScale: string;
}

export type ScalarKey =
  | "entryMultiple" | "transactionFeesPct" | "debtQuantum" | "interestRate"
  | "amortPctPerYear" | "cashSweepPct" | "capexPctRevenue" | "nwcPctRevenue"
  | "taxRate" | "exitMultiple" | "exitYear" | "wacc" | "dscrTarget";

export const SCALAR_GROUPS: Array<{ title: string; fields: Array<{ key: ScalarKey; label: string; suffix: string; step?: number }> }> = [
  {
    title: "Entry",
    fields: [
      { key: "entryMultiple", label: "Entry multiple", suffix: "x", step: 0.25 },
      { key: "transactionFeesPct", label: "Transaction fees", suffix: "%", step: 0.5 },
    ],
  },
  {
    title: "Capital structure",
    fields: [
      { key: "debtQuantum", label: "Debt", suffix: "x EBITDA", step: 0.25 },
      { key: "interestRate", label: "Interest rate", suffix: "%", step: 0.25 },
      { key: "amortPctPerYear", label: "Amortisation", suffix: "% / yr", step: 1 },
      { key: "cashSweepPct", label: "Cash sweep", suffix: "% of FCF", step: 5 },
      { key: "dscrTarget", label: "DSCR target", suffix: "x", step: 0.05 },
    ],
  },
  {
    title: "Cash flow",
    fields: [
      { key: "capexPctRevenue", label: "Capex", suffix: "% of revenue", step: 0.5 },
      { key: "nwcPctRevenue", label: "NWC", suffix: "% of revenue", step: 1 },
      { key: "taxRate", label: "Tax rate", suffix: "%", step: 1 },
    ],
  },
  {
    title: "Exit",
    fields: [
      { key: "exitMultiple", label: "Exit multiple", suffix: "x", step: 0.25 },
      { key: "exitYear", label: "Exit year", suffix: "", step: 1 },
      { key: "wacc", label: "WACC", suffix: "%", step: 0.5 },
    ],
  },
];

export function fmtMoney(value: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${value.toFixed(1)}m`;
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Re-express a line's projection under a new method, so switching e.g.
 * "% of revenue" → "Fixed" keeps the same figures instead of reading 30%
 * as $30m.
 */
export function convertDriver(
  method: DriverMethod,
  projected: number[],
  revenue: number[],
  base: number,
): LineDriver {
  if (method === "FIXED") return { method, values: projected.map((v) => round(v, 3)) };
  if (method === "PCT_REVENUE") {
    return { method, values: projected.map((v, y) => round(revenue[y] ? (v / revenue[y]) * 100 : 0, 2)) };
  }
  if (method === "GROWTH") {
    return {
      method,
      values: projected.map((v, y) => {
        const prev = y === 0 ? base : projected[y - 1];
        return round(prev ? (v / prev - 1) * 100 : 0, 1);
      }),
    };
  }
  return { method, values: [] };
}

/** Lines hidden because an ancestor is collapsed. */
export function isHidden(line: ModelLine, byKey: Map<string, ModelLine>, collapsed: Set<string>): boolean {
  let parent = line.parent;
  while (parent) {
    if (collapsed.has(parent)) return true;
    parent = byKey.get(parent)?.parent;
  }
  return false;
}
