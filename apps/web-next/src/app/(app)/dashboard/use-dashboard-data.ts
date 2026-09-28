"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { onDealsChanged } from "@/lib/appEvents";
import type { Deal, Task } from "./components";
import { snoozeUntil } from "./triage";

export interface TeamMember {
  id: string;
  name?: string;
  email?: string;
  title?: string;
}

// Refetch silently when the tab regains focus after this long away.
const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Owns every piece of dashboard data plus the optimistic mutations the
 * morning-brief UI performs inline. Mutations update local state first and
 * roll back (re-throwing) if the API call fails, so callers can surface the
 * error and offer undo.
 */
export function useDashboardData() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [dealsError, setDealsError] = useState(false);
  const [tasksError, setTasksError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    // Snoozes ride along with deals/tasks (not localStorage — GET
    // /snoozes is server-side, so a snooze made on one device is honoured
    // on another) and refresh on every reload for the same reason: it's a
    // small, cheap, org-agnostic read, not worth a separate load path.
    const [dealsRes, tasksRes, snoozesRes] = await Promise.allSettled([
      api.get<Deal[] | { deals: Deal[] }>("/deals?limit=200&sortBy=updatedAt&sortOrder=desc"),
      api.get<{ tasks: Task[] } | Task[]>("/tasks?limit=100"),
      api.get<{ snoozes: Record<string, string> }>("/snoozes"),
    ]);
    if (dealsRes.status === "fulfilled") {
      const v = dealsRes.value;
      setDeals(Array.isArray(v) ? v : v.deals || []);
      setDealsError(false);
    } else {
      console.warn("[dashboard] failed to load deals:", dealsRes.reason);
      setDealsError(true);
    }
    if (tasksRes.status === "fulfilled") {
      const v = tasksRes.value;
      setTasks(Array.isArray(v) ? v : v.tasks || []);
      setTasksError(false);
    } else {
      console.warn("[dashboard] failed to load tasks:", tasksRes.reason);
      setTasksError(true);
    }
    if (snoozesRes.status === "fulfilled") {
      const raw = snoozesRes.value.snoozes ?? {};
      const parsed: Record<string, number> = {};
      for (const [key, iso] of Object.entries(raw)) parsed[key] = new Date(iso).getTime();
      setSnoozes(parsed);
    } else {
      // Non-fatal: worst case a snoozed item briefly reappears in the
      // queue until the next successful reload.
      console.warn("[dashboard] failed to load snoozes:", snoozesRes.reason);
    }
    const now = Date.now();
    lastUpdatedRef.current = now;
    setLastUpdated(now);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
  useEffect(() => { load(); }, [load]);

  // A deal ingested/updated elsewhere (e.g. the ingest modal) refreshes silently.
  useEffect(() => onDealsChanged(() => { load(); }), [load]);

  // Returning to a tab that has been in the background for a while.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const last = lastUpdatedRef.current;
      if (last && Date.now() - last > STALE_AFTER_MS) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  const setTaskStatus = useCallback(async (taskId: string, status: string) => {
    let previous: string | undefined;
    setTasks((prev) => prev.map((t) => {
      if (t.id !== taskId) return t;
      previous = t.status;
      return { ...t, status };
    }));
    try {
      await api.patch(`/tasks/${taskId}`, { status });
    } catch (err) {
      setTasks((prev) => prev.map((t) => (t.id === taskId && previous ? { ...t, status: previous } : t)));
      throw err;
    }
  }, []);

  const assignOwner = useCallback(async (dealId: string, member: TeamMember) => {
    let previous: Deal["assignedUser"];
    setDeals((prev) => prev.map((d) => {
      if (d.id !== dealId) return d;
      previous = d.assignedUser;
      return { ...d, assignedUser: { id: member.id, name: member.name, email: member.email } };
    }));
    try {
      await api.patch(`/deals/${dealId}`, { assignedTo: member.id });
    } catch (err) {
      setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, assignedUser: previous } : d)));
      throw err;
    }
  }, []);

  const addTask = useCallback(async (input: { title: string; dueDate?: string; assignedTo?: string }) => {
    const tempId = `temp-${Date.now()}`;
    const optimistic: Task = { id: tempId, title: input.title, status: "PENDING", dueDate: input.dueDate, assignedTo: input.assignedTo };
    setTasks((prev) => [optimistic, ...prev]);
    try {
      const created = await api.post<Task | { task: Task }>("/tasks", { ...input, priority: "MEDIUM" });
      const task = "task" in created ? created.task : created;
      setTasks((prev) => prev.map((t) => (t.id === tempId ? { ...optimistic, ...task } : t)));
    } catch (err) {
      setTasks((prev) => prev.filter((t) => t.id !== tempId));
      throw err;
    }
  }, []);

  // Snooze/unsnooze are low-stakes and called fire-and-forget from page.tsx
  // (no await, no catch there) — update the UI immediately and best-effort
  // persist server-side; a failed write just means the item can reappear on
  // the next reload rather than corrupting anything, so unlike the
  // mutations above this doesn't roll back or rethrow on failure.
  const snooze = useCallback((key: string, days: number) => {
    const until = snoozeUntil(days, Date.now());
    setSnoozes((prev) => ({ ...prev, [key]: until }));
    api.post("/snoozes", { itemKey: key, until: new Date(until).toISOString() }).catch((err) => {
      console.warn("[dashboard] failed to persist snooze:", err);
    });
  }, []);

  const unsnooze = useCallback((key: string) => {
    setSnoozes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    api.delete(`/snoozes/${encodeURIComponent(key)}`).catch((err) => {
      console.warn("[dashboard] failed to remove snooze:", err);
    });
  }, []);

  /** Team list for the Assign menu — fetched once, on first open. */
  const loadTeam = useCallback(async () => {
    if (team) return team;
    try {
      const users = await api.get<TeamMember[] | { users: TeamMember[] }>("/users");
      const list = Array.isArray(users) ? users : users.users || [];
      setTeam(list);
      return list;
    } catch (err) {
      console.warn("[dashboard] failed to load team:", err);
      setTeam([]);
      return [];
    }
  }, [team]);

  return {
    deals, tasks, loading, dealsError, tasksError, refreshing, lastUpdated, snoozes, team,
    refresh: load, setTaskStatus, assignOwner, addTask, snooze, unsnooze, loadTeam,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
