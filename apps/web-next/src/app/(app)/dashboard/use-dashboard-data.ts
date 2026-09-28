"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { onDealsChanged } from "@/lib/appEvents";
import type { Deal, Task } from "./components";
import { readSnoozes, snoozeUntil, writeSnoozes } from "./triage";

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
    const [dealsRes, tasksRes] = await Promise.allSettled([
      api.get<Deal[] | { deals: Deal[] }>("/deals?limit=200&sortBy=updatedAt&sortOrder=desc"),
      api.get<{ tasks: Task[] } | Task[]>("/tasks?limit=100"),
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
    const now = Date.now();
    lastUpdatedRef.current = now;
    setLastUpdated(now);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Initial load + snooze hydration (localStorage is client-only).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSnoozes(readSnoozes(Date.now()));
    load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  const snooze = useCallback((key: string, days: number) => {
    setSnoozes((prev) => {
      const next = { ...prev, [key]: snoozeUntil(days, Date.now()) };
      writeSnoozes(next);
      return next;
    });
  }, []);

  const unsnooze = useCallback((key: string) => {
    setSnoozes((prev) => {
      const next = { ...prev };
      delete next[key];
      writeSnoozes(next);
      return next;
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
