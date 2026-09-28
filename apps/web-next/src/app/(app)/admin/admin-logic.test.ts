import { describe, it, expect } from "vitest";
import { dealContact, dealNameSummary, slipping, taskDueText, workload } from "./admin-logic";
import { DAY_MS } from "../dashboard/triage";
import type { AdminDeal, AdminTask, AdminTeamMember } from "./types";

const NOW = new Date(2026, 8, 27, 10).getTime();
const at = (d: number) => new Date(NOW + d * DAY_MS).toISOString();

const member = (id: string, name: string): AdminTeamMember => ({ id, name, email: `${id}@x.com` });
const deal = (over: Partial<AdminDeal>): AdminDeal => ({ id: "d", name: "Deal", stage: "INITIAL_REVIEW", updatedAt: at(0), ...over });
const task = (over: Partial<AdminTask>): AdminTask => ({
  id: "t", title: "Task", status: "PENDING", priority: "MEDIUM", dueDate: null, createdAt: at(-30), updatedAt: at(-1), ...over,
});

describe("taskDueText", () => {
  it("never shows negative future dates for completed tasks", () => {
    const done = taskDueText(task({ status: "COMPLETED", dueDate: at(-215), updatedAt: at(-200) }), NOW);
    expect(done.text).toMatch(/^Done [A-Z][a-z]{2} \d+$/);
    expect(done.tone).toBe("muted");
  });
  it("labels open tasks relative to today", () => {
    expect(taskDueText(task({ dueDate: at(-3) }), NOW)).toEqual({ text: "3 days overdue", tone: "red" });
    expect(taskDueText(task({ dueDate: at(0) }), NOW)).toEqual({ text: "Due today", tone: "brass" });
    expect(taskDueText(task({ dueDate: null }), NOW).text).toBe("No date");
  });
});

describe("workload", () => {
  const team = [member("a", "Ana"), member("b", "Ben"), member("c", "Cal")];
  const deals = [
    deal({ id: "1", assignedUser: { id: "a" } }),
    deal({ id: "2", teamMembers: [{ userId: "a" }] }),
    deal({ id: "3", assignedUser: { id: "b" } }),
    deal({ id: "4", assignedUser: { id: "b" }, status: "PASSED" }),
  ];
  const tasks = [
    task({ id: "t1", assignedTo: "a", dueDate: at(-2) }),
    task({ id: "t2", assignedTo: "a", dueDate: at(-1) }),
    task({ id: "t3", assignedTo: "b", status: "COMPLETED" }),
  ];

  it("scales load to the busiest person and ignores dead deals + done tasks", () => {
    const rows = workload(team, deals, tasks, NOW);
    expect(rows.map((r) => [r.member.id, r.deals.length, r.openTasks, r.overdue, r.loadPct])).toEqual([
      ["a", 2, 2, 2, 100],
      ["b", 1, 0, 0, 33],
      ["c", 0, 0, 0, 0],
    ]);
  });

  it("tags idle and stretched people", () => {
    const rows = workload(team, deals, tasks, NOW);
    expect(rows.find((r) => r.member.id === "a")?.tag).toBe("stretched");
    expect(rows.find((r) => r.member.id === "c")?.tag).toBe("idle");
    expect(rows.find((r) => r.member.id === "b")?.tag).toBeNull();
  });
});

describe("slipping", () => {
  it("ranks overdue tasks (oldest first), then unowned, then stale deals", () => {
    const items = slipping(
      [
        deal({ id: "stale", updatedAt: at(-40), assignedUser: { id: "a" } }),
        deal({ id: "unowned", stage: "DUE_DILIGENCE" }),
        deal({ id: "fresh", assignedUser: { id: "a" } }),
      ],
      [task({ id: "late1", dueDate: at(-1) }), task({ id: "late9", dueDate: at(-9) }), task({ id: "done", status: "COMPLETED", dueDate: at(-5) })],
      NOW,
    );
    expect(items.map((i) => i.key)).toEqual(["task:late9", "task:late1", "unowned:unowned", "stale:stale"]);
  });
});

describe("helpers", () => {
  it("finds who to nudge about a deal", () => {
    expect(dealContact(deal({ assignedUser: { id: "owner" } }))).toBe("owner");
    expect(dealContact(deal({ teamMembers: [{ userId: "m" }, { userId: "l", role: "LEAD", user: { id: "l" } }] }))).toBe("l");
    expect(dealContact(deal({}))).toBeUndefined();
  });
  it("collapses repeated deal names", () => {
    expect(dealNameSummary([deal({ id: "1", name: "DMpro" }), deal({ id: "2", name: "DMpro" }), deal({ id: "3", name: "Nino" })]))
      .toEqual(["DMpro ×2", "Nino"]);
  });
});
