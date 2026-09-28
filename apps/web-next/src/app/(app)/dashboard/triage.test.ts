import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildTodayQueue,
  dueLabel,
  groupSectors,
  isUnowned,
  nextUpcomingTask,
  readSnoozes,
  sectorKey,
  snoozeUntil,
  touchLabel,
  writeSnoozes,
  DAY_MS,
  SNOOZE_STORAGE_KEY,
} from "./triage";
import type { Deal, Task } from "./components";

// Fixed "now": Sun 27 Sep 2026, 10:00 local.
const NOW = new Date(2026, 8, 27, 10, 0, 0).getTime();
const at = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

const deal = (over: Partial<Deal>): Deal => ({ id: "d", name: "Deal", stage: "INITIAL_REVIEW", updatedAt: at(0), ...over });
const task = (over: Partial<Task>): Task => ({ id: "t", title: "Task", status: "PENDING", ...over });

describe("buildTodayQueue", () => {
  it("ranks overdue, then due today, then unowned, then stale", () => {
    const q = buildTodayQueue(
      [
        deal({ id: "stale", updatedAt: at(-20), assignedUser: { name: "A" } }),
        deal({ id: "unowned", stage: "DUE_DILIGENCE" }),
      ],
      [task({ id: "today", dueDate: at(0) }), task({ id: "late", dueDate: at(-3) })],
      { userId: "me", now: NOW },
    );
    expect(q.map((i) => i.key)).toEqual(["task:late", "task:today", "unowned:unowned", "stale:stale"]);
  });

  it("ignores completed tasks, other people's tasks and future tasks", () => {
    const q = buildTodayQueue(
      [],
      [
        task({ id: "done", dueDate: at(-1), status: "COMPLETED" }),
        task({ id: "theirs", dueDate: at(-1), assignedTo: "someone-else" }),
        task({ id: "future", dueDate: at(3) }),
        task({ id: "unassigned", dueDate: at(-1) }),
      ],
      { userId: "me", now: NOW },
    );
    expect(q.map((i) => i.key)).toEqual(["task:unassigned"]);
  });

  it("skips dead deals and hides snoozed items until the snooze expires", () => {
    const deals = [
      deal({ id: "passed", status: "PASSED", updatedAt: at(-40), assignedUser: { name: "A" } }),
      deal({ id: "s", updatedAt: at(-30), assignedUser: { name: "A" } }),
    ];
    expect(buildTodayQueue(deals, [], { now: NOW, snoozes: { "stale:s": NOW + DAY_MS } })).toHaveLength(0);
    expect(buildTodayQueue(deals, [], { now: NOW, snoozes: { "stale:s": NOW - 1 } })).toHaveLength(1);
  });
});

describe("isUnowned", () => {
  it("flags ownerless deals only when high priority or past sourcing", () => {
    expect(isUnowned(deal({ priority: "MEDIUM" }))).toBe(false);
    expect(isUnowned(deal({ priority: "HIGH" }))).toBe(true);
    expect(isUnowned(deal({ stage: "DUE_DILIGENCE" }))).toBe(true);
    expect(isUnowned(deal({ stage: "DUE_DILIGENCE", assignedUser: { name: "A" } }))).toBe(false);
  });
});

describe("labels", () => {
  it("formats due dates relative to today, including the future", () => {
    expect(dueLabel(at(-3), NOW)).toBe("3 days overdue");
    expect(dueLabel(at(-1), NOW)).toBe("1 day overdue");
    expect(dueLabel(at(0), NOW)).toBe("Due today");
    expect(dueLabel(at(1), NOW)).toBe("Due tomorrow");
    expect(dueLabel(at(3), NOW)).toMatch(/^Due (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(dueLabel(at(20), NOW)).toMatch(/^Due [A-Z][a-z]{2} \d+$/);
  });

  it("formats last-touch ages", () => {
    expect(touchLabel(at(0), NOW)).toBe("Today");
    expect(touchLabel(at(-1), NOW)).toBe("Yesterday");
    expect(touchLabel(at(-5), NOW)).toBe("5d ago");
    expect(touchLabel(at(-21), NOW)).toBe("3w ago");
  });
});

describe("sectors", () => {
  it("normalises near-duplicate spellings", () => {
    expect(sectorKey("Food & Beverages")).toBe(sectorKey(" food and beverage "));
    expect(sectorKey("Business Services")).toBe("business service");
    expect(sectorKey("")).toBe("");
  });

  it("groups, keeps the most common spelling, and rolls the tail into Others", () => {
    const deals = [
      deal({ id: "1", industry: "Food & Beverages" }),
      deal({ id: "2", industry: "Food & Beverages" }),
      deal({ id: "3", industry: "Food & Beverage" }),
      deal({ id: "4", industry: "SaaS" }),
      deal({ id: "5", industry: "" }),
      deal({ id: "6", industry: "Logistics" }),
      deal({ id: "7", industry: "Retail" }),
    ];
    const groups = groupSectors(deals, 2);
    expect(groups[0]).toMatchObject({ label: "Food & Beverages", count: 3, pct: 43 });
    expect(groups.at(-1)).toMatchObject({ key: "others", count: 3 });
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(7);
  });
});

describe("snoozes", () => {
  // Node's built-in localStorage shadows jsdom's in this runtime, so use an
  // in-memory stub for these storage round-trips.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(window.localStorage.getItem(SNOOZE_STORAGE_KEY)).toBeNull();
  });

  it("round-trips and prunes expired entries", () => {
    writeSnoozes({ a: NOW + 1000, b: NOW - 1000 });
    expect(readSnoozes(NOW)).toEqual({ a: NOW + 1000 });
  });

  it("snoozes to the start of a future day", () => {
    expect(new Date(snoozeUntil(1, NOW)).getHours()).toBe(0);
    expect(snoozeUntil(1, NOW)).toBeGreaterThan(NOW);
  });
});

describe("nextUpcomingTask", () => {
  it("returns the soonest future task of mine", () => {
    const t = nextUpcomingTask(
      [task({ id: "far", dueDate: at(9) }), task({ id: "soon", dueDate: at(2) }), task({ id: "past", dueDate: at(-1) })],
      "me",
      NOW,
    );
    expect(t?.id).toBe("soon");
  });
});
