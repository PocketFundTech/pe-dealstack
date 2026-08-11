"use client";

interface DealFinancialsAuditButtonsProps {
  /** Phase-0 download — extraction-debug JSON. */
  onDownloadDebug: () => void;
  debugDownloading: boolean;
  /** Phase-1 reconciliation — pure-TS computed ground truth. */
  onDownloadReconcile: () => void;
  reconciling: boolean;
  /** Phase-2 full audit — Phase 1 + 4 parallel LLM calls. */
  onDownloadFullAudit: () => void;
  fullAuditing: boolean;
}

/**
 * Audit-artifact download buttons that sit at the right end of the financials
 * toolbar. Three icon-only 30x30 buttons that all stream JSON with
 * Content-Disposition: attachment via the parent's downloadJsonAttachment
 * helper:
 *   - Extraction-debug JSON — audit what the AI got from the source docs.
 *   - Phase-1 reconciliation — pure-TS, safe to re-run anytime.
 *   - Phase-2 full audit — slow (~30-60s, 4 LLM calls), costs a few cents.
 *
 * The bulk Re-extract button shares the same toolbar but is owned by the
 * parent (it's the primary action; this component holds only the secondary
 * download triggers).
 */
export function DealFinancialsAuditButtons({
  onDownloadDebug,
  debugDownloading,
  onDownloadReconcile,
  reconciling,
  onDownloadFullAudit,
  fullAuditing,
}: DealFinancialsAuditButtonsProps) {
  return (
    <>
      {/* Extraction-debug JSON download — audit what the AI got from
          the source docs vs what's in the deal record. */}
      <button
        onClick={onDownloadDebug}
        disabled={debugDownloading}
        title="Download extraction JSON (audit what AI extracted from the source docs)"
        aria-label="Download extraction debug JSON"
        className="flex items-center justify-center text-gray-500 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded-md transition-all hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
        style={{ width: 30, height: 30 }}
      >
        <span className="material-symbols-outlined text-sm">
          {debugDownloading ? "progress_activity" : "download"}
        </span>
      </button>
      {/* Phase-1 reconciliation download — computed ground truth
          (annual sums, TTM, MRR, margins), channel concentration,
          valuation framing vs comp bands, OpEx step-up findings.
          Pure-TS server side; safe to re-run anytime. */}
      <button
        onClick={onDownloadReconcile}
        disabled={reconciling}
        title="Run quantitative reconciliation (compute TTM/MRR/margins/HHI/valuation from raw line items, download as JSON)"
        aria-label="Run quantitative reconciliation"
        className="flex items-center justify-center text-gray-500 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded-md transition-all hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
        style={{ width: 30, height: 30 }}
      >
        <span className="material-symbols-outlined text-sm">
          {reconciling ? "progress_activity" : "calculate"}
        </span>
      </button>
      {/* Phase-2 full audit — Phase 1 + LLM-augmented blocks.
          Slow (~30-60s, 4 LLM calls in parallel) and costs a few
          cents per run, hence the separate button. */}
      <button
        onClick={onDownloadFullAudit}
        disabled={fullAuditing}
        title="Full audit — Phase 1 + LLM-extracted CIM claim variances, material findings, extraction-quality critique, and a prioritised diligence to-do list. ~30-60s."
        aria-label="Run full reconciliation audit (LLM)"
        className="flex items-center justify-center text-gray-500 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded-md transition-all hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
        style={{ width: 30, height: 30 }}
      >
        <span className="material-symbols-outlined text-sm">
          {fullAuditing ? "progress_activity" : "verified"}
        </span>
      </button>
    </>
  );
}
