// Types + pure helpers for the "Build model" panel (deal-model-panel.tsx).
// The arithmetic itself lives in @ai-crm/shared (projectModel) so the
// preview is the same calculation the API and the workbook's formulas do.

import type { CalcAssumptions, CaseSummary, DriverMethod, LineDriver, ModelCase, ModelLine, OpeningBalances } from "@ai-crm/shared";

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

/** Line structure + base column, shared by every case. */
export interface ModelStructure {
  history: HistoryRow[];
  /** Every P&L line of the deal (fix plan E1), in statement order. */
  lines: ModelLine[];
  /** Base-column (LTM / last full year) figure per input line. */
  baseValues: Record<string, number>;
  /** Base / entry column the workbook projects from (LTM or last full year). */
  base?: { label: string; basis: string; revenue: number | null; ebitda: number | null; entrySource?: string } | null;
  /** Latest full-year balance sheet (fix plan E3): Days working-capital base + net debt refinanced at entry. */
  opening?: OpeningBalances;
  currency: string;
  unitScale: string;
  /** Plain-language reasons the defaults need a second look (e.g. deal-record vs statements EBITDA). */
  warnings?: string[];
}

/** GET /deals/:id/model/cases (fix plan E2). */
export interface CasesResponse extends ModelStructure {
  cases: Array<{ case: ModelCase; name: string; saved: boolean; assumptions: Assumptions; summary: CaseSummary | null }>;
  deltas?: Record<string, { revenueGrowthPp: number; ebitdaMarginPp: number; exitMultipleX: number }>;
}

export type ScalarKey =
  | "entryMultiple" | "transactionFeesPct" | "debtQuantum" | "interestRate"
  | "amortPctPerYear" | "debt2Quantum" | "debt2InterestRate" | "debt2AmortPct"
  | "cashSweepPct" | "minCash" | "taxRate" | "exitMultiple" | "exitYear" | "wacc" | "dscrTarget";

export const SCALAR_GROUPS: Array<{ title: string; fields: Array<{ key: ScalarKey; label: string; suffix: string; step?: number }> }> = [
  {
    title: "Entry",
    fields: [
      { key: "entryMultiple", label: "Entry multiple", suffix: "x", step: 0.25 },
      { key: "transactionFeesPct", label: "Transaction fees", suffix: "%", step: 0.5 },
    ],
  },
  {
    // Debt tranches, sweep and minimum cash live in the balance-sheet section (deal-model-balance.tsx).
    title: "Tax & covenant",
    fields: [
      { key: "taxRate", label: "Tax rate", suffix: "%", step: 1 },
      { key: "dscrTarget", label: "DSCR target", suffix: "x", step: 0.05 },
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
