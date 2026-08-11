"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@/providers/UserProvider";
import { useApiQuery } from "@/lib/useApiQuery";
import { formatCurrency } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import { ResourceAllocation } from "./ResourceAllocation";
import { TaskTable } from "./TaskTable";
import { UpcomingReviews } from "./UpcomingReviews";
import { ActivityFeed } from "./ActivityFeed";
import { SecurityDashboard } from "./SecurityDashboard";
import {
  AssignDealModal,
  CreateTaskModal,
  ScheduleReviewModal,
  SendReminderModal,
} from "./modals";
import type { AdminDeal, AdminTask, AdminTeamMember } from "./types";

// Roles that can see the admin dashboard. Matches admin-dashboard.js RBAC gate
// (admin / partner / principal); VIEWER and MEMBER are blocked.
const ADMIN_VISIBLE_ROLES = new Set(["ADMIN", "PARTNER", "PRINCIPAL"]);

// Only ADMIN can create/assign (hide management modals for partners/principals).
const ADMIN_MANAGEMENT_ROLE = "ADMIN";

type OverdueFilter = "ALL" | "OVERDUE";

export default function AdminPage() {
  const { user } = useUser();
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [externalTaskFilter, setExternalTaskFilter] = useState<OverdueFilter | undefined>();
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [openModal, setOpenModal] = useState<
    "assign" | "task" | "review" | "reminder" | null
  >(null);

  const role = (user?.systemRole || user?.role || "").toUpperCase();
  const canManage = role === ADMIN_MANAGEMENT_ROLE;
  const canView = ADMIN_VISIBLE_ROLES.has(role);

  // Read-only dashboard data via the shared stale-while-revalidate cache, so
  // returning to /admin renders instantly from cache and revalidates in the
  // background instead of re-running the three fetches and showing a spinner.
  const enabled = !!user && canView;
  const teamQuery = useApiQuery<AdminTeamMember[] | { users: AdminTeamMember[] }>(
    "/users?isActive=true",
    { enabled },
  );
  const dealsQuery = useApiQuery<AdminDeal[] | { deals: AdminDeal[] }>("/deals", { enabled });
  const tasksQuery = useApiQuery<{ tasks: AdminTask[] }>("/tasks?limit=100", { enabled });

  const teamMembers = useMemo<AdminTeamMember[]>(() => {
    const v = teamQuery.data;
    return v === undefined ? [] : Array.isArray(v) ? v : v.users || [];
  }, [teamQuery.data]);
  const deals = useMemo<AdminDeal[]>(() => {
    const v = dealsQuery.data;
    return v === undefined ? [] : Array.isArray(v) ? v : v.deals || [];
  }, [dealsQuery.data]);
  const tasks = useMemo<AdminTask[]>(() => tasksQuery.data?.tasks || [], [tasksQuery.data]);

  // Spinner until the user is known and the first load of all three settles.
  const loading = !user || teamQuery.isLoading || dealsQuery.isLoading || tasksQuery.isLoading;

  const refresh = useCallback(() => {
    setLastUpdated(Date.now());
    return Promise.allSettled([
      teamQuery.refetch(),
      dealsQuery.refetch(),
      tasksQuery.refetch(),
    ]);
  }, [teamQuery, dealsQuery, tasksQuery]);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Tick "Last updated" label every minute for freshness
  useEffect(() => {
    const id = setInterval(() => setLastUpdated((v) => v), 60_000);
    return () => clearInterval(id);
  }, []);

  // ─── RBAC gate ────────────────────────────────────────────────────

  if (user && !canView) {
    return (
      <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex items-center justify-center py-20">
        <div className="text-center">
          <span className="material-symbols-outlined text-5xl text-red-400">lock</span>
          <h2 className="mt-3 text-lg font-bold text-text-main">Access Denied</h2>
          <p className="text-sm text-text-muted mt-1">
            You do not have permission to view the Command Center.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex items-center justify-center py-20">
        <div className="text-center text-text-muted">
          <span className="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
          <p className="mt-2 text-sm">Loading Command Center...</p>
        </div>
      </div>
    );
  }

  // ─── Derived stats ───────────────────────────────────────────────

  const now = new Date();
  const totalMembers = teamMembers.length;
  const activeMembers = teamMembers.filter((m) => m.isActive !== false);
  const totalVolume = deals.reduce((sum, d) => sum + (d.dealSize || 0), 0);
  const overdueTasks = tasks.filter(
    (t) => t.dueDate && new Date(t.dueDate) < now && t.status !== "COMPLETED",
  );
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const dueThisWeek = tasks.filter((t) => {
    if (!t.dueDate || t.status === "COMPLETED") return false;
    const d = new Date(t.dueDate);
    return d >= now && d <= weekFromNow;
  });
  const membersWithDeals = new Set<string>();
  deals.forEach((d) =>
    d.teamMembers?.forEach((tm) => {
      const uid = tm.user?.id || tm.userId;
      if (uid) membersWithDeals.add(uid);
    }),
  );
  const assignedCount = membersWithDeals.size;
  const utilization =
    totalMembers > 0 ? Math.min(100, Math.round((assignedCount / totalMembers) * 100)) : 0;

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const refreshAfterAction = () => {
    refresh();
  };

  return (
    <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex flex-col gap-6">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed top-4 right-4 z-[60] flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all border",
            toast.type === "success"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200",
          )}
        >
          <span className="material-symbols-outlined text-[18px]">
            {toast.type === "success" ? "check_circle" : "error"}
          </span>
          {toast.message}
        </div>
      )}

      {/* Command Center Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">
            Command Center
          </h1>
          <p className="text-text-secondary text-sm mt-1">
            Overview of team performance and active deal flow.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium bg-primary-light text-primary px-3 py-1.5 rounded-full flex items-center gap-1.5 border border-primary/20">
            <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />
            System Operational
          </span>
          <span className="text-xs text-text-muted">
            Last updated: {formatLastUpdated(lastUpdated)}
          </span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap items-center gap-3">
        {canManage && (
          <>
            <button
              type="button"
              onClick={() => setOpenModal("assign")}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary-hover rounded-lg shadow-sm transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Assign Deal
            </button>
            <button
              type="button"
              onClick={() => setOpenModal("task")}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary bg-primary-light hover:bg-primary/10 rounded-lg transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">add_task</span>
              Create Task
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setOpenModal("review")}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-text-secondary hover:text-primary hover:bg-gray-100 rounded-lg transition-all"
        >
          <span className="material-symbols-outlined text-[18px]">calendar_month</span>
          Schedule Review
        </button>
        <button
          type="button"
          onClick={() => setOpenModal("reminder")}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-text-secondary hover:text-primary hover:bg-gray-100 rounded-lg transition-all"
        >
          <span className="material-symbols-outlined text-[18px]">notifications_active</span>
          Send Reminder
        </button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          label="Team"
          icon="groups"
          value={activeMembers.length}
          subtitle={`${activeMembers.length} active / ${totalMembers} total`}
          onClick={() => scrollTo("resource-allocation")}
        />
        <StatCard
          label="Deal Volume"
          icon="payments"
          value={formatCurrency(totalVolume)}
          subtitle={`across ${deals.length} deal${deals.length !== 1 ? "s" : ""}`}
          onClick={() => scrollTo("resource-allocation")}
        />
        <StatCard
          label="Overdue"
          icon="pending_actions"
          value={overdueTasks.length > 0 ? overdueTasks.length : "—"}
          subtitle={`${dueThisWeek.length} due this week`}
          valueColor={overdueTasks.length > 0 ? "#ef4444" : undefined}
          onClick={() => {
            setExternalTaskFilter("OVERDUE");
            scrollTo("task-table-body");
          }}
        />
        <StatCard
          label="Utilization"
          icon="speed"
          value={`${utilization}%`}
          subtitle={`${assignedCount}/${totalMembers} members assigned`}
          onClick={() => scrollTo("resource-allocation")}
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <ResourceAllocation members={teamMembers} deals={deals} tasks={tasks} />
          <TaskTable
            tasks={tasks}
            externalFilter={externalTaskFilter}
            onTasksChanged={refreshAfterAction}
            onToast={showToast}
          />
        </div>
        <div className="xl:col-span-1 space-y-6">
          <SecurityDashboard />
          <ActivityFeed />
          <UpcomingReviews
            tasks={tasks}
            onScheduleClick={() => setOpenModal("review")}
          />
        </div>
      </div>

      {/* Modals */}
      <AssignDealModal
        open={openModal === "assign"}
        onClose={() => setOpenModal(null)}
        deals={deals}
        users={teamMembers}
        onToast={showToast}
        onAssigned={refreshAfterAction}
      />
      <CreateTaskModal
        open={openModal === "task"}
        onClose={() => setOpenModal(null)}
        deals={deals}
        users={teamMembers}
        onToast={showToast}
        onCreated={refreshAfterAction}
      />
      <ScheduleReviewModal
        open={openModal === "review"}
        onClose={() => setOpenModal(null)}
        deals={deals}
        users={teamMembers}
        onToast={showToast}
        onScheduled={refreshAfterAction}
      />
      <SendReminderModal
        open={openModal === "reminder"}
        onClose={() => setOpenModal(null)}
        deals={deals}
        users={teamMembers}
        onToast={showToast}
      />
    </div>
  );
}

// ─── Helpers / sub-components ────────────────────────────────────────

function formatLastUpdated(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function StatCard({
  label,
  icon,
  value,
  subtitle,
  valueColor,
  onClick,
}: {
  label: string;
  icon: string;
  value: string | number;
  subtitle: string;
  valueColor?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-card hover:shadow-card-hover hover:border-primary/30 transition-all cursor-pointer text-left"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">
          {label}
        </span>
        <span className="material-symbols-outlined text-text-muted text-[20px]">{icon}</span>
      </div>
      <div className="flex items-end gap-2 mt-3">
        <h3
          className="text-3xl font-bold tracking-tight"
          style={{ color: valueColor || "#111827" }}
        >
          {value}
        </h3>
      </div>
      <p className="text-xs text-text-muted mt-1">{subtitle}</p>
    </button>
  );
}
