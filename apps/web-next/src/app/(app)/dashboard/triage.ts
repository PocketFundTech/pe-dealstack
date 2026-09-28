// Pure dashboard logic: what needs the user today, stage buckets, sector
// grouping, snoozes and due-date labels. No React, no network — unit-tested
// in triage.test.ts. See docs/superpowers/specs/2026-09-27-dashboard-morning-brief-design.md.

import type { Deal, Task } from "./components";

export const STALE_DAYS = 14;
export const DAY_MS = 86_400_000;
export const SNOOZE_STORAGE_KEY = "avise-dash-snoozes";

const DEAD_STATUSES = new Set(["ARCHIVED", "PASSED"]);
const DEAD_STAGES = new Set(["PASSED", "CLOSED_WON", "CLOSED_LOST"]);
const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
// Stages at which a deal with no owner is a problem regardless of priority.
const OWNER_REQUIRED_STAGES = new Set([
  "DUE_DILIGENCE", "IOI_SUBMITTED", "LOI_SUBMITTED", "LOI_OFFER", "NEGOTIATION", "CLOSING",
]);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function startOfDay(d: Date | number): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Whole calendar days from today to `iso` (negative = past). */
export function dayOffset(iso: string, now: number): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY_MS);
}

export function daysSince(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "3 days overdue" · "Due today" · "Due tomorrow" · "Due Thu" · "Due Oct 14" */
export function dueLabel(iso: string, now: number): string {
  const off = dayOffset(iso, now);
  if (off < -1) return `${-off} days overdue`;
  if (off === -1) return "1 day overdue";
  if (off === 0) return "Due today";
  if (off === 1) return "Due tomorrow";
  if (off < 7) return `Due ${WEEKDAY.format(new Date(iso))}`;
  return `Due ${MONTH_DAY.format(new Date(iso))}`;
}

/** "Today" · "Yesterday" · "5d ago" · "3w ago" · "Mar 4" */
export function touchLabel(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const d = daysSince(iso, now);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return MONTH_DAY.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Deals & tasks
// ---------------------------------------------------------------------------

export function isLiveDeal(d: Deal): boolean {
  return !DEAD_STATUSES.has(d.status || "") && !DEAD_STAGES.has(d.stage);
}

export function isStale(d: Deal, now: number): boolean {
  return isLiveDeal(d) && daysSince(d.updatedAt, now) >= STALE_DAYS;
}

export function isUnowned(d: Deal): boolean {
  if (!isLiveDeal(d) || d.assignedUser) return false;
  return d.priority === "HIGH" || d.priority === "URGENT" || OWNER_REQUIRED_STAGES.has(d.stage);
}

export function isOpenTask(t: Task): boolean {
  return t.status !== "COMPLETED";
}

/** Tasks assigned to me, or to nobody (still mine to pick up). */
export function isMyTask(t: Task, userId: string | undefined): boolean {
  return !t.assignedTo || !userId || t.assignedTo === userId;
}

export function priorityRank(p: string | undefined): number {
  return PRIORITY_RANK[p || ""] ?? 9;
}

export type TaskBucket = "overdue" | "today" | "upcoming" | "undated";

export function taskBucket(t: Task, now: number): TaskBucket {
  if (!t.dueDate) return "undated";
  const off = dayOffset(t.dueDate, now);
  if (off < 0) return "overdue";
  if (off === 0) return "today";
  return "upcoming";
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export interface StageBucket {
  key: string;
  label: string;
  stages: string[];
  tone: string;
}

export const PIPELINE: StageBucket[] = [
  { key: "sourcing", label: "Sourcing", stages: ["SOURCING", "INITIAL_REVIEW"], tone: "var(--dash-blue-4)" },
  { key: "diligence", label: "Diligence", stages: ["DUE_DILIGENCE"], tone: "var(--dash-blue-3)" },
  { key: "loi", label: "IOI / LOI", stages: ["IOI_SUBMITTED", "LOI_SUBMITTED", "LOI_OFFER"], tone: "var(--dash-blue-2)" },
  { key: "negotiation", label: "Negotiation", stages: ["NEGOTIATION", "CLOSING"], tone: "var(--dash-blue)" },
  { key: "closed", label: "Closed", stages: ["CLOSED_WON"], tone: "var(--dash-green)" },
];

// ---------------------------------------------------------------------------
// Today queue
// ---------------------------------------------------------------------------

export type QueueKind = "overdue" | "due-today" | "unowned" | "stale";

export type QueueItem =
  | { key: string; kind: "overdue" | "due-today"; task: Task; sortValue: number }
  | { key: string; kind: "unowned" | "stale"; deal: Deal; sortValue: number };

const KIND_ORDER: Record<QueueKind, number> = { overdue: 0, "due-today": 1, unowned: 2, stale: 3 };
export const SNOOZE_DAYS: Record<QueueKind, number> = { overdue: 1, "due-today": 1, unowned: 7, stale: 7 };

export function buildTodayQueue(
  deals: Deal[],
  tasks: Task[],
  opts: { userId?: string; now: number; snoozes?: Record<string, number> },
): QueueItem[] {
  const { userId, now, snoozes = {} } = opts;
  const snoozed = (key: string) => (snoozes[key] ?? 0) > now;
  const items: QueueItem[] = [];

  for (const t of tasks) {
    if (!isOpenTask(t) || !isMyTask(t, userId) || !t.dueDate) continue;
    const bucket = taskBucket(t, now);
    if (bucket !== "overdue" && bucket !== "today") continue;
    const key = `task:${t.id}`;
    if (snoozed(key)) continue;
    items.push({
      key,
      kind: bucket === "overdue" ? "overdue" : "due-today",
      task: t,
      sortValue: new Date(t.dueDate).getTime(),
    });
  }

  for (const d of deals) {
    if (isUnowned(d)) {
      const key = `unowned:${d.id}`;
      if (!snoozed(key)) items.push({ key, kind: "unowned", deal: d, sortValue: priorityRank(d.priority) });
    } else if (isStale(d, now)) {
      const key = `stale:${d.id}`;
      if (!snoozed(key)) items.push({ key, kind: "stale", deal: d, sortValue: new Date(d.updatedAt).getTime() });
    }
  }

  return items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sortValue - b.sortValue);
}

/** Soonest open task of mine due after today — for the empty-queue message. */
export function nextUpcomingTask(tasks: Task[], userId: string | undefined, now: number): Task | null {
  return (
    tasks
      .filter((t) => isOpenTask(t) && isMyTask(t, userId) && t.dueDate && dayOffset(t.dueDate, now) > 0)
      .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// Sectors
// ---------------------------------------------------------------------------

/** "Food & Beverages" and " food and beverage" collapse to the same key. */
export function sectorKey(raw: string | undefined): string {
  const s = (raw || "").trim().toLowerCase().replace(/\s+and\s+/g, " & ").replace(/\s+/g, " ");
  if (!s) return "";
  return s.replace(/(?<![s])s$/, "");
}

export interface SectorGroup {
  key: string;
  label: string;
  count: number;
  pct: number;
  deals: Deal[];
}

export function groupSectors(deals: Deal[], top = 4): SectorGroup[] {
  type Bucket = { spellings: Map<string, number>; deals: Deal[] };
  const groups = new Map<string, Bucket>();
  for (const d of deals) {
    const key = sectorKey(d.industry) || "uncategorized";
    const g: Bucket = groups.get(key) ?? { spellings: new Map<string, number>(), deals: [] };
    const spelling = d.industry?.trim() || "Uncategorized";
    g.spellings.set(spelling, (g.spellings.get(spelling) ?? 0) + 1);
    g.deals.push(d);
    groups.set(key, g);
  }
  const total = deals.length || 1;
  const all = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: [...g.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
      count: g.deals.length,
      pct: 0,
      deals: g.deals,
    }))
    // Uncategorized never takes a "top" slot over a real sector.
    .sort((a, b) => Number(a.key === "uncategorized") - Number(b.key === "uncategorized") || b.count - a.count);

  const head = all.slice(0, top);
  const rest = all.slice(top);
  if (rest.length) {
    const deals = rest.flatMap((g) => g.deals);
    head.push({ key: "others", label: rest.length === 1 ? rest[0].label : `${rest.length} other sectors`, count: deals.length, pct: 0, deals });
  }
  return head.map((g) => ({ ...g, pct: Math.round((g.count / total) * 100) }));
}

// ---------------------------------------------------------------------------
// Snoozes (per-browser until there is a server-side field)
// ---------------------------------------------------------------------------

export function readSnoozes(now: number): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return Object.fromEntries(Object.entries(parsed).filter(([, until]) => typeof until === "number" && until > now));
  } catch (err) {
    console.warn("[dashboard] failed to read snoozes:", err);
    return {};
  }
}

export function writeSnoozes(snoozes: Record<string, number>): void {
  try {
    window.localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(snoozes));
  } catch (err) {
    console.warn("[dashboard] failed to persist snoozes:", err);
  }
}

/** Snooze until the start of the day `days` from now. */
export function snoozeUntil(days: number, now: number): number {
  return startOfDay(now) + days * DAY_MS;
}
