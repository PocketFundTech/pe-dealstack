"use client";

// Balance Sheet section (fix plan H3): a read-only net-assets view of the
// closing date and each projected year, with the balance check. The
// workbook carries the same numbers on its own Balance Sheet sheet.

import { projectBalanceSheet, type CalcAssumptions, type ModelProjection, type OpeningBalances } from "@ai-crm/shared";

const ROWS: Array<{ key: "cash" | "nwc" | "ppe" | "goodwill" | "otherNet" | "totalNetAssets"; label: string; bold?: boolean }> = [
  { key: "cash", label: "Cash" },
  { key: "nwc", label: "Net working capital" },
  { key: "ppe", label: "PP&E (net)" },
  { key: "goodwill", label: "Goodwill" },
  { key: "otherNet", label: "Other net operating assets" },
  { key: "totalNetAssets", label: "Total net assets", bold: true },
];
const CAPITAL_ROWS: Array<{ key: "debt" | "equity" | "totalCapital"; label: string; bold?: boolean }> = [
  { key: "debt", label: "Total debt" },
  { key: "equity", label: "Equity" },
  { key: "totalCapital", label: "Total debt + equity", bold: true },
];

export function BalanceSheetSection({
  assumptions, projection, opening, currency,
}: {
  assumptions: CalcAssumptions;
  projection: ModelProjection | null;
  opening?: OpeningBalances;
  currency: string;
}) {
  if (!projection) return null;
  const bs = projectBalanceSheet(projection, assumptions, opening ?? {});
  const columns = [bs.entry, ...bs.years];
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const maxCheck = Math.max(...columns.map((c) => Math.abs(c.check)));
  const balances = maxCheck < 0.05; // rounding only

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Balance sheet</h4>
        <span
          data-testid="balance-check"
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${balances ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
        >
          {balances ? "Balances" : `Check off by ${fmt(maxCheck)} ${currency}`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs text-text-muted">
              <th className="py-2 pr-2 text-left font-medium">Net assets</th>
              <th className="px-2 py-2 text-right font-medium">Closing</th>
              {bs.years.map((_, y) => <th key={y} className="px-2 py-2 text-right font-medium">Y{y + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key} className="border-b border-border-subtle/60">
                <td className={`py-1.5 pr-2 ${r.bold ? "font-semibold text-text-main" : "text-text-secondary"}`}>{r.label}</td>
                {columns.map((c, i) => (
                  <td key={i} className={`px-2 py-1.5 text-right tabular-nums ${r.bold ? "font-semibold" : ""}`}>{fmt(c[r.key])}</td>
                ))}
              </tr>
            ))}
            <tr><td colSpan={columns.length + 1} className="py-1" /></tr>
            {CAPITAL_ROWS.map((r) => (
              <tr key={r.key} className="border-b border-border-subtle/60">
                <td className={`py-1.5 pr-2 ${r.bold ? "font-semibold text-text-main" : "text-text-secondary"}`}>{r.label}</td>
                {columns.map((c, i) => (
                  <td key={i} className={`px-2 py-1.5 text-right tabular-nums ${r.bold ? "font-semibold" : ""}`}>{fmt(c[r.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Purchase accounting with goodwill as the plug: entry value less the net working capital, PP&amp;E and other net
        operating assets bought. Transaction fees are expensed at close; there are no dividends during the hold, so
        equity grows only by net income.
      </p>
    </div>
  );
}
