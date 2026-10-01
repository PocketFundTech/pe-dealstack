// Shared fixture for the deal-model panel tests: an SRM-shaped catalogue
// (COGS with cement / fly-ash accounts) as GET /deals/:id/model returns it.

import type { ModelLine } from "@ai-crm/shared";
import type { Assumptions, ModelResponse } from "./deal-model-types";

export const LINES: ModelLine[] = [
  { key: "revenue", label: "Revenue", kind: "INPUT", level: 0, revenueLine: true },
  {
    key: "cogs", label: "COGS", kind: "SUM", level: 0, costLine: true,
    components: [{ key: "cogs_cement", sign: 1 }, { key: "cogs_fly_ash", sign: 1 }],
  },
  { key: "cogs_cement", label: "Cement", kind: "INPUT", level: 1, parent: "cogs", costLine: true },
  { key: "cogs_fly_ash", label: "Fly ash", kind: "INPUT", level: 1, parent: "cogs", costLine: true },
  { key: "gross_profit", label: "Gross profit", kind: "SUBTOTAL", level: 0, components: [{ key: "revenue", sign: 1 }, { key: "cogs", sign: -1 }] },
  { key: "total_opex", label: "Operating expenses", kind: "INPUT", level: 0, costLine: true },
  { key: "ebitda", label: "EBITDA", kind: "SUBTOTAL", level: 0, components: [{ key: "gross_profit", sign: 1 }, { key: "total_opex", sign: -1 }] },
  { key: "da", label: "D&A", kind: "INPUT", level: 0 },
  { key: "ebit", label: "EBIT", kind: "SUBTOTAL", level: 0, components: [{ key: "ebitda", sign: 1 }, { key: "da", sign: -1 }] },
  { key: "interest_expense", label: "Interest expense", kind: "COMPUTED", level: 0, computed: "INTEREST" },
  { key: "ebt", label: "EBT", kind: "SUBTOTAL", level: 0, components: [{ key: "ebit", sign: 1 }, { key: "interest_expense", sign: -1 }] },
  { key: "tax", label: "Tax", kind: "COMPUTED", level: 0, computed: "TAX" },
  { key: "net_income", label: "Net income", kind: "SUBTOTAL", level: 0, components: [{ key: "ebt", sign: 1 }, { key: "tax", sign: -1 }] },
];

const flat = (v: number) => [v, v, v, v, v];
const SUB = { method: "SUBTOTAL" as const, values: [] };

export function assumptions(overrides: Partial<Assumptions> = {}): Assumptions {
  return {
    entryMultiple: 5, entryBasis: "EBITDA", transactionFeesPct: 2,
    debtQuantumMode: "MULTIPLE", debtQuantum: 2.5, interestRate: 10, amortPctPerYear: 5, cashSweepPct: 50,
    projectionYears: 5, capexPctRevenue: 3, nwcPctRevenue: 10, taxRate: 25,
    exitMultiple: 5, exitYear: 5, wacc: 12, dscrTarget: 1.25, unitScale: "MILLIONS", currency: "USD",
    lineDrivers: {
      revenue: { method: "GROWTH", values: flat(10) },
      cogs: SUB,
      cogs_cement: { method: "PCT_REVENUE", values: flat(30) },
      cogs_fly_ash: { method: "PCT_REVENUE", values: flat(7) },
      gross_profit: SUB,
      total_opex: { method: "PCT_REVENUE", values: flat(50) },
      ebitda: SUB,
      da: { method: "PCT_REVENUE", values: flat(3) },
      ebit: SUB, interest_expense: SUB, ebt: SUB, tax: SUB, net_income: SUB,
    },
    ...overrides,
  };
}

export function modelResponse(a: Assumptions = assumptions()): ModelResponse {
  return {
    assumptions: a,
    isDerived: true,
    history: [{ period: "FY2023" }, { period: "FY2024" }, { period: "2025 YTD" }],
    lines: LINES,
    baseValues: { revenue: 27.3, cogs_cement: 8.2, cogs_fly_ash: 2.0, total_opex: 14.3, da: 0.7, interest_expense: 0.5, tax: 0.45 },
    base: { label: "FY2024 A", basis: "FY", revenue: 27.3, ebitda: 2.8, entrySource: "base" },
    currency: "USD",
    unitScale: "MILLIONS",
  };
}
