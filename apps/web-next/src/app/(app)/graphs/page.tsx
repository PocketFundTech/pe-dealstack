"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/providers/ToastProvider";
import { DealPicker, type PickableDeal } from "./DealPicker";
import { Gallery } from "./Gallery";
import type { Graph, GraphWithDeal } from "./types";

// The Builder pulls in recharts (ChartRenderer.tsx), which the gallery view
// never needs. Load it lazily so recharts is only fetched once the user
// actually opens the chart builder, keeping the default /graphs load light.
const Builder = dynamic(() => import("./Builder").then((m) => m.Builder), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center py-24 text-sm text-slate-500">
      Loading chart builder…
    </div>
  ),
});

// The page is a simple state machine:
//   - "gallery": showing the firm-wide list (default)
//   - "picker":  a modal is open over the gallery so the user can choose
//                which deal a new graph should belong to
//   - "builder": the deal context is locked in and we're editing/creating
//
// Edits skip the picker entirely (the deal is already known on the graph row).
type View =
  | { mode: "gallery" }
  | { mode: "picker" }
  | { mode: "builder"; dealId: string; dealLabel: string; editing: Graph | null };

export default function GraphsPage() {
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  // Stale-while-revalidate cache: revisiting /graphs renders instantly.
  const graphsQuery = useApiQuery<GraphWithDeal[]>("/graphs");
  const graphs = useMemo<GraphWithDeal[]>(
    () => (Array.isArray(graphsQuery.data) ? graphsQuery.data : []),
    [graphsQuery.data],
  );
  const loading = graphsQuery.isLoading;
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? (graphsQuery.error && graphsQuery.data === undefined ? graphsQuery.error.message || "Failed to load graphs" : null);
  const [view, setView] = useState<View>({ mode: "gallery" });
  const [deleteTarget, setDeleteTarget] = useState<GraphWithDeal | null>(null);

  // Deep-link handoff from the deal page's "Add a Graph" action:
  // /graphs?dealId=...&dealLabel=... opens the Builder directly so the
  // analyst doesn't have to re-pick a deal they were already viewing.
  // Run once on first render — react-strict-mode-safe via the ref guard.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const dealId = searchParams.get("dealId");
    if (!dealId) {
      deepLinkHandled.current = true;
      return;
    }
    const dealLabel = searchParams.get("dealLabel") || "Untitled deal";
    setView({ mode: "builder", dealId, dealLabel, editing: null });
    deepLinkHandled.current = true;
  }, [searchParams]);

  const { refetch: refetchGraphs } = graphsQuery;
  const loadGraphs = useCallback(() => {
    setActionError(null);
    return refetchGraphs();
  }, [refetchGraphs]);

  /* -------------------- Gallery callbacks -------------------- */

  function handleCreate() {
    setView({ mode: "picker" });
  }

  function handleEdit(graph: GraphWithDeal) {
    // Reuse the same label shape DealPicker builds so the Builder subheader
    // is consistent between create and edit flows.
    const company = graph.deal.target ?? "";
    const project = graph.deal.projectName ?? "";
    const dealLabel =
      company && project && company !== project
        ? `${company} · ${project}`
        : company || project || "Untitled deal";
    setView({
      mode: "builder",
      dealId: graph.dealId,
      dealLabel,
      editing: graph,
    });
  }

  function handleDeleteRequest(graph: GraphWithDeal) {
    setDeleteTarget(graph);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    // Optimistic remove — restore on failure so the user can retry.
    graphsQuery.mutate((gs) => (gs ?? []).filter((g) => g.id !== target.id));
    setDeleteTarget(null);
    try {
      await api.delete(`/graphs/${target.id}`);
      showToast(`Deleted "${target.title}"`, "success");
    } catch (err) {
      console.warn("[graphs] delete failed:", err);
      // Refetch instead of restoring inline — fewer footguns if the failure
      // happened *after* the server-side delete.
      const message =
        err instanceof Error ? err.message : "Failed to delete graph";
      showToast(message, "error", { title: "Delete failed" });
      loadGraphs();
    }
  }

  /* -------------------- Picker callbacks -------------------- */

  function handlePickerSelect(deal: PickableDeal) {
    setView({
      mode: "builder",
      dealId: deal.id,
      dealLabel: deal.label,
      editing: null,
    });
  }

  /* -------------------- Builder callbacks -------------------- */

  function handleSaved(saved: Graph) {
    const wasEditing = view.mode === "builder" ? view.editing : null;
    // Merge the saved row back into the gallery state so the user sees their
    // change without a full refetch. The list endpoint embeds `deal`; on
    // create we synthesise it from the deal label we already had on screen.
    graphsQuery.mutate((gs) => {
      const prev = gs ?? [];
      if (wasEditing) {
        return prev.map((g) =>
          g.id === saved.id ? { ...g, ...saved, deal: g.deal } : g,
        );
      }
      const dealCtx = view.mode === "builder"
        ? { id: view.dealId, target: view.dealLabel.split(" · ")[0] || null, projectName: null }
        : { id: saved.dealId, target: null, projectName: null };
      const withDeal: GraphWithDeal = { ...saved, deal: { ...dealCtx, id: saved.dealId } };
      return [withDeal, ...prev];
    });
    showToast(wasEditing ? "Graph updated" : "Graph saved", "success");
    setView({ mode: "gallery" });
    // Refetch in the background to pick up the canonical `deal` summary the
    // backend resolves (joined `target` / `projectName`). The optimistic row
    // above keeps the UI fast; this just reconciles drift.
    loadGraphs();
  }

  /* -------------------- Render -------------------- */

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 text-slate-900">
      {view.mode === "builder" ? (
        <Builder
          dealId={view.dealId}
          dealLabel={view.dealLabel}
          initial={view.editing}
          onCancel={() => setView({ mode: "gallery" })}
          onSaved={handleSaved}
        />
      ) : (
        <Gallery
          graphs={graphs}
          loading={loading}
          error={error}
          onCreate={handleCreate}
          onEdit={handleEdit}
          onDelete={handleDeleteRequest}
          onDismissError={() => setActionError(null)}
        />
      )}

      <DealPicker
        open={view.mode === "picker"}
        onCancel={() => setView({ mode: "gallery" })}
        onSelect={handlePickerSelect}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete graph?"
        message={
          deleteTarget
            ? `"${deleteTarget.title}" will be removed from your library. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
