"use client";

interface DealFinancialsEmptyStateProps {
  /** True while an extraction is running. */
  extracting: boolean;
  /** Live progress label (cycled by parent every 15s). */
  extractLabel: string;
  /** Bulk Extract trigger — runs the agent across every financial-shaped doc. */
  onExtract: () => void;
  /** True while the extraction-debug JSON is downloading. */
  debugDownloading: boolean;
  /** Triggers the extraction-debug JSON download. */
  onDownloadDebug: () => void;
}

/**
 * Empty-state body shown inside FinancialShell when the deal has no
 * financial statements yet. Offers the primary Extract Financials action
 * (Banker Blue) plus a secondary debug-JSON download — useful when a prior
 * extraction yielded nothing and the user wants to see what text the parser
 * actually saw.
 */
export function DealFinancialsEmptyState({
  extracting,
  extractLabel,
  onExtract,
  debugDownloading,
  onDownloadDebug,
}: DealFinancialsEmptyStateProps) {
  return (
    <div className="text-center" style={{ padding: "40px 16px" }}>
      <span className="material-symbols-outlined text-gray-300 block mb-2" style={{ fontSize: 40 }}>table_chart</span>
      <p className="text-sm font-semibold text-gray-800" style={{ marginBottom: 4 }}>No Financial Data Yet</p>
      <p className="text-xs text-gray-500" style={{ marginBottom: 20 }}>
        Upload a CIM, P&amp;L, or financial PDF to extract the 3-statement model automatically.
      </p>
      <button
        onClick={onExtract}
        disabled={extracting}
        className="inline-flex items-center gap-2 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-60"
        style={{ padding: "10px 20px", backgroundColor: "#003366" }}>
        {extracting ? (
          <>
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            {extractLabel || "Extracting… (30–60s)"}
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
            Extract Financials
          </>
        )}
      </button>
      {/* Debug download — useful when extraction yielded nothing
          so the user can see what text the parser actually saw. */}
      <div className="mt-3">
        <button
          onClick={onDownloadDebug}
          disabled={debugDownloading}
          className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-700 disabled:opacity-60"
        >
          <span className="material-symbols-outlined text-[14px]">
            {debugDownloading ? "progress_activity" : "download"}
          </span>
          Download extraction JSON (debug)
        </button>
      </div>
    </div>
  );
}
