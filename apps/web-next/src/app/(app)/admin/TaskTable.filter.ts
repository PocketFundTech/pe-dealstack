import { dayOffset } from "../dashboard/triage";
import { isOpen, isOverdue } from "./admin-logic";
import type { AdminTask } from "./types";
import { PRIORITY_RANK, type FilterValue } from "./TaskTable.helpers";

// Tab filtering + a sensible default order per tab: open work by due date
// (undated last, then priority), finished work most recent first.

const due = (t: AdminTask) => (t.dueDate ? new Date(t.dueDate).getTime() : Infinity);

export function filterTasks(tasks: AdminTask[], filter: FilterValue, now: number): AdminTask[] {
  const list = tasks.filter((t) => {
    if (filter === "OPEN") return isOpen(t);
    if (filter === "OVERDUE") return isOverdue(t, now);
    if (filter === "WEEK") {
      if (!isOpen(t) || !t.dueDate) return false;
      const off = dayOffset(t.dueDate, now);
      return off >= 0 && off <= 7;
    }
    if (filter === "DONE") return !isOpen(t);
    return true;
  });
  if (filter === "DONE") {
    return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
  return list.sort((a, b) =>
    Number(!isOpen(a)) - Number(!isOpen(b))
    || due(a) - due(b)
    || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2),
  );
}

export function tabCounts(tasks: AdminTask[], now: number): Record<FilterValue, number> {
  return {
    OPEN: filterTasks(tasks, "OPEN", now).length,
    OVERDUE: filterTasks(tasks, "OVERDUE", now).length,
    WEEK: filterTasks(tasks, "WEEK", now).length,
    DONE: filterTasks(tasks, "DONE", now).length,
    ALL: tasks.length,
  };
}
