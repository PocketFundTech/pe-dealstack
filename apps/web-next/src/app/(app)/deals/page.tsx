"use client";

import { useEffect, useState, useCallback, useRef, type DragEvent } from "react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  SORT_OPTIONS,
  DEAL_SIZE_OPTIONS,
  DEFAULT_CARD_METRICS,
  ALL_METRIC_KEYS,
  type MetricKey,
} from "@/lib/constants";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { onDealsChanged } from "@/lib/appEvents";
import { useIngestDealModal } from "@/providers/IngestDealModalProvider";
import type {
  Deal,
  DealFilters,
  FinancialSummariesMap,
} from "@/types";
import {
  DeleteModal,
  StageChangeModal,
  DealCard,
  UploadCard,
} from "./components";
import { DealsFilterBar } from "./deals-page-filter-bar";
import { BulkActionsBar } from "./deals-page-bulk-actions";
import { KanbanView } from "./deals-page-kanban-view";
import { KanbanSkeleton, ListSkeleton } from "./deals-page-skeletons";
import { ErrorState, NoMatchingDealsState, WelcomeEmptyState } from "./deals-page-empty-states";
import { exportDealsToCSV } from "./deals-csv-export";

export default function DealsPage() {
  const { openDealIntake } = useIngestDealModal();
  const [deals, setDeals] = useState<Deal[]>([]);
  // Latest INCOME_STATEMENT summary per deal — fetched in parallel with
  // the deals list so cards can render revenue/EBITDA at the correct
  // unitScale instead of falling through formatCurrency() (which assumes
  // MILLIONS and turns extracted "$6.7K" data into "$6.7M").
  const [summaries, setSummaries] = useState<FinancialSummariesMap>({});
  // True until the bulk financial-summaries fetch resolves. While true,
  // the cards render an em-dash for revenue/EBITDA instead of falling
  // through to formatCurrency(deal.revenue / deal.ebitda) — which assumes
  // MILLIONS and prints stale legacy column data at the wrong magnitude
  // (e.g. deal.ebitda = 21.5 stored at thousands → "$21.5M").
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "kanban">("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [stageModal, setStageModal] = useState(false);
  const [bulkPassConfirm, setBulkPassConfirm] = useState(false);
  const [industries, setIndustries] = useState<string[]>([]);
  const [filters, setFilters] = useState<DealFilters>({
    stage: "",
    industry: "",
    minDealSize: "",
    maxDealSize: "",
    priority: "",
    search: "",
    sortBy: "updatedAt",
    sortOrder: "desc",
  });
  const [activeMetrics, setActiveMetrics] = useState<MetricKey[]>([...DEFAULT_CARD_METRICS]);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load view preference and metrics from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.dealsView);
    if (saved === "kanban" || saved === "list") setView(saved);
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.dealCardMetrics);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.filter((k: string) => ALL_METRIC_KEYS.includes(k as MetricKey));
          if (valid.length > 0) setActiveMetrics(valid as MetricKey[]);
        }
      }
    } catch (err) {
      console.warn("[deals] failed to read cached metrics:", err);
    }
  }, []);

  const loadDeals = useCallback(async (opts?: { silent?: boolean }) => {
    // `silent` refetches keep the current list on screen (no skeleton flash) —
    // used for background refreshes triggered by an ingest elsewhere or a tab
    // refocus, as opposed to the initial load / filter change.
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.stage) params.set("stage", filters.stage);
      if (filters.industry) params.set("industry", filters.industry);
      if (filters.minDealSize) params.set("minDealSize", filters.minDealSize);
      if (filters.maxDealSize) params.set("maxDealSize", filters.maxDealSize);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.search) params.set("search", filters.search);
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortOrder) params.set("sortOrder", filters.sortOrder);
      params.set("limit", "50");

      const data = await api.get<Deal[]>(`/deals?${params}`);
      const raw = Array.isArray(data) ? data : [];
      // Flatten company.name into companyName so cards can display it
      const list = raw.map((d) => ({
        ...d,
        companyName: d.companyName || d.company?.name || undefined,
      }));
      setDeals(list);
      setIndustries([...new Set(list.map((d) => d.industry).filter(Boolean) as string[])].sort());

      // Bulk financial summaries — does NOT block the initial cards
      // render (names/stages/AI thesis appear immediately), but the
      // cards hold revenue/EBITDA as em-dash skeletons until this
      // resolves so we never paint stale legacy column data through
      // formatCurrency() (which assumes MILLIONS).
      setSummariesLoading(true);
      void (async () => {
        try {
          const dealIds = list.map((d) => d.id).join(",");
          if (!dealIds) {
            setSummaries({});
            return;
          }
          const resp = await api.get<{ summaries: FinancialSummariesMap }>(
            `/deals/financial-summaries?dealIds=${encodeURIComponent(dealIds)}`,
          );
          setSummaries(resp?.summaries ?? {});
        } catch (err) {
          console.warn("[deals] financial summaries fetch failed:", err);
          setSummaries({});
        } finally {
          setSummariesLoading(false);
        }
      })();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadDeals();
  }, [loadDeals]);

  // Auto-refresh: refetch silently (no skeleton) when a deal is ingested/updated
  // elsewhere — e.g. a Google Drive import through the ingest modal — or when the
  // tab regains focus (covers the background Gmail sync). Keeps the pipeline
  // current without a manual reload.
  useEffect(() => {
    const off = onDealsChanged(() => loadDeals({ silent: true }));
    const onVisible = () => {
      if (document.visibilityState === "visible") loadDeals({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadDeals]);

  // Helpers
  const toggleView = (v: "list" | "kanban") => {
    setView(v);
    localStorage.setItem(STORAGE_KEYS.dealsView, v);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const hasActiveFilters =
    !!filters.stage || !!filters.industry || !!filters.minDealSize || !!filters.maxDealSize || !!filters.priority;

  const clearFilters = () =>
    setFilters((f) => ({ ...f, stage: "", industry: "", minDealSize: "", maxDealSize: "", priority: "" }));

  const handleSearch = (value: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value }));
    }, 300);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/deals/${id}`);
      setDeals((prev) => prev.filter((d) => d.id !== id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete deal");
    }
    setDeleteTarget(null);
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map((id) => api.delete(`/deals/${id}`)));
    const succeededIds = ids.filter((_, i) => results[i].status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    if (succeededIds.length > 0) {
      const succeededSet = new Set(succeededIds);
      setDeals((prev) => prev.filter((d) => !succeededSet.has(d.id)));
    }
    if (failed.length > 0) {
      console.warn("[deals] bulk delete failures:", failed.map((r) => (r as PromiseRejectedResult).reason));
      setError(`${failed.length} of ${ids.length} deletes failed.`);
    }
    setSelected(new Set());
    setDeleteTarget(null);
  };

  const handleBulkStage = async (stage: string) => {
    const ids = [...selected];
    const results = await Promise.allSettled(ids.map((id) => api.patch(`/deals/${id}`, { stage })));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.warn("[deals] bulk stage-change failures:", failed.map((r) => (r as PromiseRejectedResult).reason));
      setError(`${failed.length} of ${ids.length} stage updates failed.`);
    }
    setStageModal(false);
    clearSelection();
    loadDeals();
  };

  const handleBulkPass = () => {
    setBulkPassConfirm(true);
  };

  const confirmBulkPass = async () => {
    setBulkPassConfirm(false);
    await handleBulkStage("PASSED");
  };

  // CSV Export — pass the in-memory summaries map so revenue/EBITDA
  // columns render at the correct unitScale instead of through
  // formatCurrency(deal.revenue) (which assumes MILLIONS).
  const exportSelectedToCSV = () => exportDealsToCSV(deals, selected, summaries);

  // Save metrics preference to localStorage (and server if available)
  const handleMetricsApply = (metrics: MetricKey[]) => {
    setActiveMetrics(metrics);
    localStorage.setItem(STORAGE_KEYS.dealCardMetrics, JSON.stringify(metrics));
    // Fire-and-forget save to server
    api.patch("/users/me", { dealCardMetrics: metrics }).catch((err) => {
      console.warn("[deals] failed to save metrics preference to server:", err);
    });
  };

  // Remove sample deal
  const handleRemoveSample = async (id: string) => {
    try {
      await api.delete(`/deals/${id}`);
      setDeals((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.warn("[deals] removeSample failed:", err);
    }
  };

  // Kanban drag-and-drop
  const handleKanbanDrop = async (e: DragEvent<HTMLDivElement>, newStage: string) => {
    e.preventDefault();
    setDragOverStage(null);
    const dealId = e.dataTransfer.getData("text/plain");
    if (!dealId) return;
    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage === newStage) return;
    const oldStage = deal.stage;
    // Optimistic update
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stage: newStage } : d)));
    try {
      await api.patch(`/deals/${dealId}`, { stage: newStage });
    } catch (err) {
      console.warn("[deals] kanban drop failed, reverting:", err);
      // Revert on error
      setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stage: oldStage } : d)));
    }
  };

  // Keyboard shortcuts (CMD+K handled by layout Header; deals page handles Escape)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape to clear selection
      if (e.key === "Escape" && selected.size > 0) {
        clearSelection();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selected.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const sortLabel = SORT_OPTIONS.find(
    (o) => o.sortBy === filters.sortBy && o.sortOrder === filters.sortOrder
  )?.label || "Recent Activity";

  const dealSizeLabel = (() => {
    if (!filters.minDealSize && !filters.maxDealSize) return "Deal Size: All";
    const opt = DEAL_SIZE_OPTIONS.find(
      (o) => o.min === filters.minDealSize && o.max === filters.maxDealSize
    );
    return opt ? `Size: ${opt.label}` : "Deal Size";
  })();

  return (
    <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">Deal Pipeline</h1>
          <p className="text-text-secondary text-sm flex items-center gap-2">
            {!loading && (
              <>
                <span className="w-2 h-2 rounded-full bg-secondary shadow-[0_0_8px_rgba(5,150,105,0.4)]" />
                {deals.filter((d) => d.status !== "PASSED").length} Active Opportunities
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={openDealIntake}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-text-secondary hover:border-[#003366] hover:text-[#003366] bg-surface-card text-sm font-medium transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">upload_file</span>
          Import Deals
        </button>
      </div>

      {/* Filter Bar */}
      <DealsFilterBar
        filters={filters}
        setFilters={setFilters}
        industries={industries}
        hasActiveFilters={hasActiveFilters}
        clearFilters={clearFilters}
        view={view}
        toggleView={toggleView}
        activeMetrics={activeMetrics}
        onMetricsApply={handleMetricsApply}
        sortLabel={sortLabel}
        dealSizeLabel={dealSizeLabel}
      />

      {/* Bulk Actions Bar */}
      {selected.size > 0 && (
        <BulkActionsBar
          count={selected.size}
          onClear={clearSelection}
          onChangeStage={() => setStageModal(true)}
          onExport={exportSelectedToCSV}
          onMarkPassed={handleBulkPass}
          onDelete={() => setDeleteTarget({ id: "__bulk__", name: `${selected.size} deals` })}
        />
      )}

      {/* Content */}
      {loading ? (
        view === "kanban" ? <KanbanSkeleton /> : <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={loadDeals} />
      ) : deals.length === 0 ? (
        hasActiveFilters ? (
          <NoMatchingDealsState />
        ) : (
          <WelcomeEmptyState onCreate={openDealIntake} />
        )
      ) : view === "list" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-5 pb-6">
          {deals.map((deal) => (
            <DealCard
              key={deal.id}
              deal={deal}
              selected={selected.has(deal.id)}
              onToggleSelect={toggleSelect}
              onDelete={(id, name) => setDeleteTarget({ id, name })}
              activeMetrics={activeMetrics}
              onRemoveSample={handleRemoveSample}
              summary={summaries[deal.id]}
              summariesLoading={summariesLoading}
            />
          ))}
          <UploadCard onClick={openDealIntake} />
        </div>
      ) : (
        /* Kanban View */
        <KanbanView
          deals={deals}
          activeMetrics={activeMetrics}
          dragOverStage={dragOverStage}
          setDragOverStage={setDragOverStage}
          onDrop={handleKanbanDrop}
          summaries={summaries}
          summariesLoading={summariesLoading}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <DeleteModal
          title={deleteTarget.id === "__bulk__" ? `Delete ${selected.size} deal${selected.size > 1 ? "s" : ""}?` : `Delete "${deleteTarget.name}"?`}
          onConfirm={() => {
            if (deleteTarget.id === "__bulk__") handleBulkDelete();
            else handleDelete(deleteTarget.id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Bulk Stage Change Modal */}
      {stageModal && (
        <StageChangeModal
          count={selected.size}
          onSelect={handleBulkStage}
          onClose={() => setStageModal(false)}
        />
      )}

      {/* Bulk Pass Confirmation */}
      <ConfirmDialog
        open={bulkPassConfirm}
        title="Mark deals as Passed"
        message={`Mark ${selected.size} deal${selected.size > 1 ? "s" : ""} as Passed?`}
        confirmLabel="Mark as Passed"
        variant="danger"
        onConfirm={confirmBulkPass}
        onCancel={() => setBulkPassConfirm(false)}
      />
    </div>
  );
}
