"use client";

// Dashboard — "morning brief". Main column answers "what needs me today?"
// (Today queue → Pipeline → Active Priorities); the right rail holds context
// (My Tasks, sector mix, inbox finder, optional widgets). Spec:
// docs/superpowers/specs/2026-09-27-dashboard-morning-brief-design.md

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@/providers/UserProvider";
import { useToast } from "@/providers/ToastProvider";
import { useIngestDealModal } from "@/providers/IngestDealModalProvider";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import { cn } from "@/lib/cn";
import { WelcomeModal } from "@/components/onboarding/WelcomeModal";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import type { Deal, Task } from "./components";
import { AiDealSignalsWidget, type InboxScanResult } from "./dashboard-widgets";
import { CustomizeDashboardModal } from "./widgets/customize-modal";
import { DraggableWidget } from "./widgets/draggable-widget";
import { useVisibleWidgets } from "./widgets/useVisibleWidgets";
import type { WidgetId, CoreWidgetId } from "./widgets/registry";
import { useDashboardData, type TeamMember } from "./use-dashboard-data";
import { useNow } from "./use-now";
import { UndoBar, useUndoBar } from "@/components/dash/undo-bar";
import { Masthead } from "./masthead";
import { TodayQueue } from "./today-queue";
import { PipelineFunnel } from "./pipeline-funnel";
import { PrioritiesTable } from "./priorities-table";
import { TasksRail } from "./tasks-rail";
import { SectorMix } from "./sector-mix";
import { DealsDrawer, type DrawerContent } from "./deals-drawer";
import { buildTodayQueue, isLiveDeal, nextUpcomingTask, SNOOZE_DAYS, type QueueItem } from "./triage";
import "@/components/dash/dash.css";

// Drop a persisted inbox scan older than this — candidates reference live Gmail
// emails, so a stale result isn't worth re-surfacing on the next visit.
const INBOX_SCAN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Core widgets that live in the right rail (reorderable in edit mode).
const RAIL_CORE: CoreWidgetId[] = ["my-tasks", "portfolio-allocation", "ai-deal-signals"];

export default function DashboardPage() {
  const { user } = useUser();
  const { showToast } = useToast();
  const { openDealIntake } = useIngestDealModal();
  const data = useDashboardData();
  const now = useNow();
  const undo = useUndoBar();

  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const [draggingCore, setDraggingCore] = useState<CoreWidgetId | null>(null);
  const draggingCoreRef = useRef<CoreWidgetId | null>(null);
  const { visible, coreVisible, toggle, toggleCore, orderedVisible, reorder, orderedCoreIds, reorderCore } = useVisibleWidgets();

  // Inbox Deal Finder state is lifted here so found candidates persist across
  // remounts and navigation (re-hydrated from localStorage).
  const [scanning, setScanning] = useState(false);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [signalResult, setSignalResult] = useState<InboxScanResult | null>(() => {
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

  useEffect(() => {
    try {
      if (signalResult?.connected && signalResult.candidates.length > 0) {
        window.localStorage.setItem(STORAGE_KEYS.inboxScanResult, JSON.stringify({ savedAt: Date.now(), result: signalResult }));
      } else {
        window.localStorage.removeItem(STORAGE_KEYS.inboxScanResult);
      }
    } catch (err) {
      console.warn("[dashboard] failed to persist inbox scan result:", err);
    }
  }, [signalResult]);

  // -------------------------------------------------------------------------
  // Edit mode (rail reordering)
  // -------------------------------------------------------------------------
  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setDraggingCore(null);
    draggingCoreRef.current = null;
    showToast("Your dashboard layout has been saved.", "success", { title: "Layout saved" });
  }, [showToast]);

  const toggleEditMode = useCallback(() => {
    if (isEditing) exitEditMode();
    else setIsEditing(true);
  }, [isEditing, exitEditMode]);

  useEffect(() => {
    if (!isEditing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") exitEditMode(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isEditing, exitEditMode]);

  const onCoreDragEnter = useCallback((targetId: CoreWidgetId) => {
    const sourceId = draggingCoreRef.current;
    if (!sourceId || sourceId === targetId) return;
    const ids = [...orderedCoreIds];
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    reorderCore(ids);
  }, [orderedCoreIds, reorderCore]);

  // -------------------------------------------------------------------------
  // Actions — optimistic, with undo where it's meaningful
  // -------------------------------------------------------------------------
  const { setTaskStatus, snooze, unsnooze, assignOwner, addTask } = data;
  const { show: showNotice } = undo;

  const toggleTask = useCallback(async (task: Task) => {
    const previous = task.status;
    const next = previous === "COMPLETED" ? "PENDING" : "COMPLETED";
    try {
      await setTaskStatus(task.id, next);
      showNotice({
        message: next === "COMPLETED" ? `Done: ${task.title}` : `Reopened: ${task.title}`,
        undo: () => { setTaskStatus(task.id, previous).catch((err) => console.warn("[dashboard] undo failed:", err)); },
      });
    } catch (err) {
      console.warn("[dashboard] task update failed:", err);
      showNotice({ message: "Couldn't update that task. Please try again.", tone: "error" });
    }
  }, [setTaskStatus, showNotice]);

  const snoozeItem = useCallback((item: QueueItem) => {
    const days = SNOOZE_DAYS[item.kind];
    snooze(item.key, days);
    showNotice({
      message: days === 1 ? "Snoozed until tomorrow" : "Snoozed for a week",
      undo: () => unsnooze(item.key),
    });
  }, [snooze, unsnooze, showNotice]);

  const assign = useCallback(async (deal: Deal, member: TeamMember) => {
    try {
      await assignOwner(deal.id, member);
      showNotice({ message: `${member.name || member.email} now owns ${deal.name}` });
    } catch (err) {
      console.warn("[dashboard] assign failed:", err);
      showNotice({ message: `Couldn't assign ${deal.name}. Please try again.`, tone: "error" });
    }
  }, [assignOwner, showNotice]);

  const userId = user?.id;
  const createTask = useCallback(async (input: { title: string; dueDate?: string }) => {
    try {
      await addTask({ ...input, assignedTo: userId });
    } catch (err) {
      console.warn("[dashboard] add task failed:", err);
      // Show the API's reason (e.g. a permission message) instead of a generic line.
      const reason = err instanceof Error && err.message ? ` ${err.message}` : "";
      showNotice({ message: `Couldn't add that task.${reason} Your text is still in the box.`, tone: "error" });
      throw err;
    }
  }, [addTask, userId, showNotice]);

  const closeDrawer = useCallback(() => setDrawer(null), []);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const queue = buildTodayQueue(data.deals, data.tasks, { userId: user?.id, now, snoozes: data.snoozes });
  const liveDeals = data.deals.filter(isLiveDeal);
  const inDiligence = liveDeals.filter((d) => d.stage === "DUE_DILIGENCE").length;
  const firstName = user?.name?.split(" ")[0] || "there";

  const railCore = orderedCoreIds.filter((id) => RAIL_CORE.includes(id) && coreVisible.has(id));

  const renderRailCore = (id: CoreWidgetId) => {
    if (id === "my-tasks") {
      return (
        <TasksRail
          tasks={data.tasks}
          userId={user?.id}
          loading={data.loading}
          error={data.tasksError}
          now={now}
          onRetry={data.refresh}
          onToggle={toggleTask}
          onAdd={createTask}
        />
      );
    }
    if (id === "portfolio-allocation") {
      return (
        <SectorMix
          deals={data.deals}
          loading={data.loading}
          onOpenSector={(g) => setDrawer({ eyebrow: "Sector", title: g.label, deals: g.deals })}
        />
      );
    }
    return (
      <AiDealSignalsWidget
        scanning={scanning}
        signalResult={signalResult}
        signalError={signalError}
        setScanning={setScanning}
        setSignalResult={setSignalResult}
        setSignalError={setSignalError}
      />
    );
  };

  return (
    <div className="dash px-4 py-6 md:px-8 md:py-9 lg:px-10">
      <WelcomeModal />
      <div className="dash-reveal mx-auto flex w-full max-w-[1480px] flex-col gap-7">
        <Masthead
          firstName={firstName}
          loading={data.loading}
          needsYou={queue.length}
          liveDeals={liveDeals.length}
          inDiligence={inDiligence}
          lastUpdated={data.lastUpdated}
          refreshing={data.refreshing && !data.loading}
          now={now}
          isEditing={isEditing}
          onRefresh={data.refresh}
          onNewDeal={() => openDealIntake()}
          onAddWidget={() => setCustomizeOpen(true)}
          onToggleEdit={toggleEditMode}
        />

        <OnboardingChecklist />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
          {/* Main column — the brief */}
          <div className="flex min-w-0 flex-col gap-6">
            <TodayQueue
              items={queue}
              loading={data.loading}
              error={data.dealsError && data.tasksError}
              now={now}
              nextTask={nextUpcomingTask(data.tasks, user?.id, now)}
              onRetry={data.refresh}
              onComplete={toggleTask}
              onSnooze={snoozeItem}
              onAssign={assign}
              loadTeam={data.loadTeam}
            />
            {coreVisible.has("stats-cards") && (
              <PipelineFunnel
                deals={data.deals}
                loading={data.loading}
                error={data.dealsError}
                now={now}
                onRetry={data.refresh}
                onOpenStage={(bucket, deals) => setDrawer({ eyebrow: "Pipeline stage", title: bucket.label, deals })}
              />
            )}
            {coreVisible.has("active-priorities") && (
              <PrioritiesTable deals={data.deals} loading={data.loading} error={data.dealsError} now={now} onRetry={data.refresh} />
            )}
          </div>

          {/* Right rail — context */}
          <aside aria-label="Tasks and context" className="grid min-w-0 items-start gap-6 md:grid-cols-2 xl:grid-cols-1">
            {isEditing && (
              <p className="flex items-center gap-2 rounded-lg border border-dashed border-(--dash-blue-3) bg-(--dash-wash) px-4 py-3 text-sm text-(--dash-ink-2) md:col-span-2 xl:col-span-1">
                <span className="material-symbols-outlined text-[18px] text-(--dash-blue)">drag_indicator</span>
                Drag panels to reorder. Press Esc when you&apos;re done.
              </p>
            )}
            {railCore.map((id) => (
              <div
                key={id}
                data-widget={id}
                draggable={isEditing}
                onDragStart={(e) => {
                  if (!isEditing) return;
                  e.dataTransfer.effectAllowed = "move";
                  try { e.dataTransfer.setData("text/plain", id); } catch (err) {
                    console.warn("[dashboard] dataTransfer.setData failed for core widget:", err);
                  }
                  setDraggingCore(id);
                  draggingCoreRef.current = id;
                }}
                onDragOver={(e) => {
                  if (!isEditing || !draggingCoreRef.current || draggingCoreRef.current === id) return;
                  e.preventDefault();
                  onCoreDragEnter(id);
                }}
                onDrop={(e) => { if (isEditing) e.preventDefault(); }}
                onDragEnd={() => { setDraggingCore(null); draggingCoreRef.current = null; }}
                className={cn(
                  "relative min-w-0 transition-opacity",
                  isEditing && "cursor-grab rounded-lg outline-1 outline-offset-4 outline-dashed outline-(--dash-blue-3)",
                  draggingCore === id && "opacity-50",
                )}
              >
                {renderRailCore(id)}
              </div>
            ))}
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
                  ids.splice(from, 1);
                  ids.splice(to, 0, dragging);
                  reorder(ids);
                }}
                onDragEnd={() => setDragging(null)}
              >
                <w.Component />
              </DraggableWidget>
            ))}
          </aside>
        </div>
      </div>

      <DealsDrawer content={drawer} now={now} onClose={closeDrawer} />
      <UndoBar notice={undo.notice} onDismiss={undo.dismiss} />

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
    </div>
  );
}
