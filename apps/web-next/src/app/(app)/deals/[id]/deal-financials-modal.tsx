"use client";

import { useEffect } from "react";
import {
  getCurrencySymbol,
  formatFinancialValue,
  formatPercent,
} from "@/lib/formatters";
import { type FinancialStatement } from "./deal-financials-charts";
import { comparePeriodChronologically } from "./deal-financials-period-scope";

// Local structural shape mirroring AgentStep in
// apps/api/src/services/agents/financialAgent/state.ts (lines 42-47).
// Defined here (not in shared types) so we can render the step log without
// expanding the global ExtractionResult contract.
type AgentStep = {
  message: string;
  timestamp?: string | null;
  detail?: unknown;
  node?: string;
};

// Per-document record from the aggregate extraction response.
// Mirrors documentsProcessed[] from financials-extraction.ts:412-420.
type ProcessedDoc = {
  id?: string;
  name?: string;
  status?: string;
  statementsStored?: number;
  periodsStored?: number;
  overallConfidence?: number | null;
  error?: string;
  agent?: { steps?: AgentStep[] };
};

export interface ExtractionResult {
  result?: {
    periodsStored?: number;
    statementsStored?: number;
    documentsUsed?: number;
    documentsFailed?: number;
    warnings?: string[];
    overallConfidence?: number;
    hasConflicts?: boolean;
  };
  agent?: {
    retryCount?: number;
    steps?: AgentStep[];
  };
  documentUsed?: {
    name?: string;
  };
  documentsProcessed?: ProcessedDoc[];
  extractionMethod?: string;
}

// Format an ISO timestamp to HH:MM:SS for the step log. Returns "" when
// the input is missing or unparseable so the caller can omit the slot.
function formatStepTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

export function ExtractionResultModal({
  extractionResult,
  statements,
  currency,
  onClose,
}: {
  extractionResult: ExtractionResult;
  statements: FinancialStatement[];
  currency: string;
  onClose: () => void;
}) {
  const result = extractionResult.result ?? {};
  const docName = extractionResult.documentUsed?.name ?? "Unknown document";
  const method = (extractionResult.extractionMethod ?? "gpt4o").toUpperCase();
  // Treat missing/zero confidence as "not reported" rather than alarming red
  // "0%". The bulk path returns null when the agent didn't surface a
  // top-level confidence number; data still got stored either way.
  const rawConf = result.overallConfidence;
  const hasConf = typeof rawConf === "number" && rawConf > 0;
  const overallConf = hasConf ? rawConf : 0;
  // Strip trailing "(N% confidence)" — same alarming substring fix as in
  // the deal-intake ResultDisplay; warnings here come from a different
  // backend path but can also embed the per-field score parenthetical.
  const warnings = (result.warnings ?? []).map((w) =>
    w.replace(/\s*\(\d+%\s*confidence\)\s*$/i, ""),
  );
  const hasConflicts = result.hasConflicts ?? false;
  const retryCount = extractionResult.agent?.retryCount ?? 0;

  // Counts pulled from the aggregate response. Each is optional —
  // omitted from the UI when the field is absent rather than rendering "0".
  const periodsStored = result.periodsStored;
  const statementsStored = result.statementsStored;
  const documentsUsed = result.documentsUsed;
  const documentsFailed = result.documentsFailed;
  const processedDocs = extractionResult.documentsProcessed ?? [];
  const failedDocs = processedDocs.filter(
    (d) => d.status && d.status !== "completed",
  );

  // Single-doc responses surface the step log on the top-level `agent` field
  // (financials-extraction.ts:405). Multi-doc responses nest the per-doc
  // agent.steps under documentsProcessed[].agent.steps. Build a unified
  // per-doc list so the modal renders one section per document either way.
  const docStepGroups: { name: string; steps: AgentStep[] }[] = (() => {
    if (processedDocs.length > 0) {
      return processedDocs
        .filter((d) => Array.isArray(d.agent?.steps) && d.agent!.steps!.length > 0)
        .map((d) => ({
          name: d.name ?? "Unknown document",
          steps: d.agent!.steps!,
        }));
    }
    const topSteps = extractionResult.agent?.steps ?? [];
    if (topSteps.length === 0) return [];
    return [{ name: docName, steps: topSteps }];
  })();
  const hasExtractionDetails =
    periodsStored != null ||
    statementsStored != null ||
    documentsUsed != null ||
    documentsFailed != null ||
    failedDocs.length > 0 ||
    docStepGroups.length > 0;

  const sym = getCurrencySymbol(currency);

  // Count by type
  const incomeCount = statements.filter((s) => s.statementType === "INCOME_STATEMENT").length;
  const balanceCount = statements.filter((s) => s.statementType === "BALANCE_SHEET").length;
  const cashFlowCount = statements.filter((s) => s.statementType === "CASH_FLOW").length;

  // Latest revenue & EBITDA
  const incomeStmts = statements
    .filter((s) => s.statementType === "INCOME_STATEMENT")
    .sort((a, b) => comparePeriodChronologically(b.period, a.period));
  const latestStmt = incomeStmts[0];
  const latestIncome = latestStmt?.lineItems ?? {};
  const revenue = latestIncome.revenue ?? null;
  const ebitda = latestIncome.ebitda ?? null;
  const grossMargin = latestIncome.gross_margin_pct ?? null;
  const ebitdaMargin = latestIncome.ebitda_margin_pct ?? null;
  const latestPeriod = latestStmt?.period ?? "";
  const latestScale = latestStmt?.unitScale ?? "ACTUALS";

  // Confidence color — neutral grey when confidence wasn't reported so we
  // don't render an alarming red "0%" bar for what is usually a successful
  // extraction (the bulk path doesn't always populate overallConfidence).
  const confColor = !hasConf
    ? "#6b7280"
    : overallConf >= 80
      ? "#059669"
      : overallConf >= 50
        ? "#d97706"
        : "#dc2626";

  const fmtVal = (val: number | null | undefined) =>
    formatFinancialValue(val, latestScale, { currency });
  const fmtPctVal = formatPercent;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleViewFinancials = () => {
    onClose();
    const el = document.getElementById("financials-section");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-[slideUp_0.3s_ease-out]"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-xl" style={{ color: "#003366" }}>
                auto_awesome
              </span>
              <h3 className="text-base font-bold text-gray-900">Extraction Results</h3>
            </div>
            {hasConflicts ? (
              <span
                className="px-2.5 py-1 rounded-full text-xs font-medium inline-flex items-center gap-1"
                style={{ background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a" }}
              >
                <span className="material-symbols-outlined text-xs">warning</span>
                Conflicts Found
              </span>
            ) : (
              <span
                className="px-2.5 py-1 rounded-full text-xs font-medium inline-flex items-center gap-1"
                style={{ background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0" }}
              >
                <span className="material-symbols-outlined text-xs">check_circle</span>
                Extraction Complete
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-xs">description</span>
            {docName}
            <span className="mx-1">&middot;</span>
            {method}
            {retryCount > 0 && (
              <>
                <span className="mx-1">&middot;</span>
                {retryCount} retries
              </>
            )}
          </p>
        </div>

        {/* Confidence */}
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-600">Overall Confidence</span>
            <span className="text-sm font-bold" style={{ color: confColor }}>
              {hasConf ? `${overallConf}%` : "Not reported"}
            </span>
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "#f3f4f6" }}>
            <div
              className="h-2 rounded-full transition-all"
              style={{ width: `${hasConf ? overallConf : 0}%`, background: confColor }}
            />
          </div>
        </div>

        {/* Extracted Metrics 2x2 Grid */}
        <div className="px-6 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                Revenue {latestPeriod ? `(${latestPeriod})` : ""}
              </p>
              <p className="text-sm font-bold text-gray-900 mt-1">{fmtVal(revenue)}</p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">EBITDA</p>
              <p className="text-sm font-bold text-gray-900 mt-1">{fmtVal(ebitda)}</p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Gross Margin</p>
              <p className="text-sm font-bold text-gray-900 mt-1">{fmtPctVal(grossMargin)}</p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">EBITDA Margin</p>
              <p className="text-sm font-bold text-gray-900 mt-1">{fmtPctVal(ebitdaMargin)}</p>
            </div>
          </div>
        </div>

        {/* Statement counts + Currency */}
        <div className="px-6 pb-4">
          <div className="flex gap-2 flex-wrap">
            {incomeCount > 0 && (
              <span
                className="px-2.5 py-1 rounded-full text-[10px] font-semibold"
                style={{ background: "#eff6ff", color: "#1e40af", border: "1px solid #bfdbfe" }}
              >
                Income: {incomeCount} period{incomeCount > 1 ? "s" : ""}
              </span>
            )}
            {balanceCount > 0 && (
              <span
                className="px-2.5 py-1 rounded-full text-[10px] font-semibold"
                style={{ background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0" }}
              >
                Balance: {balanceCount} period{balanceCount > 1 ? "s" : ""}
              </span>
            )}
            {cashFlowCount > 0 && (
              <span
                className="px-2.5 py-1 rounded-full text-[10px] font-semibold"
                style={{ background: "#fefce8", color: "#854d0e", border: "1px solid #fef08a" }}
              >
                Cash Flow: {cashFlowCount} period{cashFlowCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Currency: <span className="font-semibold text-gray-700">{sym.trim()} ({currency})</span>
          </p>
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="px-6 pb-4">
            <div className="p-3 rounded-lg" style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
              <p className="text-xs font-medium" style={{ color: "#92400e" }}>Warnings:</p>
              <ul className="text-xs mt-1 space-y-0.5" style={{ color: "#a16207" }}>
                {warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0">&bull;</span>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Extraction details — collapsed by default. Surfaces the agent
            step log + per-doc counts so the user can audit what actually
            happened (especially how many periods got stored vs. deduped). */}
        {hasExtractionDetails && (
          <div className="px-6 pb-4">
            <details className="rounded-lg border border-gray-100 bg-gray-50/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-800 select-none flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">
                  list_alt
                </span>
                Extraction details
              </summary>
              <div className="px-3 pb-3 pt-1 space-y-3">
                {/* Counts row — periods + statements + docs used/failed.
                    Skips any field the response didn't include. */}
                {(periodsStored != null ||
                  statementsStored != null ||
                  documentsUsed != null ||
                  documentsFailed != null) && (
                  <div className="flex flex-wrap gap-1.5">
                    {periodsStored != null && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          background: "#eff6ff",
                          color: "#1e40af",
                          border: "1px solid #bfdbfe",
                        }}
                      >
                        {periodsStored} period{periodsStored === 1 ? "" : "s"}{" "}
                        stored
                      </span>
                    )}
                    {statementsStored != null && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          background: "#f0fdf4",
                          color: "#166534",
                          border: "1px solid #bbf7d0",
                        }}
                      >
                        {statementsStored} statement
                        {statementsStored === 1 ? "" : "s"}
                      </span>
                    )}
                    {documentsUsed != null && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          background: "#f8fafc",
                          color: "#334155",
                          border: "1px solid #e2e8f0",
                        }}
                      >
                        {documentsUsed} doc{documentsUsed === 1 ? "" : "s"} used
                      </span>
                    )}
                    {documentsFailed != null && documentsFailed > 0 && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                        style={{
                          background: "#fef2f2",
                          color: "#991b1b",
                          border: "1px solid #fecaca",
                        }}
                      >
                        {documentsFailed} failed
                      </span>
                    )}
                  </div>
                )}

                {/* Failed-doc errors — surface the per-doc error string from
                    the 240s timeout / agent failure cases at the top so the
                    user immediately sees which doc shed data. */}
                {failedDocs.length > 0 && (
                  <div
                    className="p-2.5 rounded-md"
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                    }}
                  >
                    <p
                      className="text-[11px] font-semibold mb-1"
                      style={{ color: "#991b1b" }}
                    >
                      Documents that didn&rsquo;t complete:
                    </p>
                    <ul
                      className="text-[11px] space-y-0.5"
                      style={{ color: "#b91c1c" }}
                    >
                      {failedDocs.map((d, i) => (
                        <li
                          key={d.id ?? i}
                          className="flex items-start gap-1.5"
                        >
                          <span className="mt-0.5 shrink-0">&bull;</span>
                          <span className="truncate">
                            <span className="font-medium">
                              {d.name ?? "document"}
                            </span>
                            {d.error ? ` — ${d.error}` : ` — ${d.status}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Per-document step log. One block per doc; messages render
                    in monospace so timestamps + numbers line up. */}
                {docStepGroups.length > 0 && (
                  <div className="space-y-2">
                    {docStepGroups.map((g, gi) => (
                      <div key={gi}>
                        <p className="text-[11px] font-semibold text-gray-700 truncate">
                          {g.name}
                        </p>
                        <ol
                          className="mt-1 rounded-md bg-white border border-gray-100 px-2.5 py-1.5 max-h-48 overflow-y-auto font-mono text-[10px] text-gray-600 space-y-0.5"
                        >
                          {g.steps.map((s, si) => {
                            const t = formatStepTime(s.timestamp);
                            return (
                              <li
                                key={si}
                                className="flex items-start gap-2 leading-snug"
                              >
                                {t && (
                                  <span className="text-gray-400 shrink-0">
                                    {t}
                                  </span>
                                )}
                                <span className="break-words">
                                  {s.message}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}

        {/* Actions */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
          <button
            onClick={handleViewFinancials}
            className="flex-1 py-2.5 px-4 rounded-lg text-white text-sm font-medium transition-all flex items-center justify-center gap-2"
            style={{ background: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">table_chart</span>
            View Financials
          </button>
        </div>
      </div>

      {/* slideUp animation */}
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
