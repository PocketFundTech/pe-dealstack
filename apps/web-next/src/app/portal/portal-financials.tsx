"use client";

// Financials tab of the external share portal (QA #25c): one table per
// statement, periods as columns in date order, rows in statement order with
// raw accounts nested under their section — the same layout as the in-app
// Financial Statements table (deal-financials-layout.ts).

import { comparePeriods } from "@ai-crm/shared";
import { formatFinancialValue, formatPercent } from "@/lib/formatters";
import { buildStatementRows, hideEmptyRows } from "@/app/(app)/deals/[id]/deal-financials-layout";
import type { StatementType } from "@/app/(app)/deals/[id]/deal-financials-constants";

export interface PortalStatement {
  statementType: string;
  period: string;
  lineItems: Record<string, number>;
  unitScale?: string | null;
  currency?: string | null;
}

const STATEMENT_ORDER: StatementType[] = ["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"];
const STATEMENT_TITLE: Record<StatementType, string> = {
  INCOME_STATEMENT: "Income statement",
  BALANCE_SHEET: "Balance sheet",
  CASH_FLOW: "Cash flow",
};

// Percentage/ratio line items are unitless — formatting them as currency
// printed "$40.3M" for a 40.3% margin on a client-facing page (2026-08-18).
const isPctKey = (key: string) => key.endsWith("_pct") || key.endsWith("_margin");

function formatCell(key: string, value: number | undefined, s: PortalStatement | undefined, fallbackCurrency?: string | null): string {
  if (typeof value !== "number" || !s) return "—";
  if (isPctKey(key)) return formatPercent(value);
  const text = formatFinancialValue(Math.abs(value), (s.unitScale ?? undefined) as never, {
    currency: s.currency ?? fallbackCurrency ?? undefined,
  });
  return value < 0 ? `(${text})` : text; // accounting-style negatives
}

export function PortalFinancials({ statements, currency }: { statements: PortalStatement[]; currency?: string | null }) {
  const byType = new Map<string, PortalStatement[]>();
  for (const s of statements) byType.set(s.statementType, [...(byType.get(s.statementType) ?? []), s]);
  const types = STATEMENT_ORDER.filter((t) => byType.has(t));

  if (types.length === 0) return <p className="text-sm text-gray-500">No financial statements were shared.</p>;

  return (
    <div className="space-y-6">
      {types.map((type) => {
        const periods = [...byType.get(type)!].sort((a, b) => comparePeriods(a.period, b.period));
        const keys = new Set<string>();
        periods.forEach((p) => Object.keys(p.lineItems ?? {}).forEach((k) => keys.add(k)));
        const hasValue = (k: string) => periods.some((p) => typeof p.lineItems?.[k] === "number");
        const rows = hideEmptyRows(buildStatementRows(type, keys), hasValue);
        return (
          <div key={type}>
            <h3 className="text-sm font-bold text-gray-800 mb-2">{STATEMENT_TITLE[type]}</h3>
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="sticky left-0 bg-gray-50 px-3 py-2 text-left font-medium min-w-[160px]">Line item</th>
                    {periods.map((p) => (
                      <th key={p.period} className="px-3 py-2 text-right font-medium whitespace-nowrap">{p.period}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const strong = r.kind === "subtotal";
                    return (
                      <tr key={r.key} className="border-t border-gray-100">
                        <td className={`sticky left-0 bg-white px-3 py-1.5 whitespace-nowrap ${strong ? "font-semibold text-gray-900" : r.isChild ? "pl-7 text-gray-500" : r.kind === "group" ? "italic text-gray-400" : "text-gray-600"}`}>
                          {r.label}
                        </td>
                        {periods.map((p) => (
                          <td key={p.period} className={`px-3 py-1.5 text-right tabular-nums ${strong ? "font-semibold text-gray-900" : "text-gray-800"}`}>
                            {r.kind === "group" ? "" : formatCell(r.key, p.lineItems?.[r.key], p, currency)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
