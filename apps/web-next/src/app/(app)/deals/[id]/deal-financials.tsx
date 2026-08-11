"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { api, NotFoundError } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";
import { type FinancialStatement } from "./deal-financials-charts";

// chart.js + react-chartjs-2 are heavy. The charts only render conditionally
// (on the relevant tab + chart type), so load them lazily — this keeps
// chart.js out of the deal page's initial bundle and defers it until a chart
// is actually viewed. ssr:false is safe: this is already a client subtree.
const RevenueChart = dynamic(
  () => import("./deal-financials-charts").then((m) => m.RevenueChart),
  { ssr: false },
);
const GrowthChart = dynamic(
  () => import("./deal-financials-charts").then((m) => m.GrowthChart),
  { ssr: false },
);
const BalanceSheetChart = dynamic(
  () => import("./deal-financials-charts").then((m) => m.BalanceSheetChart),
  { ssr: false },
);
import {
  TAB_CONFIG,
  type ChartType,
  type StatementType,
} from "./deal-financials-constants";
import {
  ValidationFlagsPanel,
  deriveClientValidationFlags,
  type ValidationCheck,
  type ValidationResult,
} from "./deal-financials-validation";
import {
  ConflictBanner,
  type ConflictGroup,
} from "./deal-financials-conflicts";
import { FinancialShell, FinancialTable } from "./deal-financials-table";
import {
  ExtractionResultModal,
  type ExtractionResult,
} from "./deal-financials-modal";
import {
  DealFinancialsReextractList,
  type FinancialDocLite,
} from "./deal-financials-reextract-list";
import { useRemoveByDocument } from "./deal-financials-remove-by-document";
import { DealFinancialsEmptyState } from "./deal-financials-empty-state";
import { DealFinancialsToolbar } from "./deal-financials-toolbar";
import {
  DealFinancialsLoadingState,
  DealFinancialsErrorState,
} from "./deal-financials-status-states";

// --- Main Panel ---

export function FinancialStatementsPanel({ dealId, onFullscreen }: { dealId: string; onFullscreen?: () => void }) {
  const { showToast } = useToast();
  const [statements, setStatements] = useState<FinancialStatement[]>([]);
  const [serverValidation, setServerValidation] = useState<ValidationResult | null>(null);
  const [conflicts, setConflicts] = useState<ConflictGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<StatementType>("INCOME_STATEMENT");
  const [chartVisible, setChartVisible] = useState(false);
  const [chartType, setChartType] = useState<ChartType>("revenue");
  const [periodFilter, setPeriodFilter] = useState<"all" | "annual" | "quarterly">("all");
  const [extracting, setExtracting] = useState(false);
  const [extractingDocId, setExtractingDocId] = useState<string | null>(null);
  const [extractionModalResult, setExtractionModalResult] = useState<ExtractionResult | null>(null);
  const [dealDocs, setDealDocs] = useState<FinancialDocLite[]>([]);

  const loadFinancials = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Fetch statements, validation flags, conflict groups, and the deal's
      // documents in parallel. We need the doc list to render per-document
      // Re-extract buttons; fetching it from /deals/:id (rather than a
      // dedicated documents endpoint) matches what page.tsx already does.
      // Validation and conflicts endpoints may return 404 if not yet implemented —
      // we treat that gracefully (fall back to client-side derivation).
      const [stmtData, validData, conflictData, dealData] = await Promise.allSettled([
        api.get<FinancialStatement[]>(`/deals/${dealId}/financials`),
        api.get<ValidationResult>(`/deals/${dealId}/financials/validation`),
        api.get<{ conflicts: ConflictGroup[]; count: number }>(`/deals/${dealId}/financials/conflicts`),
        api.get<{ documents?: FinancialDocLite[] }>(`/deals/${dealId}`),
      ]);

      if (stmtData.status === "fulfilled") {
        // API returns raw array, but handle wrapped responses too
        const raw = stmtData.value as unknown;
        const arr = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as Record<string, unknown>)?.statements)
            ? (raw as Record<string, unknown>).statements as FinancialStatement[]
            : Array.isArray((raw as Record<string, unknown>)?.financials)
              ? (raw as Record<string, unknown>).financials as FinancialStatement[]
              : [];
        setStatements(arr);
      } else {
        const err = stmtData.reason;
        const msg = err instanceof Error ? err.message : "Failed to load financials";
        // Treat 404/Not Found as empty data rather than an error
        if (err instanceof NotFoundError || msg.includes("404") || msg.toLowerCase().includes("not found")) {
          setStatements([]);
        } else {
          setError(msg);
        }
      }

      if (validData.status === "fulfilled" && validData.value?.checks) {
        setServerValidation(validData.value);
      } else {
        setServerValidation(null);
      }

      if (conflictData.status === "fulfilled" && Array.isArray(conflictData.value?.conflicts)) {
        setConflicts(conflictData.value.conflicts);
      } else {
        setConflicts([]);
      }

      if (dealData.status === "fulfilled" && Array.isArray(dealData.value?.documents)) {
        setDealDocs(dealData.value.documents);
      } else {
        setDealDocs([]);
      }
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  const handleAutoResolve = useCallback(async () => {
    try {
      await api.post(`/deals/${dealId}/financials/resolve-all`, { strategy: "highest_confidence" });
      // Reload everything after resolution
      await loadFinancials();
    } catch (err) {
      // Silently swallow — conflicts panel will still show. Log so it's not invisible.
      console.warn("[deal-financials] auto-resolve failed:", err);
    }
  }, [dealId, loadFinancials]);

  // Progress messages matching legacy (cycle every 15s)
  const [extractLabel, setExtractLabel] = useState("");

  // handleExtract accepts an optional (documentId, documentName) pair. When
  // provided, the request runs single-doc against that document only — the
  // API forces single-mode whenever documentId is set
  // (financials-extraction.ts:193-201). Without args, runs the bulk
  // 'all_financials' loop across every financial-shaped doc on the deal.
  const handleExtract = useCallback(async (documentId?: string, documentName?: string) => {
    if (extracting) return;
    setExtracting(true);
    if (documentId) setExtractingDocId(documentId);
    setExtractLabel("Extracting… (30–60s)");

    const progressMsgs = [
      "Extracting… (reading file)",
      "Extracting… (analyzing data)",
      "Extracting… (almost done)",
    ];
    let idx = 0;
    const progressTimer = setInterval(() => {
      idx = (idx + 1) % progressMsgs.length;
      setExtractLabel(progressMsgs[idx]);
    }, 15000);

    try {
      // Single-doc path passes documentId in the body; the API forces
      // mode='single' regardless of the mode field. Bulk path stays on
      // 'all_financials' which loops every CIM/FINANCIALS/spreadsheet doc
      // and merges by (statementType, period) inside runDeepPass.
      const body = documentId
        ? { documentId, mode: "single" as const }
        : { mode: "all_financials" as const };
      const result = await api.post<ExtractionResult>(
        `/deals/${dealId}/financials/extract`,
        body,
      );

      // Small delay before fetching — the API may return success before data
      // is fully committed to the database (observed in production).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await loadFinancials();

      const stored = result?.result?.periodsStored ?? 0;
      const warnings = result?.result?.warnings ?? [];
      const docsUsed =
        (result as unknown as { result?: { documentsUsed?: number } })?.result
          ?.documentsUsed;
      const docsFailed =
        (result as unknown as { result?: { documentsFailed?: number } })?.result
          ?.documentsFailed;

      if (stored === 0) {
        const warningMsg =
          warnings.length > 0
            ? warnings[0]
            : "No financial data found in the documents. Try uploading a P&L, Balance Sheet, or CIM.";
        showToast(warningMsg, "warning", { title: "No Data Extracted" });
      } else {
        // Distinct toast for the single-doc path so the user sees which
        // doc was just re-extracted; bulk path keeps the across-N-docs copy.
        if (documentId) {
          const label = documentName ?? "document";
          showToast(`Re-extracted: ${label}`, "success", { title: "Extraction complete" });
        } else if (docsUsed && docsUsed > 1) {
          showToast(
            `Re-extracted across ${docsUsed} document${docsUsed === 1 ? "" : "s"}${docsFailed ? ` (${docsFailed} failed)` : ""}.`,
            "success",
            { title: "Extraction complete" },
          );
        }
        setExtractionModalResult(result);
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? "Extraction timed out (>2 min). The file may be too large — try again or upload a simpler P&L."
          : "Could not extract financial data — document may be encrypted or unsupported";
      showToast(msg, "warning", { title: "No Data Extracted" });
    } finally {
      clearInterval(progressTimer);
      setExtracting(false);
      setExtractingDocId(null);
      setExtractLabel("");
    }
  }, [dealId, extracting, loadFinancials, showToast]);

  // Per-doc "remove all extracted statements" — see hook for details. Pulled
  // into its own module so this component stays under the 500-line cap.
  const { removingDocId, handleRemoveByDocument } = useRemoveByDocument(
    dealId,
    loadFinancials,
  );

  // Shared download helper — both the extraction-debug and reconcile
  // endpoints stream JSON with Content-Disposition: attachment. Using
  // authFetchRaw lets us pull res.blob() and force a download; the
  // shared api client only returns parsed JSON.
  const downloadJsonAttachment = useCallback(
    async (path: string, fallbackBaseName: string, errorTitle: string) => {
      const res = await authFetchRaw(path);
      if (!res.ok) {
        const msg = res.status === 404 ? "Deal not found" : `Server returned ${res.status}`;
        showToast(msg, "warning", { title: errorTitle });
        return;
      }
      const blob = await res.blob();
      const datePart = new Date().toISOString().split("T")[0];
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] || `${fallbackBaseName}-${dealId}-${datePart}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [dealId, showToast],
  );

  const [debugDownloading, setDebugDownloading] = useState(false);
  const handleDownloadDebug = useCallback(async () => {
    if (debugDownloading) return;
    setDebugDownloading(true);
    try {
      await downloadJsonAttachment(
        `/deals/${dealId}/extraction-debug`,
        "extraction",
        "Couldn't download extraction",
      );
    } catch (err) {
      console.warn("[deal-financials] debug download failed:", err);
      showToast("Couldn't download extraction JSON", "warning", { title: "Download failed" });
    } finally {
      setDebugDownloading(false);
    }
  }, [dealId, debugDownloading, downloadJsonAttachment, showToast]);

  // Phase-1 quantitative reconciliation. Hits GET /deals/:id/reconcile
  // which aggregates FinancialStatement rows into computed ground truth
  // (annual sums, TTM, MRR, margins), channel concentration + HHI,
  // valuation framing vs micro-SaaS bands, and OpEx step-up findings.
  // Pure-TS server side — no LLM cost — so this is safe to re-run
  // whenever the user wants to gut-check extraction quality.
  const [reconciling, setReconciling] = useState(false);
  const handleDownloadReconcile = useCallback(async () => {
    if (reconciling) return;
    setReconciling(true);
    try {
      await downloadJsonAttachment(
        `/deals/${dealId}/reconcile`,
        "reconcile",
        "Couldn't run reconciliation",
      );
    } catch (err) {
      console.warn("[deal-financials] reconcile download failed:", err);
      showToast("Couldn't run reconciliation", "warning", { title: "Reconciliation failed" });
    } finally {
      setReconciling(false);
    }
  }, [dealId, reconciling, downloadJsonAttachment, showToast]);

  // Phase-2 full audit — Phase 1 + LLM-augmented blocks (CIM claim
  // validation, material findings synthesis, extraction-quality
  // critique, prioritised diligence to-do list). Hits the same endpoint
  // with ?level=full. Slow (~30-60s, makes 4 LLM calls in parallel)
  // and costs a few cents per run, so split out as a separate button.
  const [fullAuditing, setFullAuditing] = useState(false);
  const handleDownloadFullAudit = useCallback(async () => {
    if (fullAuditing) return;
    setFullAuditing(true);
    showToast(
      "Running full audit (~30-60s, makes 4 LLM calls)…",
      "info",
      { title: "Full audit in progress" },
    );
    try {
      await downloadJsonAttachment(
        `/deals/${dealId}/reconcile?level=full`,
        "reconcile-full",
        "Couldn't run full audit",
      );
    } catch (err) {
      console.warn("[deal-financials] full audit failed:", err);
      showToast("Couldn't run full audit", "warning", { title: "Full audit failed" });
    } finally {
      setFullAuditing(false);
    }
  }, [dealId, fullAuditing, downloadJsonAttachment, showToast]);

  useEffect(() => { loadFinancials(); }, [loadFinancials]);

  // Derived state
  const hasData = statements.length > 0;
  const availableTabs = TAB_CONFIG.filter((t) => statements.some((s) => s.statementType === t.key));
  const resolvedTab = availableTabs.find((t) => t.key === activeTab) ? activeTab : (availableTabs[0]?.key ?? "INCOME_STATEMENT");

  const filteredStatements = statements.filter((s) => {
    if (periodFilter === "all") return true;
    const isFY = /^FY\b/i.test(s.period) || /^\d{4}$/i.test(s.period);
    return periodFilter === "annual" ? isFY : !isFY;
  });

  const hasAnnual = statements.some((s) => /^FY\b/i.test(s.period) || /^\d{4}$/i.test(s.period));
  const hasQuarterly = statements.some((s) => !(/^FY\b/i.test(s.period) || /^\d{4}$/i.test(s.period)));
  const showPeriodToggle = hasAnnual && hasQuarterly;
  const detectedCurrency = statements.find((s) => s.currency)?.currency ?? "USD";
  const confidences = statements.map((s) => s.extractionConfidence).filter((c): c is number => c != null);
  const avgConfidence = confidences.length > 0 ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null;

  // Merge server-supplied validation flags with client-derived ones.
  // Server flags (from /financials/validation) take precedence; client flags
  // catch cases the server endpoint doesn't cover (e.g. low-confidence periods,
  // cross-source discrepancies visible only after the statements are loaded).
  const clientFlags = deriveClientValidationFlags(statements);
  const serverFlags: ValidationCheck[] = serverValidation?.checks.filter((c) => !c.passed) ?? [];
  // Deduplicate by check key — server wins over client for same key
  const seenChecks = new Set(serverFlags.map((f) => f.check));
  const extraClientFlags = clientFlags.filter((f) => !seenChecks.has(f.check));
  const validationFlags: ValidationCheck[] = [...serverFlags, ...extraClientFlags];

  function toggleChart(type: ChartType) {
    if (chartVisible && chartType === type) setChartVisible(false);
    else { setChartVisible(true); setChartType(type); }
  }

  function handleTabSwitch(tab: StatementType) {
    setActiveTab(tab);
    setChartVisible(false);
    setChartType(tab === "BALANCE_SHEET" ? "composition" : "revenue");
  }

  const toggleCollapsed = () => setCollapsed((p) => !p);

  // Extraction Results Modal — rendered above all states so it persists across re-renders
  const extractionModal = extractionModalResult ? (
    <ExtractionResultModal
      extractionResult={extractionModalResult}
      statements={statements}
      currency={detectedCurrency}
      onClose={() => setExtractionModalResult(null)}
    />
  ) : null;

  // Loading state
  if (loading) {
    return (
      <>
        {extractionModal}
        <FinancialShell collapsed={collapsed} onToggle={toggleCollapsed} onFullscreen={onFullscreen}>
          <DealFinancialsLoadingState />
        </FinancialShell>
      </>
    );
  }

  // Error state
  if (error) {
    return (
      <>
        {extractionModal}
        <FinancialShell collapsed={collapsed} onToggle={toggleCollapsed} onFullscreen={onFullscreen}>
          <DealFinancialsErrorState message={error} onRetry={loadFinancials} />
        </FinancialShell>
      </>
    );
  }

  // Empty state
  if (!hasData) {
    return (
      <>
        {extractionModal}
        <FinancialShell collapsed={collapsed} onToggle={toggleCollapsed} onFullscreen={onFullscreen}>
          <DealFinancialsEmptyState
            extracting={extracting}
            extractLabel={extractLabel}
            onExtract={() => handleExtract()}
            debugDownloading={debugDownloading}
            onDownloadDebug={handleDownloadDebug}
          />
        </FinancialShell>
      </>
    );
  }

  const showChart = chartVisible && (resolvedTab === "INCOME_STATEMENT" || resolvedTab === "BALANCE_SHEET");

  return (
    <>
      {extractionModal}
      <FinancialShell avgConfidence={avgConfidence} currency={detectedCurrency} collapsed={collapsed} onToggle={toggleCollapsed} onFullscreen={onFullscreen}>
        {/* Validation flags — collapsible amber/red warning card (mirrors legacy flagHtml) */}
        <ValidationFlagsPanel flags={validationFlags} />

        {/* Overlapping period conflict banner (mirrors legacy conflictBannerHtml) */}
        <ConflictBanner conflicts={conflicts} onAutoResolve={handleAutoResolve} />

        {/* Tabs + controls */}
        <DealFinancialsToolbar
          availableTabs={availableTabs}
          resolvedTab={resolvedTab}
          onTabChange={handleTabSwitch}
          chartVisible={chartVisible}
          chartType={chartType}
          onToggleChart={toggleChart}
          showPeriodToggle={showPeriodToggle}
          periodFilter={periodFilter}
          onPeriodFilterChange={setPeriodFilter}
          extracting={extracting}
          extractLabel={extractLabel}
          onExtract={() => handleExtract()}
          debugDownloading={debugDownloading}
          onDownloadDebug={handleDownloadDebug}
          reconciling={reconciling}
          onDownloadReconcile={handleDownloadReconcile}
          fullAuditing={fullAuditing}
          onDownloadFullAudit={handleDownloadFullAudit}
        />
        <DealFinancialsReextractList
          dealId={dealId}
          allDocs={dealDocs}
          extracting={extracting}
          extractingDocId={extractingDocId}
          removingDocId={removingDocId}
          onReextract={(docId, docName) => handleExtract(docId, docName)}
          onRemove={handleRemoveByDocument}
        />
        {/* Chart or Table */}
        {showChart ? (
          <>
            {resolvedTab === "INCOME_STATEMENT" && chartType === "revenue" && <RevenueChart statements={filteredStatements} />}
            {resolvedTab === "INCOME_STATEMENT" && chartType === "growth" && <GrowthChart statements={filteredStatements} />}
            {resolvedTab === "BALANCE_SHEET" && chartType === "composition" && <BalanceSheetChart statements={filteredStatements} />}
          </>
        ) : (
          <FinancialTable statements={filteredStatements} statementType={resolvedTab} conflicts={conflicts} />
        )}
      </FinancialShell>
    </>
  );
}
