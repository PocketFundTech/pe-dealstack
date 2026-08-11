"use client";

import { formatFinancialValue, type UnitScale } from "@/lib/formatters";
import {
  type AnalysisData,
  type KeyMetric,
  BANKER_BLUE,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
  SeverityBadges,
  FlagCard,
  ScoreRing,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// Revenue Quality Card
// ---------------------------------------------------------------------------

function RevenueQualityCard({ rq }: { rq: NonNullable<AnalysisData["revenueQuality"]> }) {
  const scoreColor = (rq.consistencyScore ?? 0) >= 75 ? "#059669" : (rq.consistencyScore ?? 0) >= 50 ? "#d97706" : "#dc2626";
  const scoreLabel = (rq.consistencyScore ?? 0) >= 75 ? "Consistent" : (rq.consistencyScore ?? 0) >= 50 ? "Moderate" : "Volatile";

  return (
    <AnalysisCard>
      <CardHeader icon="query_stats" title="Revenue Quality" />
      <div className="flex gap-4 flex-wrap mb-3.5">
        <div className="flex-1 min-w-[140px] bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 uppercase font-semibold">Revenue CAGR</div>
          <div className="text-2xl font-extrabold" style={{ color: (rq.revenueCAGR ?? 0) >= 0 ? "#059669" : "#dc2626" }}>
            {rq.revenueCAGR != null ? rq.revenueCAGR + "%" : "--"}
          </div>
        </div>
        <div className="flex-1 min-w-[140px] bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
          <div className="text-[10px] text-gray-500 uppercase font-semibold">Consistency Score</div>
          <div className="text-2xl font-extrabold" style={{ color: scoreColor }}>
            {rq.consistencyScore ?? "--"}<span className="text-xs font-semibold"> {scoreLabel}</span>
          </div>
        </div>
      </div>
      {rq.organicGrowthRates && rq.organicGrowthRates.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {rq.organicGrowthRates.map((g) => {
            const isPos = g.rate != null && g.rate > 0;
            const c = g.rate == null ? "#94A3B8" : isPos ? "#059669" : "#dc2626";
            return (
              <div key={g.period} className="bg-white border border-gray-200 rounded-lg px-3.5 py-2 text-center">
                <div className="text-[10px] text-gray-500 font-medium">{g.period}</div>
                <div className="text-sm font-bold" style={{ color: c }}>
                  {g.rate != null ? (isPos ? "+" : "") + g.rate + "%" : "--"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AnalysisCard>
  );
}

// ---------------------------------------------------------------------------
// EBITDA Bridge (matches legacy renderEBITDABridge)
// ---------------------------------------------------------------------------

function EBITDABridgeCard({
  bridge,
  scale,
  currency,
}: {
  bridge: NonNullable<AnalysisData["ebitdaBridge"]>;
  scale: UnitScale | undefined;
  currency: string;
}) {
  const vp = bridge.periods.filter((p) => p.reportedEbitda != null);
  if (!vp.length) return null;

  // Collect all unique addback labels across periods
  const allLabels = [...new Set(vp.flatMap((p) => p.addbacks.map((a) => a.label)))];
  const fmt = (v: number | null | undefined) => formatFinancialValue(v, scale, { currency });

  return (
    <AnalysisCard>
      <CardHeader icon="bar_chart" title="EBITDA Bridge">
        <span className="text-[10px] text-gray-400 font-medium">Reported → Adjusted</span>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-gray-50 border-b-2 border-gray-200">
              <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Item</th>
              {vp.map((p) => (
                <th key={p.period} className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{p.period}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="p-2.5 font-semibold text-gray-800">Reported EBITDA</td>
              {vp.map((p) => (
                <td key={p.period} className="text-right p-2.5 font-semibold text-gray-800">{fmt(p.reportedEbitda)}</td>
              ))}
            </tr>
            {allLabels.map((label) => (
              <tr key={label} className="border-b border-gray-100">
                <td className="p-2.5" style={{ color: "#059669" }}>+ {label}</td>
                {vp.map((p) => {
                  const ab = p.addbacks.find((a) => a.label === label);
                  return (
                    <td key={p.period} className="text-right p-2.5" style={{ color: "#059669" }}>
                      {ab?.amount != null ? `+${fmt(ab.amount)}` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="bg-gradient-to-r from-gray-100 to-gray-50 border-t-2 border-gray-200">
              <td className="p-2.5 font-bold" style={{ color: BANKER_BLUE }}>Adjusted EBITDA</td>
              {vp.map((p) => (
                <td key={p.period} className="text-right p-2.5 font-bold" style={{ color: BANKER_BLUE }}>
                  {fmt(p.adjustedEbitda)}
                  {p.adjustmentPct ? <span className="text-[9px] ml-1" style={{ color: "#059669" }}>(+{p.adjustmentPct.toFixed(1)}%)</span> : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </AnalysisCard>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab (matches legacy renderOverviewTab)
// ---------------------------------------------------------------------------

export function OverviewPanel({ analysis }: { analysis: AnalysisData | null }) {
  const qoe = analysis?.qoe;
  const scale = (analysis?.unitScale ?? undefined) as UnitScale | undefined;
  const currency = analysis?.currency ?? "USD";
  const metrics: KeyMetric[] = [];
  if (analysis?.revenueQuality?.revenueCAGR != null)
    metrics.push({ label: "Revenue CAGR", value: analysis.revenueQuality.revenueCAGR.toFixed(1) + "%", color: analysis.revenueQuality.revenueCAGR >= 0 ? "#059669" : "#dc2626" });
  if (analysis?.cashFlowAnalysis?.avgConversion != null)
    metrics.push({ label: "FCF Conversion", value: analysis.cashFlowAnalysis.avgConversion.toFixed(1) + "%", color: analysis.cashFlowAnalysis.avgConversion >= 60 ? "#059669" : "#d97706" });
  if (analysis?.debtCapacity?.currentLeverage != null)
    metrics.push({ label: "Net Leverage", value: analysis.debtCapacity.currentLeverage + "x", color: analysis.debtCapacity.currentLeverage <= 3 ? "#059669" : "#d97706" });
  if (analysis?.lboScreen?.passesScreen != null)
    metrics.push({ label: "LBO Screen", value: analysis.lboScreen.passesScreen ? "Pass" : "Fail", color: analysis.lboScreen.passesScreen ? "#059669" : "#dc2626" });

  if (!qoe && metrics.length === 0) return <EmptyTabState icon="dashboard" message="No overview data available yet." />;

  return (
    <div className="flex flex-col gap-4">
      {/* QoE Score Hero */}
      {qoe && (
        <AnalysisCard className="bg-gradient-to-br from-[#FAFBFF] to-[#F0F4FA] border-[#D6DEE8]">
          <div className="flex gap-6 items-center flex-wrap">
            <ScoreRing score={qoe.score} />
            <div className="flex-1 min-w-[200px]">
              <div className="text-sm font-bold text-gray-900 mb-1.5">Quality of Earnings Assessment</div>
              <p className="text-xs text-gray-600 leading-relaxed mb-3">{qoe.summary}</p>
              <SeverityBadges flags={qoe.flags} />
            </div>
            {metrics.length > 0 && (
              <div className="grid grid-cols-2 gap-2 min-w-[180px]">
                {metrics.map((m) => (
                  <div key={m.label} className="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
                    <div className="text-[9px] text-gray-500 uppercase font-semibold">{m.label}</div>
                    <div className="text-lg font-extrabold" style={{ color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </AnalysisCard>
      )}

      {/* QoE Flags */}
      {qoe && qoe.flags.length > 0 && (
        <AnalysisCard>
          <CardHeader icon="flag" title="Key Findings">
            <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: "#FEE2E2", color: "#dc2626" }}>
              {qoe.flags.filter((f) => f.severity === "critical").length} Critical
            </span>
          </CardHeader>
          <div className="flex flex-col gap-2">
            {qoe.flags.map((f, i) => <FlagCard key={i} flag={f} />)}
          </div>
        </AnalysisCard>
      )}

      {/* EBITDA Bridge */}
      {analysis?.ebitdaBridge && <EBITDABridgeCard bridge={analysis.ebitdaBridge} scale={scale} currency={currency} />}

      {/* Revenue Quality */}
      {analysis?.revenueQuality && <RevenueQualityCard rq={analysis.revenueQuality} />}
    </div>
  );
}
