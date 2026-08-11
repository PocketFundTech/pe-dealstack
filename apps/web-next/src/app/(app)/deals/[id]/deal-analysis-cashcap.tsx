"use client";

import { formatFinancialValue, type UnitScale } from "@/lib/formatters";
import {
  type AnalysisData,
  type CashFlowAnalysis,
  type WorkingCapital,
  type DebtCapacity,
  BANKER_BLUE,
  BANKER_BLUE_MUTED,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// Cash & Capital Tab (matches legacy renderCashCapitalTab — id "cashcap")
//   Cards: Cash Flow Analysis, Working Capital, Debt Capacity
// ---------------------------------------------------------------------------

export function CashCapitalPanel({ analysis }: { analysis: AnalysisData | null }) {
  if (!analysis) {
    return <EmptyTabState icon="payments" message="No cash & capital data available yet." />;
  }

  const cfa = analysis.cashFlowAnalysis;
  const wc = analysis.workingCapital;
  const dc = analysis.debtCapacity;
  const scale = (analysis.unitScale ?? undefined) as UnitScale | undefined;
  const currency = analysis.currency ?? "USD";

  // Each of the three cards needs different source data:
  //   Cash Flow      ← INCOME_STATEMENT (ebitda) + CASH_FLOW (capex, fcf)
  //   Working Cap    ← BALANCE_SHEET (AR/AP/inventory/current-assets/current-liabilities) + INCOME_STATEMENT (revenue)
  //   Debt Capacity  ← BALANCE_SHEET (debt, cash) + INCOME_STATEMENT (interest expense, ebitda)
  // We render whichever cards have data, and call out specifically which
  // source-document type the empty cards need so the user knows what to upload
  // (rather than the old catch-all "extract more financial data" message).
  const cfaHasData = !!cfa && cfa.periods.some((p) => p.ebitda != null || p.fcf != null);
  const wcHasData = !!wc && wc.periods.some((p) => p.nwc != null);
  const dcHasData = !!dc && (dc.currentLeverage != null || dc.interestCoverage != null || dc.debtHeadroom != null);

  if (!cfaHasData && !wcHasData && !dcHasData) {
    return <EmptyTabState icon="payments" message="Cash & Capital needs a Balance Sheet and Cash Flow statement (in addition to the Income Statement) to populate. Upload one of those documents to the data room and re-extract." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {cfaHasData
        ? <CashFlowAnalysisCard cfa={cfa!} scale={scale} currency={currency} />
        : <CashCapEmptyCard icon="payments" title="Cash Flow Analysis" need="Cash Flow statement (for capex + free cash flow)" />}
      {wcHasData
        ? <WorkingCapitalCard wc={wc!} scale={scale} currency={currency} />
        : <CashCapEmptyCard icon="account_balance_wallet" title="Working Capital" need="Balance Sheet (for AR / AP / inventory / current assets / current liabilities)" />}
      {dcHasData
        ? <DebtCapacityCard dc={dc!} scale={scale} currency={currency} />
        : <CashCapEmptyCard icon="balance" title="Debt Capacity" need="Balance Sheet (for debt + cash) and Income Statement (for interest coverage)" />}
    </div>
  );
}

// Inline empty-state card matching the AnalysisCard frame so the panel
// keeps its visual rhythm even when one or two sub-cards lack source data.
function CashCapEmptyCard({ icon, title, need }: { icon: string; title: string; need: string }) {
  return (
    <AnalysisCard>
      <CardHeader icon={icon} title={title} />
      <p className="text-xs text-gray-500 px-1 py-2">
        Needs <span className="font-medium text-gray-700">{need}</span>. Upload it to the
        data room and the analysis will populate on the next extraction.
      </p>
    </AnalysisCard>
  );
}

// Local helper — wraps formatFinancialValue with the panel-level scale.
function fmt(
  v: number | null | undefined,
  scale: UnitScale | undefined,
  currency: string,
): string {
  return formatFinancialValue(v, scale, { currency });
}

// Card: Cash Flow Analysis (matches legacy renderCashFlowAnalysis)
function CashFlowAnalysisCard({
  cfa,
  scale,
  currency,
}: {
  cfa: CashFlowAnalysis;
  scale: UnitScale | undefined;
  currency: string;
}) {
  const vp = cfa.periods.filter((p) => p.ebitda != null || p.fcf != null);
  if (!vp.length) return null;
  const convColor = cfa.avgConversion == null ? "#64748B" : cfa.avgConversion >= 70 ? "#059669" : cfa.avgConversion >= 50 ? "#d97706" : "#dc2626";

  return (
    <AnalysisCard>
      <CardHeader icon="payments" title="Cash Flow Analysis">
        {cfa.avgConversion != null && (
          <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: `${convColor}15`, color: convColor }}>
            Avg Conversion: {cfa.avgConversion}%
          </span>
        )}
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-gray-50 border-b-2 border-gray-200">
              <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Item</th>
              {vp.map((p) => <th key={p.period} className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{p.period}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100"><td className="p-2.5 font-semibold text-gray-800">EBITDA</td>{vp.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{fmt(p.ebitda, scale, currency)}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5" style={{ color: "#dc2626" }}>- CapEx</td>{vp.map((p) => <td key={p.period} className="text-right p-2.5" style={{ color: "#dc2626" }}>{p.capex != null ? `(${fmt(p.capex, scale, currency)})` : "—"}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5" style={{ color: "#d97706" }}>- WC Change</td>{vp.map((p) => <td key={p.period} className="text-right p-2.5" style={{ color: "#d97706" }}>{p.wcChange != null ? (p.wcChange >= 0 ? `(${fmt(p.wcChange, scale, currency)})` : `+${fmt(Math.abs(p.wcChange), scale, currency)}`) : "—"}</td>)}</tr>
            <tr className="bg-gradient-to-r from-gray-100 to-gray-50 border-t-2 border-gray-200">
              <td className="p-2.5 font-bold" style={{ color: BANKER_BLUE }}>= Free Cash Flow</td>
              {vp.map((p) => <td key={p.period} className="text-right p-2.5 font-bold" style={{ color: BANKER_BLUE }}>{fmt(p.fcf, scale, currency)}</td>)}
            </tr>
            <tr>
              <td className="p-2.5 text-[10px] text-gray-500">Conversion %</td>
              {vp.map((p) => {
                const c = p.ebitdaToFcfConversion;
                const cc = c == null ? "#94A3B8" : c >= 70 ? "#059669" : c >= 50 ? "#d97706" : "#dc2626";
                return <td key={p.period} className="text-right p-2.5 text-[11px] font-semibold" style={{ color: cc }}>{c != null ? `${c.toFixed(1)}%` : "—"}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </AnalysisCard>
  );
}

// Card: Working Capital (matches legacy renderWorkingCapital)
function WorkingCapitalCard({
  wc,
  scale,
  currency,
}: {
  wc: WorkingCapital;
  scale: UnitScale | undefined;
  currency: string;
}) {
  if (!wc.periods.length) return null;
  return (
    <AnalysisCard>
      <CardHeader icon="account_balance_wallet" title="Working Capital">
        {wc.normalizedNwc != null && (
          <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: BANKER_BLUE_MUTED, color: BANKER_BLUE }}>
            Normalized NWC: {fmt(wc.normalizedNwc, scale, currency)}
          </span>
        )}
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-gray-50 border-b-2 border-gray-200">
              <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Component</th>
              {wc.periods.map((p) => <th key={p.period} className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{p.period}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100"><td className="p-2.5 text-gray-800">Accounts Receivable</td>{wc.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{fmt(p.ar, scale, currency)}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5 text-gray-800">Inventory</td>{wc.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{fmt(p.inventory, scale, currency)}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5" style={{ color: "#dc2626" }}>Accounts Payable</td>{wc.periods.map((p) => <td key={p.period} className="text-right p-2.5" style={{ color: "#dc2626" }}>{p.ap != null ? `(${fmt(p.ap, scale, currency)})` : "—"}</td>)}</tr>
            <tr className="bg-gradient-to-r from-gray-100 to-gray-50 border-t-2 border-gray-200">
              <td className="p-2.5 font-bold" style={{ color: BANKER_BLUE }}>Net Working Capital</td>
              {wc.periods.map((p) => <td key={p.period} className="text-right p-2.5 font-bold" style={{ color: BANKER_BLUE }}>{fmt(p.nwc, scale, currency)}</td>)}
            </tr>
            <tr>
              <td className="p-2.5 text-[10px] text-gray-500">NWC % Revenue</td>
              {wc.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-[11px] text-gray-500">{p.nwcPctRevenue != null ? p.nwcPctRevenue.toFixed(1) + "%" : "—"}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </AnalysisCard>
  );
}

// Card: Debt Capacity (matches legacy renderDebtCapacity)
function DebtCapacityCard({
  dc,
  scale,
  currency,
}: {
  dc: DebtCapacity;
  scale: UnitScale | undefined;
  currency: string;
}) {
  const dscrColor = dc.dscr == null ? "#64748B" : dc.dscr >= 1.5 ? "#059669" : dc.dscr >= 1.25 ? "#d97706" : "#dc2626";
  const metrics: { label: string; value: string; color: string; sub?: string }[] = [
    { label: "Current Leverage", value: dc.currentLeverage != null ? dc.currentLeverage + "x" : "—", color: BANKER_BLUE },
    { label: "Max Debt @3x", value: fmt(dc.maxDebt3x, scale, currency), color: BANKER_BLUE },
    { label: "Max Debt @4x", value: fmt(dc.maxDebt4x, scale, currency), color: BANKER_BLUE },
    { label: "DSCR", value: dc.dscr != null ? dc.dscr + "x" : "—", color: dscrColor, sub: "Banks want >1.25x" },
    { label: "Debt Headroom", value: fmt(dc.debtHeadroom, scale, currency), color: "#059669", sub: "vs 4x capacity" },
    { label: "Interest Coverage", value: dc.interestCoverage != null ? dc.interestCoverage + "x" : "—", color: BANKER_BLUE },
  ];

  return (
    <AnalysisCard>
      <CardHeader icon="account_balance" title="Debt Capacity" />
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {metrics.map((m) => (
          <div key={m.label} className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
            <div className="text-[10px] text-gray-500 uppercase font-semibold">{m.label}</div>
            <div className="text-2xl font-extrabold" style={{ color: m.color }}>{m.value}</div>
            {m.sub && <div className="text-[10px] text-gray-500 mt-1">{m.sub}</div>}
          </div>
        ))}
      </div>
    </AnalysisCard>
  );
}
