"use client";

// ---------------------------------------------------------------------------
// FullscreenSectionModal
//
// React port of dealFullscreen.js. Provides a fullscreen overlay
// for the Financials and Analysis sections of the deal detail page:
//   - ESC + backdrop close
//   - body scroll lock
//   - fade-in animation
//   - Financials mode: full-width scrollable wrapper around FinancialStatementsPanel
//   - Analysis mode: vertical sidebar nav (matches legacy openSectionFullscreen
//     analysis branch) with the same tab order/icons as the inline analysis
//     section (ANALYSIS_TABS).
//
// The legacy implementation MOVES the existing DOM node into the overlay so
// state is preserved automatically. In React we instead remount the panels
// inside the overlay — they re-fetch on mount which is consistent with the
// rest of the app and avoids global DOM-juggling.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { api, NotFoundError } from "@/lib/api";
import { FinancialStatementsPanel } from "./deal-financials";
import {
  OverviewPanel,
  DeepDivePanel,
  CashCapitalPanel,
  ValuationPanel,
  DiligencePanel,
  AIInsightsPanel,
  MemoPanel,
} from "./deal-analysis-panels";
import {
  type AnalysisTab,
  type AnalysisData,
  type CrossDocData,
  type BenchmarkData,
  type InsightsResponse,
  type NarrativeInsights,
  ANALYSIS_TABS,
  BANKER_BLUE,
} from "./deal-analysis-types";

interface Props {
  section: "financials" | "analysis";
  dealId: string;
  onClose: () => void;
}

export function FullscreenSectionModal({ section, dealId, onClose }: Props) {
  // ESC key + body scroll lock
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  const isAnalysis = section === "analysis";
  const headerIcon = isAnalysis ? "insights" : "table_chart";
  const headerTitle = isAnalysis ? "AI Financial Analysis" : "Financial Statements";

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col"
      style={{
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        animation: "sfsOverlayIn 0.3s ease-out",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Header bar — banker-blue gradient, close button */}
      <header
        className="flex items-center gap-3 flex-shrink-0"
        style={{
          padding: "14px 28px",
          background: "linear-gradient(135deg,#003366 0%,#004488 100%)",
          boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
        }}
      >
        <span
          className="material-symbols-outlined"
          style={{ color: "rgba(255,255,255,0.85)", fontSize: 22 }}
        >
          {headerIcon}
        </span>
        <span
          className="text-white text-sm font-bold uppercase"
          style={{ letterSpacing: "0.05em" }}
        >
          {headerTitle}
        </span>
        <span
          className="text-[11px] font-medium ml-1"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          Full View
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className="text-[10px]"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            ESC to close
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="flex items-center justify-center transition-all"
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.08)",
              cursor: "pointer",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.2)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.3)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
            }}
          >
            <span
              className="material-symbols-outlined text-white"
              style={{ fontSize: 18 }}
            >
              close
            </span>
          </button>
        </div>
      </header>

      {/* Content area */}
      {isAnalysis ? (
        <AnalysisFullView dealId={dealId} />
      ) : (
        <div
          className="flex-1 overflow-auto"
          style={{ background: "#F8FAFC", padding: "28px 36px" }}
        >
          <FinancialStatementsPanel dealId={dealId} />
        </div>
      )}

      {/* Animation keyframes (matches legacy sfsOverlayIn) */}
      <style>{`
        @keyframes sfsOverlayIn { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AnalysisFullView — sidebar layout that mirrors the legacy 'analysis' branch
// of openSectionFullscreen. Loads its own analysis data so the panels behave
// identically to the inline DealAnalysisSection.
// ---------------------------------------------------------------------------

function AnalysisFullView({ dealId }: { dealId: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<AnalysisTab>("overview");
  const [loading, setLoading] = useState(true);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [crossDoc, setCrossDoc] = useState<CrossDocData | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkData | null>(null);
  const [insights, setInsights] = useState<NarrativeInsights | null>(null);
  const [error, setError] = useState(false);
  const [noData, setNoData] = useState(false);

  // Strict Mode double-invokes effects in dev — without this guard the
  // /financials/insights endpoint was being hit twice on every fullscreen
  // open (and the inline DealAnalysisSection separately fires its own
  // request, which the server now dedupes).
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      setNoData(false);
      try {
        let analysisData: AnalysisData | null = null;
        try {
          analysisData = await api.get<AnalysisData>(`/deals/${dealId}/financials/analysis`);
        } catch (e) {
          if (e instanceof NotFoundError) {
            if (!cancelled) {
              setNoData(true);
              setLoading(false);
            }
            return;
          }
          throw e;
        }

        if (!analysisData?.hasData) {
          if (!cancelled) {
            setNoData(true);
            setLoading(false);
          }
          return;
        }

        if (cancelled) return;
        setAnalysis(analysisData);

        const [crossDocRes, benchmarkRes, insightsRes] = await Promise.allSettled([
          api.get<CrossDocData>(`/deals/${dealId}/financials/cross-doc`),
          api.get<BenchmarkData>(`/deals/${dealId}/financials/benchmark`),
          api.get<InsightsResponse>(`/deals/${dealId}/financials/insights`),
        ]);

        if (cancelled) return;
        if (crossDocRes.status === "fulfilled") setCrossDoc(crossDocRes.value);
        if (benchmarkRes.status === "fulfilled") setBenchmark(benchmarkRes.value);
        if (insightsRes.status === "fulfilled") setInsights(insightsRes.value.insights);
      } catch (err) {
        console.warn("[fullscreen-modal] analysis load failed:", err);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
        inFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  return (
    <div className="flex-1 overflow-hidden flex" style={{ background: "#F8FAFC" }}>
      {/* Sidebar nav (matches legacy #sfs-sidebar) */}
      <nav
        className="flex-shrink-0 flex flex-col overflow-y-auto"
        style={{
          width: 200,
          background: "#fff",
          borderRight: "1px solid #E5E7EB",
        }}
      >
        <div
          style={{
            padding: "20px 16px 12px",
            borderBottom: "1px solid #F1F5F9",
          }}
        >
          <div
            className="text-[10px] font-semibold uppercase"
            style={{ color: "#94A3B8", letterSpacing: "0.08em" }}
          >
            Navigation
          </div>
        </div>
        <div className="flex-1" style={{ padding: 8 }}>
          {ANALYSIS_TABS.map((t) => {
            const isActive = t.id === activeTab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className="w-full text-left transition-all flex items-center gap-2.5"
                style={{
                  padding: "10px 14px",
                  border: "none",
                  background: isActive ? "#E8EEF4" : "transparent",
                  borderRadius: 8,
                  cursor: "pointer",
                  marginBottom: 2,
                  borderLeft: `3px solid ${isActive ? BANKER_BLUE : "transparent"}`,
                }}
                onMouseOver={(e) => {
                  if (!isActive) e.currentTarget.style.background = "#F8FAFC";
                }}
                onMouseOut={(e) => {
                  if (!isActive) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 18,
                    color: isActive ? BANKER_BLUE : "#94A3B8",
                  }}
                >
                  {t.icon}
                </span>
                <span
                  className="text-xs"
                  style={{
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? BANKER_BLUE : "#6B7280",
                  }}
                >
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid #F1F5F9",
          }}
        >
          <div
            className="text-[9px] text-center"
            style={{ color: "#CBD5E1" }}
          >
            PE Analysis Suite
          </div>
        </div>
      </nav>

      {/* Main content area */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ padding: "28px 36px" }}
      >
        {loading ? (
          <div className="text-center py-10">
            <span className="material-symbols-outlined text-4xl text-gray-300 animate-spin block mb-2">
              progress_activity
            </span>
            <p className="text-sm text-gray-400">Loading financial analysis...</p>
          </div>
        ) : error ? (
          <div className="text-center py-10">
            <span className="material-symbols-outlined text-4xl text-red-300 block mb-2">
              error_outline
            </span>
            <p className="text-sm font-semibold text-gray-500 mb-1">Failed to load analysis</p>
            <button
              type="button"
              onClick={() => {
                showToast("Refreshing analysis...", "info");
                router.refresh();
              }}
              className={cn(
                "text-xs font-semibold text-white px-4 py-2 rounded-lg mt-2",
              )}
              style={{ backgroundColor: BANKER_BLUE }}
            >
              Retry
            </button>
          </div>
        ) : noData ? (
          <div className="text-center py-10">
            <span className="material-symbols-outlined text-4xl text-gray-300 block mb-2">
              analytics
            </span>
            <p className="text-sm font-semibold text-gray-500 mb-1">
              No analysis data available yet
            </p>
            <p className="text-xs text-gray-400 leading-relaxed max-w-xs mx-auto">
              Upload financial documents and extract data to generate AI-powered analysis.
            </p>
          </div>
        ) : (
          <>
            {activeTab === "overview" && <OverviewPanel analysis={analysis} />}
            {activeTab === "deepdive" && <DeepDivePanel analysis={analysis} />}
            {activeTab === "cashcap" && <CashCapitalPanel analysis={analysis} />}
            {activeTab === "valuation" && (
              <ValuationPanel analysis={analysis} benchmark={benchmark} />
            )}
            {activeTab === "diligence" && (
              <DiligencePanel analysis={analysis} crossDoc={crossDoc} />
            )}
            {activeTab === "aiinsights" && <AIInsightsPanel insights={insights} />}
            {activeTab === "memo" && <MemoPanel analysis={analysis} dealId={dealId} />}
          </>
        )}
      </div>
    </div>
  );
}
