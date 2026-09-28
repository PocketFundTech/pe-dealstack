"use client";

// Command Center — "team ledger". Main column: what's slipping across the
// team → who's carrying what → every task. Rail: security posture, upcoming
// reviews, team activity. Actions open pre-filled in a side sheet.

import { useCallback, useMemo, useState } from "react";
import { useUser } from "@/providers/UserProvider";
import { useApiQuery } from "@/lib/useApiQuery";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/Skeleton";
import { UndoBar, useUndoBar } from "@/components/dash/undo-bar";
import { useNow } from "../dashboard/use-now";
import { AdminMasthead } from "./admin-masthead";
import { SlippingList } from "./slipping-list";
import { TeamWorkload } from "./team-workload";
import { TaskTable } from "./TaskTable";
import { SecurityStrip } from "./security-strip";
import { UpcomingReviews } from "./UpcomingReviews";
import { ActivityFeed } from "./ActivityFeed";
import { AssignDealModal, CreateTaskModal, ScheduleReviewModal, SendReminderModal } from "./modals";
import { isLive, isOverdue, slipping, workload } from "./admin-logic";
import type { ActionPrefill } from "./form-primitives";
import type { FilterValue } from "./TaskTable.helpers";
import type { AdminDeal, AdminTask, AdminTeamMember } from "./types";
import "@/components/dash/dash.css";

// Roles that can see the Command Center (VIEWER / MEMBER are blocked); only
// ADMIN can assign deals and create tasks.
const ADMIN_VISIBLE_ROLES = new Set(["ADMIN", "PARTNER", "PRINCIPAL"]);
const ADMIN_MANAGEMENT_ROLE = "ADMIN";

type ActionKind = "assign" | "task" | "review" | "reminder";

export default function AdminPage() {
  const { user } = useUser();
  const now = useNow();
  const undo = useUndoBar();
  const [action, setAction] = useState<{ kind: ActionKind; prefill?: ActionPrefill } | null>(null);
  const [taskFilter, setTaskFilter] = useState<{ value: FilterValue; nonce: number }>();
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());

  const role = (user?.systemRole || user?.role || "").toUpperCase();
  const canManage = role === ADMIN_MANAGEMENT_ROLE;
  const canView = ADMIN_VISIBLE_ROLES.has(role);

  // Stale-while-revalidate cache: returning to /admin renders instantly.
  const enabled = !!user && canView;
  const teamQuery = useApiQuery<AdminTeamMember[] | { users: AdminTeamMember[] }>("/users?isActive=true", { enabled });
  const dealsQuery = useApiQuery<AdminDeal[] | { deals: AdminDeal[] }>("/deals", { enabled });
  const tasksQuery = useApiQuery<{ tasks: AdminTask[] }>("/tasks?limit=100", { enabled });

  const team = useMemo<AdminTeamMember[]>(() => {
    const v = teamQuery.data;
    return v === undefined ? [] : Array.isArray(v) ? v : v.users || [];
  }, [teamQuery.data]);
  const deals = useMemo<AdminDeal[]>(() => {
    const v = dealsQuery.data;
    return v === undefined ? [] : Array.isArray(v) ? v : v.deals || [];
  }, [dealsQuery.data]);
  const tasks = useMemo<AdminTask[]>(() => tasksQuery.data?.tasks || [], [tasksQuery.data]);

  const loading = !user || teamQuery.isLoading || dealsQuery.isLoading || tasksQuery.isLoading;
  const refreshing = teamQuery.isValidating || dealsQuery.isValidating || tasksQuery.isValidating;

  const { refetch: refetchTeam } = teamQuery;
  const { refetch: refetchDeals } = dealsQuery;
  const { refetch: refetchTasks } = tasksQuery;
  const refresh = useCallback(() => {
    setLastUpdated(Date.now());
    return Promise.allSettled([refetchTeam(), refetchDeals(), refetchTasks()]);
  }, [refetchTeam, refetchDeals, refetchTasks]);

  const { show } = undo;
  const notice = useCallback(
    (message: string, tone: "neutral" | "error" = "neutral", onUndo?: () => void) => show({ message, tone, undo: onUndo }),
    [show],
  );
  // Adapter for the action forms, which report success/error toasts.
  const onToast = useCallback((message: string, type: "success" | "error") => notice(message, type === "error" ? "error" : "neutral"), [notice]);

  const reassign = useCallback(async (task: AdminTask, member: AdminTeamMember) => {
    const previous = task.assignedTo ?? null;
    try {
      await api.patch(`/tasks/${task.id}`, { assignedTo: member.id });
      refresh();
      notice(`${member.name || member.email} now owns “${task.title}”`, "neutral", async () => {
        try {
          await api.patch(`/tasks/${task.id}`, { assignedTo: previous });
          refresh();
        } catch (err) {
          console.warn("[admin] undo reassign failed:", err);
        }
      });
    } catch (err) {
      console.warn("[admin] reassign failed:", err);
      notice("Couldn't reassign that task. Please try again.", "error");
    }
  }, [refresh, notice]);

  const closeAction = useCallback(() => setAction(null), []);
  const openAction = (kind: ActionKind, prefill?: ActionPrefill) => setAction({ kind, prefill });

  // ─── Access gate ──────────────────────────────────────────────────
  if (user && !canView) {
    return (
      <div className="dash flex items-center justify-center px-4 py-24">
        <div className="max-w-sm text-center">
          <span className="material-symbols-outlined text-[32px] text-(--dash-ink-3)">lock</span>
          <h1 className="dash-display mt-2 text-xl text-(--dash-ink)">Command Center is for admins and partners</h1>
          <p className="mt-1 text-sm text-(--dash-ink-2)">Ask a workspace admin if you need team-wide visibility.</p>
        </div>
      </div>
    );
  }

  if (loading) return <CommandCenterSkeleton />;

  // ─── Derived ──────────────────────────────────────────────────────
  const rows = workload(team, deals, tasks, now);
  const slip = slipping(deals, tasks, now);
  const overdueCount = tasks.filter((t) => isOverdue(t, now)).length;
  const unownedCount = slip.filter((s) => s.kind === "unowned").length;

  const jump = (target: "team" | "tasks-overdue" | "slipping") => {
    if (target === "tasks-overdue") setTaskFilter({ value: "OVERDUE", nonce: Date.now() });
    const id = target === "tasks-overdue" ? "tasks" : target;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const shared = { deals, users: team, onToast, onClose: closeAction, prefill: action?.prefill };

  return (
    <div className="dash px-4 py-6 md:px-8 md:py-9 lg:px-10">
      <div className="dash-reveal mx-auto flex w-full max-w-[1480px] flex-col gap-7">
        <AdminMasthead
          now={now}
          people={team.length}
          liveDeals={deals.filter(isLive).length}
          overdue={overdueCount}
          unowned={unownedCount}
          slipping={slip.length}
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          canManage={canManage}
          onRefresh={refresh}
          onJump={jump}
          onNew={(kind) => openAction(kind)}
        />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="flex min-w-0 flex-col gap-6">
            <SlippingList items={slip} members={team} canManage={canManage} onOpenAction={openAction} onReassign={reassign} />
            <TeamWorkload rows={rows} canManage={canManage} onOpenAction={openAction} />
            <TaskTable tasks={tasks} now={now} externalFilter={taskFilter} onTasksChanged={refresh} onNotice={notice} />
          </div>
          <aside aria-label="Security, reviews and activity" className="grid min-w-0 items-start gap-6 md:grid-cols-2 xl:grid-cols-1">
            <SecurityStrip />
            <UpcomingReviews tasks={tasks} now={now} onScheduleClick={() => openAction("review")} />
            <div className="md:col-span-2 xl:col-span-1"><ActivityFeed /></div>
          </aside>
        </div>
      </div>

      <AssignDealModal {...shared} open={action?.kind === "assign"} onAssigned={refresh} />
      <CreateTaskModal {...shared} open={action?.kind === "task"} onCreated={refresh} />
      <ScheduleReviewModal {...shared} open={action?.kind === "review"} onScheduled={refresh} />
      <SendReminderModal {...shared} open={action?.kind === "reminder"} />
      <UndoBar notice={undo.notice} onDismiss={undo.dismiss} />
    </div>
  );
}

function CommandCenterSkeleton() {
  const panel = "dash-panel overflow-hidden";
  return (
    <div className="dash px-4 py-6 md:px-8 md:py-9 lg:px-10" aria-busy="true" aria-label="Loading Command Center">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-7">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <Skeleton.Line width={170} height={10} />
            <Skeleton.Line width={260} height={30} />
            <Skeleton.Line width={380} height={14} />
          </div>
          <div className="dash-double-rule" />
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="flex flex-col gap-6">
            {[3, 5, 5].map((n, p) => (
              <div key={p} className={panel}>
                <div className="px-6 pt-5 pb-3.5"><Skeleton.Line width={130} height={18} /></div>
                {Array.from({ length: n }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 border-t border-(--dash-rule) px-6 py-3.5">
                    <Skeleton.Circle size={28} />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton.Line width={`${55 - i * 6}%`} height={13} />
                      <Skeleton.Line width="30%" height={10} />
                    </div>
                    <Skeleton width={72} height={24} rounded="md" />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-1">
            {[4, 3, 5].map((n, p) => (
              <div key={p} className={panel}>
                <div className="border-b border-(--dash-rule) px-5 pt-4 pb-3"><Skeleton.Line width={110} height={16} /></div>
                <div className="flex flex-col gap-3 px-5 py-4">
                  {Array.from({ length: n }).map((_, i) => <Skeleton.Line key={i} width={`${85 - i * 10}%`} height={12} />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
