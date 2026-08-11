"use client";

import { useRouter } from "next/navigation";
import { CHART_TYPES, METRIC_CATALOG } from "./constants";
import type { GraphWithDeal } from "./types";

interface CreateTileProps {
  onClick: () => void;
}

function CreateTile({ onClick }: CreateTileProps) {
  return (
    <button
      onClick={onClick}
      className="group relative aspect-[4/3] rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/40 hover:border-[#003366] hover:bg-[#E6EEF5]/60 transition flex items-center justify-center"
    >
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-6 rounded-lg border-2 border-dashed border-slate-300 group-hover:border-[#003366] transition">
        <div className="w-11 h-11 rounded-full bg-white border border-slate-200 group-hover:border-[#003366] flex items-center justify-center text-slate-500 group-hover:text-[#003366] shadow-sm">
          <span className="material-symbols-outlined text-[24px]">add</span>
        </div>
        <div className="text-sm font-medium text-slate-700 group-hover:text-[#003366]">
          Create Graph
        </div>
        <div className="text-[11px] text-slate-400 -mt-1.5">
          Build a custom chart from P&amp;L and analysis metrics
        </div>
      </div>
    </button>
  );
}

interface GraphCardProps {
  graph: GraphWithDeal;
  onOpen: (graph: GraphWithDeal) => void;
  onEdit: (graph: GraphWithDeal) => void;
  onDelete: (graph: GraphWithDeal) => void;
}

function GraphCard({ graph, onOpen, onEdit, onDelete }: GraphCardProps) {
  const seriesLabels = graph.series
    .map((s) => METRIC_CATALOG.find((m) => m.key === s.metricKey)?.label)
    .filter(Boolean);

  // Prefer `target` (the typical deal codename) and fall back to `projectName`.
  // Both are nullable on the API contract — we always render *something* so the
  // user can tell at a glance which deal a card belongs to.
  const dealLabel =
    graph.deal.target || graph.deal.projectName || "Unknown deal";

  return (
    <div className="group relative aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition overflow-hidden">
      {/* Body — clicking anywhere outside the pencil/trash routes to the deal */}
      <button
        onClick={() => onOpen(graph)}
        className="absolute inset-0 text-left"
        aria-label={`Open ${dealLabel}`}
      >
        <span className="sr-only">Open deal</span>
      </button>

      <div className="relative px-4 pt-3 pb-1 pointer-events-none">
        <div className="text-[10px] uppercase tracking-wider text-[#003366] font-medium truncate">
          {dealLabel}
        </div>
        <div className="flex items-start justify-between gap-2 mt-0.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 truncate">
              {graph.title}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {CHART_TYPES.find((c) => c.key === graph.chartType)?.label} ·{" "}
              {seriesLabels.length} series
            </div>
          </div>
          <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
            {graph.chartType}
          </span>
        </div>
      </div>

      {/* Bottom strip showing series labels (no chart preview — we don't have
          deal-scoped financials cached on the cross-deal endpoint, and a stub
          chart on mock data would be misleading) */}
      <div className="absolute inset-x-0 bottom-0 top-[72px] px-4 py-3 pointer-events-none">
        <div className="h-full rounded-lg border border-dashed border-slate-200 bg-slate-50/60 flex items-center justify-center px-3">
          <div className="flex flex-wrap gap-1.5 justify-center">
            {seriesLabels.length === 0 ? (
              <span className="text-[11px] text-slate-400">No metrics configured</span>
            ) : (
              seriesLabels.map((label, idx) => (
                <span
                  key={`${graph.id}-${idx}`}
                  className="px-1.5 py-0.5 rounded-full bg-white border border-slate-200 text-[10px] text-slate-600"
                >
                  {label}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Hover affordances */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition flex gap-1 z-10">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(graph);
          }}
          className="w-7 h-7 rounded-md bg-white border border-slate-200 text-slate-600 hover:text-[#003366] hover:border-[#003366] shadow-sm flex items-center justify-center"
          title="Edit"
        >
          <span className="material-symbols-outlined text-[14px]">edit</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(graph);
          }}
          className="w-7 h-7 rounded-md bg-white border border-slate-200 text-slate-600 hover:text-rose-700 hover:border-rose-300 shadow-sm flex items-center justify-center"
          title="Delete"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
        </button>
      </div>
    </div>
  );
}

interface GalleryProps {
  graphs: GraphWithDeal[];
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onEdit: (graph: GraphWithDeal) => void;
  onDelete: (graph: GraphWithDeal) => void;
  onDismissError: () => void;
}

export function Gallery({
  graphs,
  loading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onDismissError,
}: GalleryProps) {
  const router = useRouter();

  function handleOpen(graph: GraphWithDeal) {
    router.push(`/deals/${graph.dealId}`);
  }

  return (
    <div className="max-w-[1280px] mx-auto px-8 py-7">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Graphs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Custom charts built off your deals&rsquo; P&amp;L and analysis metrics.
            Open a graph to jump back to the deal it belongs to.
          </p>
        </div>
        <div className="text-xs text-slate-400">
          {loading ? "Loading…" : `${graphs.length} saved`}
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
          <button
            onClick={onDismissError}
            className="ml-auto text-red-400 hover:text-red-600"
            aria-label="Dismiss error"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <CreateTile onClick={onCreate} />

        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : graphs.length === 0 ? (
          <EmptyCard />
        ) : (
          graphs.map((g) => (
            <GraphCard
              key={g.id}
              graph={g}
              onOpen={handleOpen}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden animate-pulse">
      <div className="px-4 pt-3 pb-1 space-y-2">
        <div className="h-2.5 w-24 bg-slate-200 rounded" />
        <div className="h-3.5 w-3/4 bg-slate-200 rounded" />
        <div className="h-2.5 w-1/3 bg-slate-100 rounded" />
      </div>
      <div className="absolute inset-x-0 bottom-0 top-[72px] px-4 py-3">
        <div className="h-full rounded-lg bg-slate-50 border border-dashed border-slate-200" />
      </div>
    </div>
  );
}

function EmptyCard() {
  return (
    <div className="aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <span className="material-symbols-outlined text-[24px]">trending_up</span>
      </div>
      <div className="text-sm font-medium text-slate-700">No graphs yet</div>
      <div className="text-[12px] text-slate-500 max-w-xs mt-1 inline-flex items-center justify-center gap-1">
        Open a deal and click
        <span className="inline-flex items-center gap-0.5 text-[#003366] font-medium">
          <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          Create Graph
        </span>
        to build one.
      </div>
    </div>
  );
}
