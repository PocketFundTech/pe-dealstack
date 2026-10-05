"use client";

// Working capital, capex and debt (fix plan E3) for the "Build model" panel:
// DSO / DIO / DPO (or NWC % of revenue), capex % (or maintenance + growth)
// per year, the two debt tranches, cash sweep and minimum cash — for the
// active case. The read-only rows (ΔNWC, capex, levered FCF, debt, cash)
// come from projectModel in @ai-crm/shared, the same arithmetic as the
// workbook's formulas. Methods are shared by all three cases (one workbook
// layout), so switching one switches them all.

import {
  BALANCE_SERIES_LABELS, activeBalanceKeys, balanceDriversOf,
  type BalanceDrivers, type BalanceSeriesKey, type ModelProjection, type OpeningBalances,
} from "@ai-crm/shared";
import type { ReactNode } from "react";
import { fmtMoney, type Assumptions, type ScalarKey } from "./deal-model-types";

const SHORT: Record<BalanceSeriesKey, string> = {
  dso: "DSO", dio: "DIO", dpo: "DPO", nwcPct: "NWC %",
  capexPct: "Capex %", capexMaintPct: "Maintenance capex %", capexGrowthPct: "Growth capex %",
};

type Methods = Pick<BalanceDrivers, "nwcMethod" | "capexMethod">;

interface Props {
  assumptions: Assumptions;
  projection: ModelProjection | null;
  opening?: OpeningBalances;
  currency: string;
  onSeries: (key: BalanceSeriesKey, year: number, value: number) => void;
  onMethods: (patch: Partial<Methods>) => void;
  onScalar: (key: ScalarKey, raw: string) => void;
}

const inputCls = "w-16 rounded-md border border-border-subtle px-1.5 py-1 text-right text-xs tabular-nums focus:border-[#003366] focus:outline-none";
const selectCls = "rounded-md border border-border-subtle bg-white px-1.5 py-1 text-xs focus:border-[#003366] focus:outline-none";

export function BalanceSection({ assumptions: a, projection, opening, currency, onSeries, onMethods, onScalar }: Props) {
  const years = a.projectionYears;
  const bd = balanceDriversOf(a);
  const keys = activeBalanceKeys(bd);
  const isNwc = (k: BalanceSeriesKey) => k === "dso" || k === "dio" || k === "dpo" || k === "nwcPct";
  const nwcKeys = keys.filter(isNwc);
  const capexKeys = keys.filter((k) => !isNwc(k));
  const yearCells = (fn: (y: number) => ReactNode) => Array.from({ length: years }, (_, y) => (
    <td key={y} className="px-1 py-1.5 text-right">{fn(y)}</td>
  ));
  const seriesRow = (k: BalanceSeriesKey) => (
    <tr key={k} data-testid={`balance-row-${k}`} className="border-b border-border-subtle/60">
      <td className="py-1.5 pl-4 pr-2 text-text-secondary">{BALANCE_SERIES_LABELS[k].label}</td>
      <td />
      {yearCells((y) => (
        <input
          type="number"
          aria-label={`${SHORT[k]} Y${y + 1}`}
          step={BALANCE_SERIES_LABELS[k].unit === "days" ? 1 : 0.25}
          value={bd[k][y] ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onSeries(k, y, v);
          }}
          className={inputCls}
        />
      ))}
    </tr>
  );
  const outputRow = (label: string, values: number[] | undefined, testId: string) => (
    <tr data-testid={testId} className="text-xs text-text-muted">
      <td className="py-1.5 pr-2">{label}</td>
      <td />
      {yearCells((y) => <span className="tabular-nums">{values?.[y]?.toFixed(1) ?? "—"}</span>)}
    </tr>
  );
  const sizeSuffix = a.debtQuantumMode === "ABSOLUTE" ? "m" : "x EBITDA";
  const tranches: Array<{ name: string; keys: [ScalarKey, ScalarKey, ScalarKey] }> = [
    { name: "Senior", keys: ["debtQuantum", "interestRate", "amortPctPerYear"] },
    { name: "Second tranche", keys: ["debt2Quantum", "debt2InterestRate", "debt2AmortPct"] },
  ];
  const scalar = (k: ScalarKey) => (a as unknown as Record<string, number | undefined>)[k] ?? 0;
  const numberInput = (k: ScalarKey, label: string, step: number) => (
    <input
      type="number" aria-label={label} step={step} value={scalar(k)}
      onChange={(e) => onScalar(k, e.target.value)} className={inputCls}
    />
  );

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Working capital, capex &amp; debt
      </h4>
      {opening && (opening.debt !== undefined || opening.cash !== undefined) && (
        <p className="mb-2 text-xs text-text-muted" data-testid="opening-net-debt">
          Opening net debt ({opening.period} balance sheet): {fmtMoney((opening.debt ?? 0) - (opening.cash ?? 0), currency)}
          {" "}= debt {fmtMoney(opening.debt ?? 0, currency)} − cash {fmtMoney(opening.cash ?? 0, currency)}, refinanced at entry.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs text-text-muted">
              <th className="py-2 pr-2 text-left font-medium">Driver</th>
              <th className="px-2 py-2 text-left font-medium">Method</th>
              {Array.from({ length: years }, (_, y) => <th key={y} className="px-1 py-2 text-right font-medium">Y{y + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border-subtle/60">
              <td className="py-1.5 pr-2 text-text-main">Working capital</td>
              <td className="px-2 py-1.5" colSpan={years + 1}>
                <select aria-label="Working capital method" value={bd.nwcMethod} className={selectCls}
                  onChange={(e) => onMethods({ nwcMethod: e.target.value as Methods["nwcMethod"] })}>
                  <option value="DAYS">Days (DSO / DIO / DPO)</option>
                  <option value="PCT_REVENUE">% of revenue</option>
                </select>
              </td>
            </tr>
            {nwcKeys.map(seriesRow)}
            {outputRow("Increase / (decrease) in NWC", projection?.deltaNwc, "balance-out-dnwc")}
            <tr className="border-b border-border-subtle/60">
              <td className="py-1.5 pr-2 text-text-main">Capex</td>
              <td className="px-2 py-1.5" colSpan={years + 1}>
                <select aria-label="Capex method" value={bd.capexMethod} className={selectCls}
                  onChange={(e) => onMethods({ capexMethod: e.target.value as Methods["capexMethod"] })}>
                  <option value="TOTAL">% of revenue</option>
                  <option value="SPLIT">Maintenance + growth</option>
                </select>
              </td>
            </tr>
            {capexKeys.map(seriesRow)}
            {outputRow("Capex", projection?.capex, "balance-out-capex")}
            {outputRow("Levered FCF (after interest and tax)", projection?.leveredFcf, "balance-out-lfcf")}
            {scalar("revolverSize") > 0 && outputRow("Revolver drawn (closing)", projection?.debtSchedule.map((d) => d.closeR), "balance-out-revolver")}
            {outputRow("Closing debt", projection?.debtClosing, "balance-out-debt")}
            {outputRow("Closing cash", projection?.cashClosing, "balance-out-cash")}
          </tbody>
        </table>
      </div>

      <table className="mt-4 text-sm" aria-label="Debt tranches">
        <thead>
          <tr className="text-xs text-text-muted">
            <th className="py-1.5 pr-4 text-left font-medium">Tranche</th>
            <th className="px-2 py-1.5 text-right font-medium">Size ({sizeSuffix})</th>
            <th className="px-2 py-1.5 text-right font-medium">Interest %</th>
            <th className="px-2 py-1.5 text-right font-medium">Amortisation % / yr</th>
          </tr>
        </thead>
        <tbody>
          {tranches.map((t) => (
            <tr key={t.name} className="border-t border-border-subtle/60">
              <td className="py-1.5 pr-4 text-text-secondary">{t.name}</td>
              <td className="px-2 py-1.5 text-right">{numberInput(t.keys[0], `${t.name} size`, 0.25)}</td>
              <td className="px-2 py-1.5 text-right">{numberInput(t.keys[1], `${t.name} interest`, 0.25)}</td>
              <td className="px-2 py-1.5 text-right">{numberInput(t.keys[2], `${t.name} amortisation`, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-5 text-sm text-text-secondary">
        <label className="flex items-center gap-1.5">Cash sweep {numberInput("cashSweepPct", "Cash sweep", 5)} <span className="text-xs text-text-muted">% of cash above minimum</span></label>
        <label className="flex items-center gap-1.5">Minimum cash {numberInput("minCash", "Minimum cash", 0.1)} <span className="text-xs text-text-muted">m</span></label>
      </div>
      <div className="mt-2 flex flex-wrap gap-5 text-sm text-text-secondary">
        <label className="flex items-center gap-1.5">Revolver {numberInput("revolverSize", "Revolver commitment", 0.5)} <span className="text-xs text-text-muted">m (0 = none)</span></label>
        <label className="flex items-center gap-1.5">Drawn rate {numberInput("revolverRate", "Revolver interest", 0.25)} <span className="text-xs text-text-muted">%</span></label>
        <label className="flex items-center gap-1.5">Undrawn fee {numberInput("revolverFeePct", "Revolver undrawn fee", 0.1)} <span className="text-xs text-text-muted">%</span></label>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Interest is on the average balance after scheduled amortisation; the sweep repays the senior tranche first,
        from levered free cash flow above the minimum cash. Entry is cash-free, debt-free. A revolver, if sized, is
        drawn only to keep cash at the minimum and repaid first from spare cash; its interest and undrawn fee are on
        the opening balance.
      </p>
    </div>
  );
}
