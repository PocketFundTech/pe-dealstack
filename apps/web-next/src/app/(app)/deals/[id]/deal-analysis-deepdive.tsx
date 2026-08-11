"use client";

import { formatFinancialValue, type UnitScale } from "@/lib/formatters";
import {
  type AnalysisData,
  type DuPontDecomposition,
  type CostStructure,
  BANKER_BLUE,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// Deep Dive Tab (matches legacy renderDeepDiveTab — id "deepdive")
//   Cards: Financial Ratios, DuPont Decomposition, Cost Structure
// ---------------------------------------------------------------------------

export function DeepDivePanel({ analysis }: { analysis: AnalysisData | null }) {
  if (!analysis) {
    return <EmptyTabState icon="analytics" message="No deep-dive data available yet." />;
  }

  const hasRatios = analysis.ratios && analysis.ratios.length > 0;
  const hasDuPont = analysis.duPont && analysis.duPont.periods.length > 0;
  const hasCost = analysis.costStructure && analysis.costStructure.periods.length > 0;
  const scale = (analysis.unitScale ?? undefined) as UnitScale | undefined;
  const currency = analysis.currency ?? "USD";

  if (!hasRatios && !hasDuPont && !hasCost) {
    return <EmptyTabState icon="analytics" message="Deep-dive ratios, DuPont decomposition, and cost structure will appear here once enough financial data is extracted." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {hasRatios && <FinancialRatiosCard ratios={analysis.ratios} scale={scale} currency={currency} />}
      {hasDuPont && <DuPontCard duPont={analysis.duPont!} />}
      {hasCost && <CostStructureCard cs={analysis.costStructure!} scale={scale} currency={currency} />}
    </div>
  );
}

// Card: Financial Ratios (matches legacy renderRatioDashboard title)
function FinancialRatiosCard({
  ratios,
  scale,
  currency,
}: {
  ratios: AnalysisData["ratios"];
  scale: UnitScale | undefined;
  currency: string;
}) {
  const trendIcon = (t: string) =>
    t === "improving" ? "trending_up" : t === "declining" ? "trending_down" : t === "stable" ? "trending_flat" : "remove";
  const trendColor = (t: string) =>
    t === "improving" ? "#059669" : t === "declining" ? "#dc2626" : t === "stable" ? "#64748B" : "#94A3B8";

  // Render a ratio cell honouring its `unit` discriminator. Currency-typed
  // ratios (`$M`) flow through formatFinancialValue so they auto-scale.
  const renderRatioValue = (
    value: number | null,
    unit: AnalysisData["ratios"][number]["ratios"][number]["unit"],
  ): string => {
    if (value == null) return "—";
    if (unit === "$M") return formatFinancialValue(value, scale, { currency });
    if (unit === "%") return value.toFixed(1) + "%";
    if (unit === "x") return value.toFixed(2) + "x";
    if (unit === "days") return Math.round(value) + "d";
    return String(value);
  };

  return (
    <AnalysisCard>
      <CardHeader icon="bar_chart" title="Financial Ratios" />
      <div className="flex flex-col gap-4">
        {ratios.map((group) => (
          <div key={group.category}>
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-[16px]" style={{ color: BANKER_BLUE }}>{group.icon}</span>
              <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color: BANKER_BLUE }}>{group.category}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-gray-50 border-b-2 border-gray-200">
                    <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Ratio</th>
                    {group.ratios[0]?.periods.map((p) => (
                      <th key={p.period} className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{p.period}</th>
                    ))}
                    <th className="text-center p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {group.ratios.map((r) => (
                    <tr key={r.key} className="border-b border-gray-100">
                      <td className="p-2.5 text-gray-800" title={r.description}>{r.name}</td>
                      {r.periods.map((p) => (
                        <td key={p.period} className="text-right p-2.5 text-gray-800">
                          {renderRatioValue(p.value, r.unit)}
                        </td>
                      ))}
                      <td className="text-center p-2.5">
                        <span className="material-symbols-outlined text-[16px]" style={{ color: trendColor(r.trend) }}>{trendIcon(r.trend)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </AnalysisCard>
  );
}

// Card: DuPont Decomposition (matches legacy renderDuPont)
function DuPontCard({ duPont }: { duPont: DuPontDecomposition }) {
  const fmt = (v: number | null) => (v != null ? v.toFixed(2) : "--");

  return (
    <AnalysisCard>
      <CardHeader icon="schema" title="DuPont Decomposition" />
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-200">
              <th className="text-left p-2 text-gray-500 font-semibold">Component</th>
              {duPont.periods.map((p) => (
                <th key={p.period} className="text-right p-2 text-gray-500 font-semibold">{p.period}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="p-2 font-medium text-gray-800">Net Profit Margin</td>
              {duPont.periods.map((p) => (
                <td key={p.period} className="text-right p-2 text-gray-800">{fmt(p.netProfitMargin)}%</td>
              ))}
            </tr>
            <tr className="border-b border-gray-100">
              <td className="p-2 font-medium text-gray-800">Asset Turnover</td>
              {duPont.periods.map((p) => (
                <td key={p.period} className="text-right p-2 text-gray-800">{fmt(p.assetTurnover)}x</td>
              ))}
            </tr>
            <tr className="border-b border-gray-100">
              <td className="p-2 font-medium text-gray-800">Equity Multiplier</td>
              {duPont.periods.map((p) => (
                <td key={p.period} className="text-right p-2 text-gray-800">{fmt(p.equityMultiplier)}x</td>
              ))}
            </tr>
            <tr className="border-b-2 border-gray-200 bg-gray-50">
              <td className="p-2 font-bold" style={{ color: BANKER_BLUE }}>ROE</td>
              {duPont.periods.map((p) => {
                const c = p.roe != null && p.roe >= 15 ? "#059669" : p.roe != null && p.roe >= 8 ? "#d97706" : "#dc2626";
                return (
                  <td key={p.period} className="text-right p-2 font-bold" style={{ color: c }}>{fmt(p.roe)}%</td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-3 px-3.5 py-2.5 bg-[#F0F7FF] rounded-lg text-[11px] text-gray-600 leading-relaxed">
        ROE = Net Profit Margin x Asset Turnover x Equity Multiplier
      </div>
    </AnalysisCard>
  );
}

// Card: Cost Structure (matches legacy renderCostStructure)
function CostStructureCard({
  cs,
  scale,
  currency,
}: {
  cs: CostStructure;
  scale: UnitScale | undefined;
  currency: string;
}) {
  const levColors: Record<string, string> = { high: "#dc2626", moderate: "#d97706", low: "#059669", unknown: "#64748B" };
  const cap = cs.operatingLeverage.charAt(0).toUpperCase() + cs.operatingLeverage.slice(1);
  const renderPct = (v: number | null) => (v != null ? v.toFixed(1) + "%" : "—");

  return (
    <AnalysisCard>
      <CardHeader icon="pie_chart" title="Cost Structure" />
      <div className="flex gap-3.5 flex-wrap mb-4">
        {cs.breakEvenRevenue != null && (
          <div className="flex-1 min-w-[140px] bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
            <div className="text-[10px] text-gray-500 uppercase font-semibold">Break-even Revenue</div>
            <div className="text-2xl font-extrabold" style={{ color: BANKER_BLUE }}>{formatFinancialValue(cs.breakEvenRevenue, scale, { currency })}</div>
          </div>
        )}
        <div className="flex-1 min-w-[140px] bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 uppercase font-semibold">Operating Leverage</div>
          <div className="text-2xl font-extrabold" style={{ color: levColors[cs.operatingLeverage] || "#64748B" }}>{cap}</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-gray-50 border-b-2 border-gray-200">
              <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Cost Category (% Rev)</th>
              {cs.periods.map((p) => (
                <th key={p.period} className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{p.period}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100"><td className="p-2.5 text-gray-800">COGS %</td>{cs.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{renderPct(p.cogsPct)}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5 text-gray-800">SG&amp;A %</td>{cs.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{renderPct(p.sgaPct)}</td>)}</tr>
            <tr className="border-b border-gray-100"><td className="p-2.5 text-gray-800">R&amp;D %</td>{cs.periods.map((p) => <td key={p.period} className="text-right p-2.5 text-gray-800">{renderPct(p.rdPct)}</td>)}</tr>
            <tr className="bg-gradient-to-r from-gray-100 to-gray-50 border-t-2 border-gray-200">
              <td className="p-2.5 font-bold" style={{ color: BANKER_BLUE }}>Total OpEx %</td>
              {cs.periods.map((p) => <td key={p.period} className="text-right p-2.5 font-bold" style={{ color: BANKER_BLUE }}>{renderPct(p.opexPct)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </AnalysisCard>
  );
}
