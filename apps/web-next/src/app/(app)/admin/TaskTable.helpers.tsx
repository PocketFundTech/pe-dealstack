"use client";

import { cn } from "@/lib/cn";
import type { AdminTaskStatus } from "./types";

// Constants + the status badge used by TaskTable (kept separate so the table
// module stays small).

export const TASK_PAGE_SIZE = 12;
export const STATUS_OPTIONS: AdminTaskStatus[] = ["PENDING", "IN_PROGRESS", "STUCK", "COMPLETED"];
export const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export type FilterValue = "OPEN" | "OVERDUE" | "WEEK" | "DONE" | "ALL";

export const FILTER_TABS: { value: FilterValue; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "WEEK", label: "Due this week" },
  { value: "DONE", label: "Done" },
  { value: "ALL", label: "All" },
];

const STATUS_META: Record<AdminTaskStatus, { label: string; dot: string; text: string }> = {
  PENDING: { label: "To do", dot: "bg-(--dash-rule-strong)", text: "text-(--dash-ink-2)" },
  IN_PROGRESS: { label: "In progress", dot: "bg-(--dash-blue-2)", text: "text-(--dash-blue)" },
  STUCK: { label: "Stuck", dot: "bg-(--dash-red)", text: "text-(--dash-red)" },
  COMPLETED: { label: "Done", dot: "bg-(--dash-green)", text: "text-(--dash-green)" },
  CANCELLED: { label: "Cancelled", dot: "bg-(--dash-rule-strong)", text: "text-(--dash-ink-3)" },
};

export function StatusBadge({ status }: { status: AdminTaskStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.PENDING;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[0.8125rem] font-medium", m.text)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: string }) {
  if (priority !== "HIGH" && priority !== "URGENT") {
    return priority === "LOW" ? <span className="text-xs text-(--dash-ink-3)">Low</span> : <span className="sr-only">Normal</span>;
  }
  return (
    <span className="rounded-sm bg-(--dash-red-wash) px-1.5 py-px text-[0.625rem] font-bold uppercase tracking-wider text-(--dash-red)">
      {priority === "URGENT" ? "Urgent" : "High"}
    </span>
  );
}
