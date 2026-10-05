"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { onDealsChanged } from "@/lib/appEvents";
import { useApiQuery } from "@/lib/useApiQuery";
import type { Deal, Task } from "./components";
import { readSnoozes, snoozeUntil, writeSnoozes } from "./triage";

export interface TeamMember {
  id: string;
  name?: string;
  email?: string;
  title?: string;
}

type DealsPayload = Deal[] | { deals: Deal[] };
type TasksPayload = { tasks: Task[] } | Task[];

// Refetch silently when the tab regains focus after this long away.
const STALE_AFTER_MS = 5 * 60 * 1000;
// No staleTime: revisits render instantly from cache AND revalidate in the
// background. A freshness window would hide edits made on other pages (e.g. a
// stage change on a deal) — the dashboard only hears onDealsChanged while
// it's mounted, so it can't invalidate itself while you're elsewhere.

function unwrapDeals(v: DealsPayload | undefined): Deal[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v.deals || [];
}

function unwrapTasks(v: TasksPayload | undefined): Task[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v.tasks || [];
}

// Rebuild the payload shape the cache is currently holding (array vs
// `{ tasks/deals }`) after mapping over the unwrapped list, so optimistic
// mutations never quietly change the cached response's envelope.
function remapDeals(prev: DealsPayload | undefined, fn: (list: Deal[]) => Deal[]): DealsPayload {
  if (prev === undefined || Array.isArray(prev)) return fn(unwrapDeals(prev));
  return { ...prev, deals: fn(prev.deals || []) };
}

function remapTasks(prev: TasksPayload | undefined, fn: (list: Task[]) => Task[]): TasksPayload {
  if (prev === undefined || Array.isArray(prev)) return fn(unwrapTasks(prev));
  return { ...prev, tasks: fn(prev.tasks || []) };
}

/**
 * Owns every piece of dashboard data plus the optimistic mutations the
 * morning-brief UI performs inline. Mutations update the shared query cache
 * first and roll back (re-throwing) if the API call fails, so callers can
 * surface the error and offer undo.
 *
 * `/deals` and `/tasks` are stale-while-revalidate cached via useApiQuery so
 * navigating away (e.g. to Deals) and back to Dashboard renders instantly
 * from cache instead of showing the skeleton again.
 */
export function useDashboardData() {
  const dealsQuery = useApiQuery<DealsPayload>("/deals?limit=200&sortBy=updatedAt&sortOrder=desc");
  const tasksQuery = useApiQuery<TasksPayload>("/tasks?limit=100");

  const deals = useMemo(() => unwrapDeals(dealsQuery.data), [dealsQuery.data]);
  const tasks = useMemo(() => unwrapTasks(tasksQuery.data), [tasksQuery.data]);

  const loading = dealsQuery.isLoading || tasksQuery.isLoading;
  // Errors only when there's no cached data to show: a failed background
  // revalidation keeps the last good widgets on screen.
  const dealsError = !!dealsQuery.error && dealsQuery.data === undefined;
  const tasksError = !!tasksQuery.error && tasksQuery.data === undefined;
  const refreshing = dealsQuery.isValidating || tasksQuery.isValidating;

  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});
  const [team, setTeam] = useState<TeamMember[] | null>(null);

  const { refetch: refetchDeals } = dealsQuery;
  const { refetch: refetchTasks } = tasksQuery;
  const load = useCallback(async () => {
    await Promise.allSettled([refetchDeals(), refetchTasks()]);
    const now = Date.now();
    lastUpdatedRef.current = now;
    setLastUpdated(now);
  }, [refetchDeals, refetchTasks]);

  // Snooze hydration (localStorage is client-only) — runs once on mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSnoozes(readSnoozes(Date.now()));
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Stamp lastUpdated once the initial fetch settles (cache hit or network).
  // Only re-stamp when the loading→loaded transition happens, not on every
  // background revalidation (that would defeat STALE_AFTER_MS below).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (loading) return;
    const now = Date.now();
    lastUpdatedRef.current = now;
    setLastUpdated(now);
  }, [loading]);
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

  const { mutate: mutateTasks } = tasksQuery;
  const { mutate: mutateDeals } = dealsQuery;

  const setTaskStatus = useCallback(async (taskId: string, status: string) => {
    let previous: string | undefined;
    mutateTasks((prev) => remapTasks(prev, (list) => list.map((t) => {
      if (t.id !== taskId) return t;
      previous = t.status;
      return { ...t, status };
    })));
    try {
      await api.patch(`/tasks/${taskId}`, { status });
    } catch (err) {
      mutateTasks((prev) => remapTasks(prev, (list) =>
        list.map((t) => (t.id === taskId && previous ? { ...t, status: previous } : t)),
      ));
      throw err;
    }
  }, [mutateTasks]);

  const assignOwner = useCallback(async (dealId: string, member: TeamMember) => {
    let previous: Deal["assignedUser"];
    mutateDeals((prev) => remapDeals(prev, (list) => list.map((d) => {
      if (d.id !== dealId) return d;
      previous = d.assignedUser;
      return { ...d, assignedUser: { id: member.id, name: member.name, email: member.email } };
    })));
    try {
      await api.patch(`/deals/${dealId}`, { assignedTo: member.id });
    } catch (err) {
      mutateDeals((prev) => remapDeals(prev, (list) =>
        list.map((d) => (d.id === dealId ? { ...d, assignedUser: previous } : d)),
      ));
      throw err;
    }
  }, [mutateDeals]);

  const addTask = useCallback(async (input: { title: string; dueDate?: string; assignedTo?: string }) => {
    const tempId = `temp-${Date.now()}`;
    const optimistic: Task = { id: tempId, title: input.title, status: "PENDING", dueDate: input.dueDate, assignedTo: input.assignedTo };
    mutateTasks((prev) => remapTasks(prev, (list) => [optimistic, ...list]));
    try {
      const created = await api.post<Task | { task: Task }>("/tasks", { ...input, priority: "MEDIUM" });
      const task = "task" in created ? created.task : created;
      mutateTasks((prev) => remapTasks(prev, (list) =>
        list.map((t) => (t.id === tempId ? { ...optimistic, ...task } : t)),
      ));
    } catch (err) {
      mutateTasks((prev) => remapTasks(prev, (list) => list.filter((t) => t.id !== tempId)));
      throw err;
    }
  }, [mutateTasks]);

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
