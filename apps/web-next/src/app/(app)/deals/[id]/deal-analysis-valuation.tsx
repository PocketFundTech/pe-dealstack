"use client";

import { formatFinancialValue, type UnitScale } from "@/lib/formatters";
import {
  type AnalysisData,
  type BenchmarkData,
  type LBOScreen,
  BANKER_BLUE,
  BANKER_BLUE_MUTED,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// Valuation Tab (matches legacy renderValuationTab + renderLBOScreen)
// ---------------------------------------------------------------------------

export function ValuationPanel({ analysis, benchmark }: { analysis: AnalysisData | null; benchmark: BenchmarkData | null }) {
  const lbo = analysis?.lboScreen;
  const scale = (analysis?.unitScale ?? undefined) as UnitScale | undefined;
  const currency = analysis?.currency ?? "USD";

  if (!lbo) return <EmptyTabState icon="rocket_launch" message="No valuation data available. Upload financial documents to generate LBO screening and valuation analysis." />;

  return (
    <div className="flex flex-col gap-4">
      <LBOScreenCard lbo={lbo} scale={scale} currency={currency} />

      {/* Benchmark data shown here as well when available */}
      {benchmark?.hasData && benchmark.peerCount > 0 && benchmark.benchmarks?.length > 0 ? (
        <BenchmarkCard benchmark={benchmark} scale={scale} currency={currency} />
      ) : (
        <AnalysisCard>
          <div className="text-center py-5">
            <span className="material-symbols-outlined text-3xl text-gray-300 block mb-2">leaderboard</span>
            <p className="text-xs text-gray-400">
              Portfolio benchmarking requires 2+ deals with financials extracted.
            </p>
          </div>
        </AnalysisCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LBO Screen Card (matches legacy renderLBOScreen exactly)
// ---------------------------------------------------------------------------

function LBOScreenCard({
  lbo,
  scale,
  currency,
}: {
  lbo: LBOScreen;
  scale: UnitScale | undefined;
  currency: string;
}) {
  const passColor = lbo.passesScreen ? "#059669" : "#dc2626";
  const passLabel = lbo.passesScreen ? "PASSES SCREEN" : "BELOW THRESHOLD";

  const hasScenarios = lbo.scenarios && lbo.scenarios.length > 0;
  const entryMults = hasScenarios
    ? [...new Set(lbo.scenarios.map((s) => s.entryMultiple))].sort((a, b) => a - b)
    : [];
  const exitMults = hasScenarios
    ? [...new Set(lbo.scenarios.map((s) => s.exitMultiple))].sort((a, b) => a - b)
    : [];

  return (
    <AnalysisCard>
      <CardHeader icon="rocket_launch" title="LBO Quick Screen">
        <span
          className="text-[10px] font-bold px-2.5 py-0.5 rounded-full"
          style={{ background: `${passColor}15`, color: passColor }}
        >
          {passLabel}
        </span>
      </CardHeader>

      {/* Entry metrics */}
      <div className="flex gap-3.5 flex-wrap mb-4">
        {lbo.entryEbitda != null && (
          <div className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
            <div className="text-[10px] text-gray-500 uppercase font-semibold">Entry EBITDA</div>
            <div className="text-2xl font-extrabold" style={{ color: BANKER_BLUE }}>{formatFinancialValue(lbo.entryEbitda, scale, { currency })}</div>
          </div>
        )}
        {hasScenarios && lbo.scenarios[0]?.growthRate != null && (
          <div className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4">
            <div className="text-[10px] text-gray-500 uppercase font-semibold">Growth Rate</div>
            <div className="text-2xl font-extrabold" style={{ color: BANKER_BLUE }}>{lbo.scenarios[0].growthRate.toFixed(1)}%</div>
          </div>
        )}
      </div>

      {/* Scenario matrix */}
      {hasScenarios && entryMults.length > 0 && exitMults.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-50">
                  <th rowSpan={2} className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase align-bottom border-b-2 border-gray-200">
                    Entry Multiple
                  </th>
                  <th colSpan={exitMults.length} className="text-center p-2.5 text-gray-500 font-semibold text-[10px] uppercase border-b border-gray-200">
                    Exit Multiple → MOIC / IRR
                  </th>
                </tr>
                <tr className="bg-gray-50 border-b-2 border-gray-200">
                  {exitMults.map((em) => (
                    <th key={em} className="text-center p-2.5 text-gray-500 font-semibold text-[10px] uppercase">{em}x</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entryMults.map((entry) => (
                  <tr key={entry} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="p-2.5 font-bold text-gray-800">{entry}x</td>
                    {exitMults.map((exit) => {
                      const s = lbo.scenarios.find((sc) => sc.entryMultiple === entry && sc.exitMultiple === exit);
                      if (!s) return <td key={exit} className="text-center p-2.5 text-gray-400">—</td>;
                      const irrC = s.irr == null ? "#94A3B8" : s.irr >= 25 ? "#059669" : s.irr >= 20 ? "#d97706" : "#dc2626";
                      return (
                        <td key={exit} className="text-center p-2.5">
                          <span className="font-bold text-gray-800 text-[13px]">{s.moic != null ? s.moic.toFixed(2) + "x" : "—"}</span>
                          <br />
                          <span className="text-[10px] font-semibold" style={{ color: irrC }}>
                            {s.irr != null ? `${s.irr.toFixed(1)}% IRR` : ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-400 mt-2.5">
            Assumes 60% debt / 40% equity, 20% debt paydown over 5 years.{" "}
            <span style={{ color: "#059669" }}>Green</span> IRR &gt;= 25%,{" "}
            <span style={{ color: "#d97706" }}>Amber</span> &gt;= 20%.
          </p>
        </>
      )}
    </AnalysisCard>
  );
}

// ---------------------------------------------------------------------------
// Benchmark Card (used inside Valuation tab — matches legacy renderBenchmark
// in analysis-valuation.js. Title "Portfolio Benchmarking"
// is canonical and must not change without a corresponding legacy update.)
// ---------------------------------------------------------------------------

function BenchmarkCard({
  benchmark,
  scale,
  currency,
}: {
  benchmark: BenchmarkData;
  scale: UnitScale | undefined;
  currency: string;
}) {
  return (
    <AnalysisCard>
      <CardHeader icon="leaderboard" title="Portfolio Benchmarking">
        <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: BANKER_BLUE_MUTED, color: BANKER_BLUE }}>
          vs {benchmark.peerCount} peers
        </span>
      </CardHeader>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {benchmark.benchmarks.map((b) => {
          const pc = b.percentile >= 70 ? "#059669" : b.percentile >= 40 ? "#d97706" : "#dc2626";
          const pl = b.percentile >= 70 ? "Top Quartile" : b.percentile >= 40 ? "Mid Range" : "Below Median";
          // Currency-typed peers ($M) flow through the auto-scaler so we
          // never hard-code a "M" suffix any more. Other units render verbatim.
          const renderVal = (v: number) => {
            if (b.unit === "$M") return formatFinancialValue(v, scale, { currency });
            if (b.unit === "%") return v.toFixed(1) + "%";
            return String(v);
          };

          return (
            <div key={b.metric} className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4 hover:-translate-y-px transition-transform">
              <div className="text-[10px] text-gray-500 uppercase font-semibold tracking-wide mb-2">{b.metric}</div>
              <div className="text-2xl font-extrabold" style={{ color: BANKER_BLUE }}>{renderVal(b.dealValue)}</div>
              <div className="mt-3">
                <div className="bg-gray-200 h-1.5 rounded-full relative overflow-visible">
                  <div className="h-1.5 rounded-full transition-all duration-700" style={{ width: `${b.percentile}%`, background: `linear-gradient(90deg, ${pc}40, ${pc})` }} />
                  <div
                    className="absolute top-[-3px] rounded-full border-2 border-white transition-all duration-700"
                    style={{ left: `${b.percentile}%`, transform: "translateX(-50%)", width: 12, height: 12, background: pc, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}
                  />
                </div>
                <div className="flex justify-between mt-1.5">
                  <span className="text-[9px] text-gray-400">{renderVal(b.peerMin)}</span>
                  <span className="text-[10px] font-semibold" style={{ color: pc }}>{b.percentile}th pctl - {pl}</span>
                  <span className="text-[9px] text-gray-400">{renderVal(b.peerMax)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AnalysisCard>
  );
}
