// Pure Command Center logic: team workload, what's slipping across the org,
// and task due labels. Built on the dashboard's triage primitives so both
// pages agree on what "stale", "unowned" and "overdue" mean. Unit-tested in
// admin-logic.test.ts.

import type { Deal } from "../dashboard/components";
import { dayOffset, dueLabel, isLiveDeal, isStale, isUnowned, daysSince } from "../dashboard/triage";
import type { AdminDeal, AdminTask, AdminTeamMember } from "./types";

const asDeal = (d: AdminDeal) => d as unknown as Deal;

export const isReview = (t: AdminTask) => t.title.startsWith("[Review]");
export const isOpen = (t: AdminTask) => t.status !== "COMPLETED" && t.status !== "CANCELLED";
export const isOverdue = (t: AdminTask, now: number) => isOpen(t) && !!t.dueDate && dayOffset(t.dueDate, now) < 0;
export const isLive = (d: AdminDeal) => isLiveDeal(asDeal(d));

// ---------------------------------------------------------------------------
// Task due labels — fixes "In -215 days" for completed tasks
// ---------------------------------------------------------------------------

export function taskDueText(t: AdminTask, now: number): { text: string; tone: "red" | "brass" | "muted" | "ink" } {
  if (!isOpen(t)) {
    const when = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    return { text: when ? `Done ${when}` : "Done", tone: "muted" };
  }
  if (!t.dueDate) return { text: "No date", tone: "muted" };
  const off = dayOffset(t.dueDate, now);
  const text = dueLabel(t.dueDate, now);
  if (off < 0) return { text, tone: "red" };
  if (off === 0) return { text, tone: "brass" };
  return { text, tone: "ink" };
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

export interface MemberLoad {
  member: AdminTeamMember;
  deals: AdminDeal[];
  openTasks: number;
  overdue: number;
  /** Relative load 0–100, scaled to the busiest person on the team. */
  loadPct: number;
  tag: "idle" | "stretched" | null;
}

// A live deal weighs more than a single task.
const DEAL_WEIGHT = 2;

export function dealsFor(memberId: string, deals: AdminDeal[]): AdminDeal[] {
  return deals.filter((d) =>
    d.assignedUser?.id === memberId ||
    d.teamMembers?.some((tm) => (tm.user?.id || tm.userId) === memberId),
  );
}

export function workload(members: AdminTeamMember[], deals: AdminDeal[], tasks: AdminTask[], now: number): MemberLoad[] {
  const live = deals.filter(isLive);
  const rows = members.map((member) => {
    const mine = dealsFor(member.id, live);
    const myTasks = tasks.filter((t) => t.assignedTo === member.id && isOpen(t));
    return {
      member,
      deals: mine,
      openTasks: myTasks.length,
      overdue: myTasks.filter((t) => isOverdue(t, now)).length,
      score: mine.length * DEAL_WEIGHT + myTasks.length,
    };
  });
  const max = Math.max(1, ...rows.map((r) => r.score));
  return rows
    .map(({ score, ...r }) => {
      const loadPct = Math.round((score / max) * 100);
      const tag: MemberLoad["tag"] = score === 0 ? "idle" : r.overdue >= 2 || (loadPct >= 80 && score >= 6) ? "stretched" : null;
      return { ...r, loadPct, tag };
    })
    .sort((a, b) => b.loadPct - a.loadPct || a.member.name.localeCompare(b.member.name));
}

// ---------------------------------------------------------------------------
// Slipping — org-wide version of the dashboard's Today queue
// ---------------------------------------------------------------------------

export type SlipItem =
  | { key: string; kind: "overdue"; task: AdminTask; days: number }
  | { key: string; kind: "unowned"; deal: AdminDeal }
  | { key: string; kind: "stale"; deal: AdminDeal; days: number };

const ORDER: Record<SlipItem["kind"], number> = { overdue: 0, unowned: 1, stale: 2 };

export function slipping(deals: AdminDeal[], tasks: AdminTask[], now: number): SlipItem[] {
  const items: SlipItem[] = [];
  for (const t of tasks) {
    if (isOverdue(t, now)) items.push({ key: `task:${t.id}`, kind: "overdue", task: t, days: -dayOffset(t.dueDate!, now) });
  }
  for (const d of deals) {
    if (isUnowned(asDeal(d))) items.push({ key: `unowned:${d.id}`, kind: "unowned", deal: d });
    else if (isStale(asDeal(d), now)) items.push({ key: `stale:${d.id}`, kind: "stale", deal: d, days: daysSince(d.updatedAt, now) });
  }
  const weight = (i: SlipItem) => ("days" in i ? -i.days : 0);
  return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || weight(a) - weight(b));
}

/** Who to nudge about a deal: its owner, else its lead, else anyone on it. */
export function dealContact(d: AdminDeal): string | undefined {
  return d.assignedUser?.id
    ?? d.teamMembers?.find((tm) => tm.role === "LEAD")?.user?.id
    ?? d.teamMembers?.[0]?.user?.id
    ?? d.teamMembers?.[0]?.userId;
}

/** Unique deal names for display ("DMpro" ×3 → "DMpro ×3"). */
export function dealNameSummary(deals: AdminDeal[]): string[] {
  const counts = new Map<string, number>();
  for (const d of deals) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}
