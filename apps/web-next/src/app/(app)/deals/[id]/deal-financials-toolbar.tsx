"use client";

import { cn } from "@/lib/cn";
import {
  TAB_CONFIG,
  type ChartType,
  type StatementType,
} from "./deal-financials-constants";
import { DealFinancialsAuditButtons } from "./deal-financials-audit-buttons";

// Chart toggle button — extracted to module scope so it isn't
// recreated on every parent render (react-hooks/static-components).
type ChartBtnProps = {
  type: ChartType;
  label: string;
  icon: string;
  chartVisible: boolean;
  chartType: ChartType;
  onToggleChart: (type: ChartType) => void;
};

function ChartBtn({ type, label, icon, chartVisible, chartType, onToggleChart }: ChartBtnProps) {
  const active = chartVisible && chartType === type;
  return (
    <button onClick={() => onToggleChart(type)}
      className={cn("flex items-center gap-1.5 text-xs border rounded-md px-3 py-1.5 transition-all",
        active ? "text-white border-transparent shadow-sm" : "text-gray-500 hover:text-gray-800 border-gray-200 hover:border-gray-300 hover:bg-gray-50")}
      style={active ? { backgroundColor: "#003366", borderColor: "#003366" } : undefined}>
      <span className="material-symbols-outlined text-sm">{icon}</span>{label}
    </button>
  );
}

interface DealFinancialsToolbarProps {
  /** Tabs that have at least one matching statement on the deal. */
  availableTabs: typeof TAB_CONFIG;
  /** Tab actually rendered (falls back to first available if active tab has no data). */
  resolvedTab: StatementType;
  onTabChange: (tab: StatementType) => void;
  /** Whether the chart panel is currently visible. */
  chartVisible: boolean;
  chartType: ChartType;
  /** Toggle chart visibility / type — replicates the parent's toggleChart() semantics. */
  onToggleChart: (type: ChartType) => void;
  /** Show the all/annual/quarterly pill (only when both kinds of periods exist). */
  showPeriodToggle: boolean;
  periodFilter: "all" | "annual" | "quarterly";
  onPeriodFilterChange: (p: "all" | "annual" | "quarterly") => void;
  /** Bulk Re-extract state + handler. */
  extracting: boolean;
  extractLabel: string;
  onExtract: () => void;
  /** Audit-button props — mirror DealFinancialsAuditButtons exactly. */
  debugDownloading: boolean;
  onDownloadDebug: () => void;
  reconciling: boolean;
  onDownloadReconcile: () => void;
  fullAuditing: boolean;
  onDownloadFullAudit: () => void;
}

/**
 * Financials toolbar — statement tabs, chart-toggle buttons, period filter,
 * bulk Re-extract, and audit-artifact downloads. Sits directly above the
 * per-doc Re-extract list and the chart/table.
 *
 * Banker Blue (#003366) is applied via inline style on the active tab and
 * active chart button — it's a brand colour, not a Tailwind utility.
 */
export function DealFinancialsToolbar({
  availableTabs,
  resolvedTab,
  onTabChange,
  chartVisible,
  chartType,
  onToggleChart,
  showPeriodToggle,
  periodFilter,
  onPeriodFilterChange,
  extracting,
  extractLabel,
  onExtract,
  debugDownloading,
  onDownloadDebug,
  reconciling,
  onDownloadReconcile,
  fullAuditing,
  onDownloadFullAudit,
}: DealFinancialsToolbarProps) {
  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <div className="flex gap-1 bg-gray-50 rounded-lg p-1 border border-gray-100">
        {availableTabs.map((t) => (
          <button key={t.key} onClick={() => onTabChange(t.key)}
            className={cn("flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-all",
              resolvedTab === t.key ? "text-white shadow-sm" : "text-gray-500 hover:text-gray-800 hover:bg-gray-100")}
            style={resolvedTab === t.key ? { backgroundColor: "#003366" } : undefined}>
            <span className="material-symbols-outlined text-sm">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        {resolvedTab === "INCOME_STATEMENT" && (
          <>
            <ChartBtn type="revenue" label="Revenue" icon="bar_chart" chartVisible={chartVisible} chartType={chartType} onToggleChart={onToggleChart} />
            <ChartBtn type="growth" label="Growth" icon="trending_up" chartVisible={chartVisible} chartType={chartType} onToggleChart={onToggleChart} />
          </>
        )}
        {resolvedTab === "BALANCE_SHEET" && (
          <ChartBtn type="composition" label="Composition" icon="donut_large" chartVisible={chartVisible} chartType={chartType} onToggleChart={onToggleChart} />
        )}
      </div>
      {showPeriodToggle && (
        <div className="flex gap-1 ml-auto bg-gray-50 rounded-lg p-0.5 border border-gray-100">
          {(["all", "annual", "quarterly"] as const).map((p) => (
            <button key={p} onClick={() => onPeriodFilterChange(p)}
              className={cn("px-2.5 py-1 text-[10px] font-medium rounded-md transition-all capitalize",
                periodFilter === p ? "bg-white shadow-sm text-gray-800" : "text-gray-400 hover:text-gray-600")}>{p}</button>
          ))}
        </div>
      )}
      {/* Re-extract button — bulk: runs the agent across every
          financial-shaped doc on the deal. For a single-doc re-run
          (e.g. when one large XLSX is timing out under multi-doc and
          shedding data), use the per-doc list below. */}
      <button
        onClick={onExtract}
        disabled={extracting}
        className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded-md px-3 py-1.5 transition-all hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
      >
        {extracting ? (
          <>
            <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            {extractLabel || "Extracting…"}
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-sm">refresh</span>
            Re-extract
          </>
        )}
      </button>
      <DealFinancialsAuditButtons
        onDownloadDebug={onDownloadDebug}
        debugDownloading={debugDownloading}
        onDownloadReconcile={onDownloadReconcile}
        reconciling={reconciling}
        onDownloadFullAudit={onDownloadFullAudit}
        fullAuditing={fullAuditing}
      />
    </div>
  );
}
