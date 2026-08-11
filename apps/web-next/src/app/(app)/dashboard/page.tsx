"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useUser } from "@/providers/UserProvider";
import { api } from "@/lib/api";
import { onDealsChanged } from "@/lib/appEvents";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { cn } from "@/lib/cn";
import { WelcomeModal } from "@/components/onboarding/WelcomeModal";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import {
  Deal,
  Task,
  SOURCING_STAGES,
  DD_STAGES,
  LOI_STAGES,
  CLOSED_STAGES,
  SECTOR_COLORS,
  getGreeting,
  StatCards,
  StageDetailModal,
  PortfolioAllocation,
} from "./components";
import { TasksModal } from "./dashboard-modals";
import { ActivePrioritiesWidget, MyTasksWidget, AiDealSignalsWidget, type InboxScanResult } from "./dashboard-widgets";
import { CustomizeDashboardModal } from "./widgets/customize-modal";
import { DraggableWidget } from "./widgets/draggable-widget";
import { useVisibleWidgets } from "./widgets/useVisibleWidgets";
import { useToast } from "@/providers/ToastProvider";
import type { WidgetId, CoreWidgetId } from "./widgets/registry";

// Drop a persisted inbox scan older than this — candidates reference live Gmail
// emails, so a stale result isn't worth re-surfacing on the next visit.
const INBOX_SCAN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export default function DashboardPage() {
  const { user } = useUser();
  const { showToast } = useToast();
  const [allDeals, setAllDeals] = useState<Deal[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [signalResult, setSignalResult] = useState<InboxScanResult | null>(() => {
    // Re-hydrate the last scan so found candidates persist across remounts and
    // navigation instead of resetting to the empty prompt. Ignore results past
    // the max age since they reference live emails.
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.inboxScanResult);
      if (!raw) return null;
      const env = JSON.parse(raw) as { savedAt?: number; result?: InboxScanResult };
      if (!env?.result || !env.savedAt) return null;
      if (Date.now() - env.savedAt > INBOX_SCAN_MAX_AGE_MS) return null;
      return env.result;
    } catch {
      return null;
    }
  });
  const [stageModal, setStageModal] = useState<{ label: string; stages: string[] } | null>(null);
  const [tasksModalOpen, setTasksModalOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const [draggingCore, setDraggingCore] = useState<CoreWidgetId | null>(null);
  const draggingCoreRef = useRef<CoreWidgetId | null>(null);
  const { visible, coreVisible, toggle, toggleCore, orderedVisible, reorder, orderedCoreIds, reorderCore } = useVisibleWidgets();

  // -----------------------------------------------------------------------
  // Edit mode helpers
  // -----------------------------------------------------------------------
  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setDraggingCore(null);
    draggingCoreRef.current = null;
    showToast("Your dashboard layout has been saved.", "success", { title: "Layout Saved" });
  }, [showToast]);

  const toggleEditMode = useCallback(() => {
    if (isEditing) {
      exitEditMode();
    } else {
      setIsEditing(true);
    }
  }, [isEditing, exitEditMode]);

  // Core widget drag handlers for edit mode
  const onCoreDragStart = useCallback((id: CoreWidgetId) => {
    setDraggingCore(id);
    draggingCoreRef.current = id;
  }, []);

  const onCoreDragEnter = useCallback((targetId: CoreWidgetId) => {
    const sourceId = draggingCoreRef.current;
    if (!sourceId || sourceId === targetId) return;
    const ids = [...orderedCoreIds];
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, sourceId);
    reorderCore(next);
  }, [orderedCoreIds, reorderCore]);

  const onCoreDragEnd = useCallback(() => {
    setDraggingCore(null);
    draggingCoreRef.current = null;
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const [dealsRes, tasksRes] = await Promise.allSettled([
        api.get<Deal[] | { deals: Deal[] }>("/deals?limit=100&sortBy=updatedAt&sortOrder=desc"),
        api.get<{ tasks: Task[] } | Task[]>("/tasks?limit=20"),
      ]);
      if (dealsRes.status === "fulfilled") {
        // API returns plain array; handle both formats for safety
        const rawDeals = Array.isArray(dealsRes.value)
          ? dealsRes.value
          : (dealsRes.value as { deals: Deal[] }).deals || [];
        setAllDeals(rawDeals);
        // Active Priorities: filter active, sort by priority (HIGH first) — matches legacy loadActivePriorities
        const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        const activeForPriorities = rawDeals
          .filter((d) => d.status !== "ARCHIVED" && d.status !== "PASSED")
          .sort((a, b) => (PRIORITY_ORDER[a.priority || ""] ?? 99) - (PRIORITY_ORDER[b.priority || ""] ?? 99))
          .slice(0, 5);
        setDeals(activeForPriorities);
      } else {
        console.warn("[dashboard] failed to load deals:", dealsRes.reason);
      }
      if (tasksRes.status === "fulfilled") {
        const t = tasksRes.value;
        setTasks(Array.isArray(t) ? t : t.tasks || []);
      } else {
        console.warn("[dashboard] failed to load tasks:", tasksRes.reason);
      }
    } catch (err) {
      console.warn("[dashboard] load error:", err);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // Refresh when a deal is ingested/updated elsewhere (e.g. a Google Drive
  // import via the ingest modal) so stats + priorities stay current without a
  // manual reload. loadDashboard never re-shows the skeleton, so this is silent.
  useEffect(() => {
    const off = onDealsChanged(() => loadDashboard());
    return () => off();
  }, [loadDashboard]);

  // Persist the scan result (only while it still has candidates worth keeping)
  // so the Inbox Deal Finder re-shows them after the modal is closed or the page
  // is revisited, instead of falling back to the empty prompt.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (signalResult?.connected && signalResult.candidates.length > 0) {
        window.localStorage.setItem(
          STORAGE_KEYS.inboxScanResult,
          JSON.stringify({ savedAt: Date.now(), result: signalResult }),
        );
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.inboxScanResult);
      }
    } catch (err) {
      console.warn("[dashboard] failed to persist inbox scan result:", err);
    }
  }, [signalResult]);

  // Esc exits layout edit mode — mirrors onKeyDown in layout-editor.js
  useEffect(() => {
    if (!isEditing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitEditMode();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isEditing, exitEditMode]);

  const [taskError, setTaskError] = useState<string | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);

  const toggleTask = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === "COMPLETED" ? "PENDING" : "COMPLETED";
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
    try {
      await api.patch(`/tasks/${taskId}`, { status: newStatus });
    } catch (err) {
      console.warn("[dashboard] toggleTask failed:", err);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: currentStatus } : t)));
      setTaskError("Couldn't update task — please try again.");
      setTimeout(() => setTaskError(null), 3500);
    }
  };

  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const activeDeals = allDeals.filter((d) => d.status !== "ARCHIVED");
  const activeTotal = Math.max(activeDeals.length, 1);
  const sourcingCount = activeDeals.filter((d) => SOURCING_STAGES.includes(d.stage)).length;
  const ddCount = activeDeals.filter((d) => DD_STAGES.includes(d.stage)).length;
  const loiCount = activeDeals.filter((d) => LOI_STAGES.includes(d.stage)).length;
  const closedCount = activeDeals.filter((d) => CLOSED_STAGES.includes(d.stage)).length;
  const closedTotal = activeDeals
    .filter((d) => CLOSED_STAGES.includes(d.stage))
    .reduce((sum, d) => sum + (d.dealSize || 0), 0);
  const pct = (n: number) => Math.round((n / activeTotal) * 100);
  const pendingTasks = tasks.filter((t) => t.status !== "COMPLETED");
  const firstName = user?.name?.split(" ")[0] || "there";

  // Portfolio allocation: group active deals by industry, take top 4, rest -> "Others"
  const industryCounts = activeDeals.reduce<Record<string, number>>((acc, d) => {
    const key = (d.industry?.trim() || "Uncategorized");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const sortedSectors = Object.entries(industryCounts).sort((a, b) => b[1] - a[1]);
  const topSectors = sortedSectors.slice(0, 4);
  const othersCount = sortedSectors.slice(4).reduce((sum, [, c]) => sum + c, 0);
  if (othersCount > 0) topSectors.push(["Others", othersCount]);
  const sectorTotal = topSectors.reduce((sum, [, c]) => sum + c, 0);
  const allocation = topSectors.map(([label, count], i) => ({
    label,
    count,
    pct: sectorTotal > 0 ? Math.round((count / sectorTotal) * 100) : 0,
    color: SECTOR_COLORS[i] || SECTOR_COLORS[SECTOR_COLORS.length - 1],
  }));
  let cumPct = 0;
  const gradientParts = allocation.map((a) => {
    const start = cumPct;
    cumPct += a.pct;
    return `${a.color} ${start}% ${cumPct}%`;
  });

  // Helper: wraps a core widget in edit-mode decoration (dashed border, drag handle)
  const wrapCoreWidget = (coreId: CoreWidgetId, content: React.ReactNode, extraClass?: string) => {
    const isDragged = draggingCore === coreId;
    return (
      <div
        key={coreId}
        data-widget={coreId}
        draggable={isEditing}
        onDragStart={(e) => {
          if (!isEditing) return;
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", coreId);
          } catch (err) {
            // Firefox quirk — drag-and-drop still works without setData.
            console.warn("[dashboard] dataTransfer.setData failed for core widget:", err);
          }
          onCoreDragStart(coreId);
        }}
        onDragOver={(e) => {
          if (!isEditing || !draggingCoreRef.current || draggingCoreRef.current === coreId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onCoreDragEnter(coreId);
        }}
        onDrop={(e) => { if (isEditing) e.preventDefault(); }}
        onDragEnd={() => { if (isEditing) onCoreDragEnd(); }}
        className={cn(
          "relative transition-opacity",
          extraClass,
          isEditing && "outline-2 outline-dashed outline-offset-2 outline-[#003366] rounded-lg",
          isDragged && "opacity-50",
        )}
      >
        {isEditing && (
          <span
            className="material-symbols-outlined cursor-grab active:cursor-grabbing absolute top-2 right-2 z-20 bg-white text-[#003366] rounded-md p-1 shadow-md text-[18px]"
            title="Drag to reorder"
          >
            drag_indicator
          </span>
        )}
        {content}
      </div>
    );
  };

  return (
    <div className="p-4 md:p-6">
      <WelcomeModal />
      <div className="mx-auto max-w-[1600px] w-full flex flex-col gap-6">
        {/* Welcome */}
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">
            {getGreeting()}, {firstName}
          </h1>
          <p className="text-text-secondary text-sm">
            Here is your deal flow update and AI market analysis for{" "}
            <span className="font-medium text-primary">{today}</span>.
          </p>
        </div>

        {/* Onboarding Checklist */}
        <OnboardingChecklist />

        {/* Edit-mode banner — matches #layout-edit-banner in
            layout-editor.js. Shown at top of widgets. */}
        {isEditing && (
          <div
            className="flex items-center gap-2.5 px-5 py-2.5 rounded-lg text-white text-[13px] font-semibold shadow-md"
            style={{ background: "linear-gradient(90deg, #003366 0%, #004488 100%)", boxShadow: "0 2px 8px rgba(0, 51, 102, 0.2)" }}
          >
            <span className="material-symbols-outlined text-[18px]">drag_indicator</span>
            <span className="flex-1">
              Drag widgets by the handle to reorder &middot; Click <strong>Done</strong> when finished
            </span>
            <button
              type="button"
              onClick={exitEditMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold bg-white/20 hover:bg-white/30 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">check</span>
              Done
            </button>
          </div>
        )}

        {/* Stats Cards — always rendered above the grid (full-width) */}
        {coreVisible.has("stats-cards") && wrapCoreWidget(
          "stats-cards",
          <StatCards
            loading={loading}
            sourcingCount={sourcingCount}
            ddCount={ddCount}
            loiCount={loiCount}
            closedCount={closedCount}
            closedTotal={closedTotal}
            pct={pct}
            onStageClick={setStageModal}
          />,
        )}

        {/* Active Priorities — rendered as a full-width hero row above the
             masonry. CSS multi-column layout below can't honour col-span-full,
             so this widget lives outside the column flow. Drag-and-drop
             reordering still works because it swaps array indices in
             orderedCoreIds; the visual layout is independent.
             Order is driven by orderedCoreIds from useVisibleWidgets. */}
        {orderedCoreIds
          .filter((id) => id === "active-priorities" && coreVisible.has(id))
          .map((coreId) => {
            if (coreId === "active-priorities") {
              return wrapCoreWidget(
                "active-priorities",
                <ActivePrioritiesWidget deals={deals} loading={loading} />,
              );
            }
            return null;
          })}

        {/* Remaining core widgets — CSS multi-column masonry. Each widget
             flows into the next available column slot, so a tall widget in
             column 1 doesn't force columns 2 & 3 to leave empty whitespace
             below their content. `break-inside-avoid` keeps each card in a
             single column. Drag-and-drop reorder still works: drop targets
             swap array positions in orderedCoreIds via onCoreDragEnter, the
             columns then re-flow to match. */}
        <div className="columns-1 md:columns-2 lg:columns-3 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
          {orderedCoreIds
            .filter((id) => id !== "stats-cards" && id !== "active-priorities" && coreVisible.has(id))
            .map((coreId) => {
              if (coreId === "my-tasks") {
                return wrapCoreWidget(
                  "my-tasks",
                  <MyTasksWidget
                    tasks={tasks}
                    pendingTasks={pendingTasks}
                    loading={loading}
                    taskError={taskError}
                    onToggleTask={toggleTask}
                    onOpenAllTasks={() => setTasksModalOpen(true)}
                  />,
                );
              }

              if (coreId === "portfolio-allocation") {
                return wrapCoreWidget(
                  "portfolio-allocation",
                  <PortfolioAllocation loading={loading} allocation={allocation} gradientParts={gradientParts} />,
                );
              }

              if (coreId === "ai-deal-signals") {
                return wrapCoreWidget(
                  "ai-deal-signals",
                  <AiDealSignalsWidget
                    scanning={scanning}
                    signalResult={signalResult}
                    signalError={signalError}
                    setScanning={setScanning}
                    setSignalResult={setSignalResult}
                    setSignalError={setSignalError}
                  />,
                );
              }

              return null;
            })}
        </div>{/* /dashboard-widget-grid */}

        {/* Optional widgets (user-customizable via Customize button below).
             Same CSS multi-column masonry approach as the core widgets above
             so short widgets don't leave dead vertical space below them. */}
        {orderedVisible.length > 0 && (
          <div className="columns-1 md:columns-2 lg:columns-3 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
            {orderedVisible.map((w) => (
              <DraggableWidget
                key={w.id}
                id={w.id}
                editing={isEditing}
                dragState={{ dragging }}
                onDragStart={setDragging}
                onDragEnter={(targetId) => {
                  if (!dragging || dragging === targetId) return;
                  const ids = orderedVisible.map((x) => x.id);
                  const from = ids.indexOf(dragging);
                  const to = ids.indexOf(targetId);
                  if (from === -1 || to === -1) return;
                  const next = [...ids];
                  next.splice(from, 1);
                  next.splice(to, 0, dragging);
                  reorder(next);
                }}
                onDragEnd={() => setDragging(null)}
              >
                <w.Component />
              </DraggableWidget>
            ))}
          </div>
        )}

        {/* Bottom action buttons — "Add Widget" opens the visibility picker
            modal, "Customize Dashboard" toggles inline edit mode matching
            legacy layout-editor.js behavior. */}
        <div className="flex flex-col sm:flex-row gap-3 mt-2">
          <button
            type="button"
            onClick={() => setCustomizeOpen(true)}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle p-4 text-text-muted hover:border-primary hover:text-primary hover:bg-primary-light/50 transition-all group bg-surface-card/50"
          >
            <span className="material-symbols-outlined group-hover:scale-110 transition-transform">add_circle</span>
            <span className="text-sm font-semibold">Add Widget</span>
          </button>
          <button
            type="button"
            onClick={toggleEditMode}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-lg border p-4 text-sm font-medium transition-all",
              isEditing
                ? "text-white border-transparent"
                : "text-text-muted border-border-subtle bg-surface-card/50 hover:border-primary hover:text-primary hover:bg-primary-light/50",
            )}
            style={isEditing ? { backgroundColor: "#003366" } : undefined}
          >
            <span className="material-symbols-outlined text-[18px]">
              {isEditing ? "check" : "tune"}
            </span>
            {isEditing ? "Done" : "Customize Dashboard"}
          </button>
        </div>
      </div>

      {/* Stage Detail Modal */}
      {stageModal && (
        <StageDetailModal stageModal={stageModal} deals={allDeals} onClose={() => setStageModal(null)} />
      )}

      <CustomizeDashboardModal
        open={customizeOpen}
        visible={visible}
        coreVisible={coreVisible}
        coreOrder={orderedCoreIds}
        onToggle={toggle}
        onToggleCore={toggleCore}
        onReorderCore={reorderCore}
        onClose={() => setCustomizeOpen(false)}
      />

      {tasksModalOpen && (
        <TasksModal tasks={tasks} onClose={() => setTasksModalOpen(false)} onToggle={toggleTask} />
      )}
    </div>
  );
}
