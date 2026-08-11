"use client";

import { formatFinancialValue, type UnitScale } from "@/lib/formatters";
import {
  type AnalysisData,
  type CrossDocData,
  type RiskFactor,
  SEVERITY_STYLES,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
  FlagCard,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// Risk Score Card
// ---------------------------------------------------------------------------

function RiskScoreCard({ factor }: { factor: RiskFactor }) {
  const s = SEVERITY_STYLES[factor.severity] || SEVERITY_STYLES.info;
  const barWidth = Math.max(5, factor.score);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 hover:-translate-y-px transition-transform">
      <div className="text-[10px] text-gray-500 uppercase font-semibold tracking-wide mb-1">{factor.category}</div>
      <div className="text-lg font-extrabold mb-1" style={{ color: s.icon }}>{factor.label}</div>
      <div className="bg-gray-200 h-2 rounded-full overflow-hidden mb-2">
        <div className="h-2 rounded-full transition-all duration-700" style={{ width: `${barWidth}%`, background: s.icon }} />
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">{factor.detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diligence Tab (matches legacy renderDiligenceTab — id "diligence")
// ---------------------------------------------------------------------------

export function DiligencePanel({ analysis, crossDoc }: { analysis: AnalysisData | null; crossDoc: CrossDocData | null }) {
  const redFlags = analysis?.redFlags || [];
  const qoeFlags = analysis?.qoe?.flags || [];
  const conflicts = crossDoc?.conflicts || [];

  const riskFactors: RiskFactor[] = [];
  const criticalCount = [...redFlags, ...qoeFlags].filter((f) => f.severity === "critical").length;
  const warningCount = [...redFlags, ...qoeFlags].filter((f) => f.severity === "warning").length;

  if (criticalCount > 0 || warningCount > 0) {
    riskFactors.push({
      category: "Financial Quality",
      score: Math.max(0, 100 - criticalCount * 25 - warningCount * 10),
      label: criticalCount > 0 ? "High Risk" : "Moderate",
      detail: `${criticalCount} critical and ${warningCount} warning flags identified`,
      severity: criticalCount > 0 ? "critical" : "warning",
    });
  }

  if (conflicts.length > 0) {
    riskFactors.push({
      category: "Document Consistency",
      score: Math.max(0, 100 - conflicts.length * 15),
      label: conflicts.length > 3 ? "High Risk" : "Moderate",
      detail: `${conflicts.length} discrepanc${conflicts.length !== 1 ? "ies" : "y"} found across documents`,
      severity: conflicts.length > 3 ? "critical" : "warning",
    });
  }

  if (analysis?.debtCapacity?.currentLeverage != null) {
    const lev = analysis.debtCapacity.currentLeverage;
    riskFactors.push({
      category: "Leverage Risk",
      score: lev <= 2 ? 90 : lev <= 3 ? 70 : lev <= 4 ? 50 : 30,
      label: lev <= 3 ? "Low" : lev <= 4 ? "Moderate" : "High",
      detail: `Current leverage at ${lev}x EBITDA`,
      severity: lev <= 3 ? "positive" : lev <= 4 ? "warning" : "critical",
    });
  }

  if (riskFactors.length === 0 && redFlags.length === 0) {
    return <EmptyTabState icon="shield" message="No risk data available yet. Analysis will populate once financial data is extracted." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {riskFactors.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {riskFactors.map((rf) => <RiskScoreCard key={rf.category} factor={rf} />)}
        </div>
      )}

      {/* Red Flags (matches legacy renderRedFlags) */}
      {redFlags.length > 0 && (
        <AnalysisCard>
          <CardHeader icon="flag" title="Red Flag Analysis">
            <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: "#FEE2E2", color: "#dc2626" }}>
              {redFlags.length} Flag{redFlags.length !== 1 ? "s" : ""}
            </span>
          </CardHeader>
          <div className="flex flex-col gap-2.5">
            {redFlags.map((f, i) => <FlagCard key={i} flag={f} />)}
          </div>
        </AnalysisCard>
      )}

      {/* No Red Flags - positive state (matches legacy) */}
      {redFlags.length === 0 && riskFactors.length > 0 && (
        <AnalysisCard>
          <CardHeader icon="check_circle" title="No Red Flags Detected" />
          <p className="text-xs text-gray-500">All automated deep detection checks passed.</p>
        </AnalysisCard>
      )}

      {/* Cross-Doc Verification (matches legacy renderCrossDoc) */}
      {crossDoc?.hasData && conflicts.length > 0 && (
        <AnalysisCard>
          <CardHeader icon="compare" title="Cross-Document Verification">
            <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: "#FEF3C7", color: "#d97706" }}>
              {conflicts.length} Discrepanc{conflicts.length !== 1 ? "ies" : "y"}
            </span>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse border border-gray-200 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-50 border-b-2 border-gray-200">
                  <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Period</th>
                  <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Field</th>
                  <th className="text-left p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Values by Document</th>
                  <th className="text-right p-2.5 text-gray-500 font-semibold text-[10px] uppercase">Deviation</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.slice(0, 10).map((c, i) => {
                  // Prefer per-value unitScale; fall back to conflict-level
                  // scale; default ACTUALS so we never silently re-scale.
                  const conflictScale = (c.unitScale ?? undefined) as UnitScale | undefined;
                  const conflictCurrency = c.currency ?? "USD";
                  return (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="p-2.5 font-semibold text-gray-800">{c.period}</td>
                      <td className="p-2.5 text-gray-600">{c.field.replace(/_/g, " ")}</td>
                      <td className="p-2.5">
                        {c.values.map((v, vi) => {
                          const scale = ((v.unitScale ?? conflictScale) ?? "ACTUALS") as UnitScale;
                          return (
                            <span
                              key={vi}
                              className="inline-block text-[10px] px-2 py-0.5 rounded-md mx-0.5 my-0.5"
                              style={{ background: v.isActive ? "#D1FAE5" : "#F1F5F9" }}
                            >
                              {v.documentName}: {formatFinancialValue(v.value, scale, { currency: conflictCurrency })}
                            </span>
                          );
                        })}
                      </td>
                      <td className="p-2.5 text-right font-bold" style={{ color: c.discrepancyPct > 10 ? "#dc2626" : "#d97706" }}>
                        {c.discrepancyPct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AnalysisCard>
      )}

      {/* Cross-doc no conflicts (matches legacy) */}
      {crossDoc?.hasData && conflicts.length === 0 && (
        <AnalysisCard>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="material-symbols-outlined text-[20px]" style={{ color: "#059669" }}>fact_check</span>
            <span className="text-[13px] font-bold text-gray-900 uppercase tracking-wider" style={{ letterSpacing: "0.06em" }}>Cross-Document Verification</span>
            <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: "#D1FAE5", color: "#059669" }}>No Conflicts</span>
          </div>
          <p className="text-xs text-gray-500">All financial figures are consistent across {crossDoc.documents?.length || 0} document(s).</p>
        </AnalysisCard>
      )}
    </div>
  );
}
