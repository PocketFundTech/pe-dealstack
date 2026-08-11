"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, NotFoundError } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  type AnalysisTab,
  type AnalysisData,
  type CrossDocData,
  type BenchmarkData,
  type InsightsResponse,
  type NarrativeInsights,
  BANKER_BLUE,
  BANKER_BLUE_LIGHT,
  ANALYSIS_TABS,
} from "./deal-analysis-types";
import {
  OverviewPanel,
  DeepDivePanel,
  CashCapitalPanel,
  ValuationPanel,
  DiligencePanel,
  AIInsightsPanel,
  MemoPanel,
} from "./deal-analysis-panels";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DealAnalysisSection({ dealId, onFullscreen }: { dealId: string; onFullscreen?: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("overview");
  const [loading, setLoading] = useState(true);
  // Primary analysis data (from /analysis endpoint — quantitative)
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  // Supplementary data
  const [crossDoc, setCrossDoc] = useState<CrossDocData | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkData | null>(null);
  const [insights, setInsights] = useState<NarrativeInsights | null>(null);
  // "error" = real server/network failure (5xx, network, etc). Never set for 404.
  const [error, setError] = useState(false);
  // "noData" = the /analysis endpoint returned hasData=false or 404 — no analysis yet.
  const [noData, setNoData] = useState(false);

  // Guards against duplicate parallel fetches:
  //  - React Strict Mode double-invokes effects in dev
  //  - User mashing the refresh button fires multiple in-flight requests
  // Without this guard, the /financials/insights endpoint was being hit
  // multiple times in the same session, each triggering a fresh LLM call.
  const inFlightRef = useRef(false);

  const loadData = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(false);
    setNoData(false);
    try {
      // Step 1: Fetch primary analysis data (same as legacy analysis.js line 27)
      let analysisData: AnalysisData | null = null;
      try {
        analysisData = await api.get<AnalysisData>(`/deals/${dealId}/financials/analysis`);
      } catch (e) {
        if (e instanceof NotFoundError) {
          // No analysis available yet — show empty state
          setNoData(true);
          setLoading(false);
          return;
        }
        throw e;
      }

      // If API returns 200 but hasData is false, treat as empty
      if (!analysisData?.hasData) {
        setNoData(true);
        setLoading(false);
        return;
      }

      setAnalysis(analysisData);

      // Step 2: Fetch supplementary data in parallel (same as legacy lines 37-53)
      const [crossDocRes, benchmarkRes, insightsRes] = await Promise.allSettled([
        api.get<CrossDocData>(`/deals/${dealId}/financials/cross-doc`),
        api.get<BenchmarkData>(`/deals/${dealId}/financials/benchmark`),
        api.get<InsightsResponse>(`/deals/${dealId}/financials/insights`),
      ]);

      if (crossDocRes.status === "fulfilled") setCrossDoc(crossDocRes.value);
      if (benchmarkRes.status === "fulfilled") setBenchmark(benchmarkRes.value);
      if (insightsRes.status === "fulfilled") setInsights(insightsRes.value.insights);
      // Supplementary endpoint failures are non-fatal (graceful degradation)
    } catch (err) {
      console.warn("[deal-analysis] loadData failed:", err);
      setError(true);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [dealId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Hide section entirely when loaded, not an error, but no data exists
  if (!loading && !analysis && !error && !noData) return null;

  return (
    <div
      id="analysis-section"
      className="overflow-hidden"
      style={{
        borderRadius: "12px",
        border: `2px solid ${BANKER_BLUE}`,
        boxShadow: "0 2px 8px rgba(0,51,102,0.15)",
        flexShrink: 0,
      }}
    >
      {/* Gradient header / collapsible toggle */}
      <button
        onClick={() => setCollapsed((p) => !p)}
        className="w-full flex items-center justify-between gap-2.5 cursor-pointer"
        style={{
          background: `linear-gradient(135deg, ${BANKER_BLUE} 0%, ${BANKER_BLUE_LIGHT} 100%)`,
          padding: "14px 20px",
          borderRadius: collapsed ? "10px" : "10px 10px 0 0",
          border: "none",
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-white text-[20px]">insights</span>
          <span
            className="text-white text-[13px] font-bold uppercase tracking-wider"
            style={{ letterSpacing: "0.06em" }}
          >
            AI Financial Analysis
          </span>
          {analysis?.qoe && <QoEBadge score={analysis.qoe.score} />}
        </div>
        <div className="flex items-center gap-2">
          <span
            role="button"
            tabIndex={0}
            className={cn(
              "material-symbols-outlined text-[16px] transition-colors",
              loading ? "cursor-not-allowed animate-spin" : "cursor-pointer",
            )}
            style={{ color: "rgba(255,255,255,0.5)" }}
            title={loading ? "Refreshing…" : "Refresh analysis"}
            aria-label={loading ? "Refreshing analysis" : "Refresh analysis"}
            onMouseEnter={(e) => { if (!loading) (e.target as HTMLElement).style.color = "rgba(255,255,255,0.9)"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "rgba(255,255,255,0.5)"; }}
            onClick={(e) => { e.stopPropagation(); if (!loading) loadData(); }}
            onKeyDown={(e) => {
              if (loading) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                loadData();
              }
            }}
          >
            refresh
          </span>
          {onFullscreen && (
            <span
              role="button"
              tabIndex={0}
              className="material-symbols-outlined text-[16px] transition-colors cursor-pointer"
              style={{ color: "rgba(255,255,255,0.5)" }}
              title="Fullscreen"
              onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "rgba(255,255,255,0.9)"; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "rgba(255,255,255,0.5)"; }}
              onClick={(e) => { e.stopPropagation(); onFullscreen(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onFullscreen();
                }
              }}
            >
              open_in_full
            </span>
          )}
          <span
            className="material-symbols-outlined text-white/80 text-[20px] transition-transform duration-200"
            style={{ transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
          >
            expand_more
          </span>
        </div>
      </button>

      {/* Collapsible body */}
      {!collapsed && (
        <div className="bg-white" style={{ padding: "20px", borderRadius: "0 0 10px 10px" }}>
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState onRetry={loadData} />
          ) : noData ? (
            <NoDataState />
          ) : (
            <>
              {/* Tab bar */}
              <div className="flex gap-0 border-b-2 border-gray-200 mb-5 overflow-x-auto">
                {ANALYSIS_TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all whitespace-nowrap",
                      activeTab === t.id
                        ? "border-[#003366] text-[#003366] bg-[#00336608]"
                        : "border-transparent text-gray-500 hover:text-[#003366] hover:bg-[#00336608]"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Tab panels — order matches legacy TABS array exactly */}
              {activeTab === "overview"   && <OverviewPanel analysis={analysis} />}
              {activeTab === "deepdive"   && <DeepDivePanel analysis={analysis} />}
              {activeTab === "cashcap"    && <CashCapitalPanel analysis={analysis} />}
              {activeTab === "valuation"  && <ValuationPanel analysis={analysis} benchmark={benchmark} />}
              {activeTab === "diligence"  && <DiligencePanel analysis={analysis} crossDoc={crossDoc} />}
              {activeTab === "aiinsights" && <AIInsightsPanel insights={insights} />}
              {activeTab === "memo"       && <MemoPanel analysis={analysis} dealId={dealId} />}

              {/* Footer */}
              {analysis?.analyzedAt && (
                <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-gray-100">
                  <span className="text-[10px] text-gray-400">
                    Analyzed {analysis.periods?.length || 0} period{(analysis.periods?.length || 0) !== 1 ? "s" : ""}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {new Date(analysis.analyzedAt).toLocaleString()}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QoE Badge (header pill)
// ---------------------------------------------------------------------------

function QoEBadge({ score }: { score: number }) {
  let bg: string, color: string;
  if (score >= 75) { bg = "#D1FAE5"; color = "#059669"; }
  else if (score >= 50) { bg = "#FEF3C7"; color = "#d97706"; }
  else { bg = "#FEE2E2"; color = "#dc2626"; }

  return (
    <span
      className="text-[11px] font-bold rounded-full px-3 py-0.5"
      style={{ background: bg, color }}
    >
      QoE: {score}/100
    </span>
  );
}

// ---------------------------------------------------------------------------
// Loading / Error / No-data states
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="text-center py-10">
      <span className="material-symbols-outlined text-4xl text-gray-300 animate-spin block mb-2">
        progress_activity
      </span>
      <p className="text-sm text-gray-400">Loading financial analysis...</p>
    </div>
  );
}

function NoDataState() {
  return (
    <div className="text-center py-10">
      <span className="material-symbols-outlined text-4xl text-gray-300 block mb-2">analytics</span>
      <p className="text-sm font-semibold text-gray-500 mb-1">No analysis data available yet</p>
      <p className="text-xs text-gray-400 leading-relaxed max-w-xs mx-auto">
        Upload financial documents and extract data to generate AI-powered analysis.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-center py-10">
      <span className="material-symbols-outlined text-4xl text-red-300 block mb-2">error_outline</span>
      <p className="text-sm font-semibold text-gray-500 mb-1">Failed to load analysis</p>
      <p className="text-xs text-gray-400 mb-4">
        Something went wrong loading the financial analysis. Please try again.
      </p>
      <button
        onClick={onRetry}
        className="text-xs font-semibold text-white px-4 py-2 rounded-lg"
        style={{ backgroundColor: BANKER_BLUE }}
      >
        Retry
      </button>
    </div>
  );
}
