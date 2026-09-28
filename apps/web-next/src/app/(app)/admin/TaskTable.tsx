"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import type { AdminTask, AdminTaskStatus } from "./types";
import { FILTER_TABS, TASK_PAGE_SIZE, type FilterValue } from "./TaskTable.helpers";
import { TaskTableRow } from "./TaskTable.row";
import { filterTasks, tabCounts } from "./TaskTable.filter";

const TH = "dash-label whitespace-nowrap px-4 py-2.5 text-left font-semibold first:pl-6 last:pr-6";

interface Props {
  tasks: AdminTask[];
  now: number;
  /** Tab preset applied from outside (e.g. the masthead's "1 overdue" link). */
  externalFilter?: { value: FilterValue; nonce: number };
  onTasksChanged: () => void;
  onNotice: (message: string, tone?: "neutral" | "error", undo?: () => void) => void;
}

export function TaskTable({ tasks, now, externalFilter, onTasksChanged, onNotice }: Props) {
  const [filter, setFilter] = useState<FilterValue>("OPEN");
  const [showAll, setShowAll] = useState(false);

  // Re-applied every time the parent asks (nonce), not just on first change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (externalFilter) setFilter(externalFilter.value);
  }, [externalFilter]);

  const filtered = filterTasks(tasks, filter, now);
  const counts = tabCounts(tasks, now);
  const display = showAll ? filtered : filtered.slice(0, TASK_PAGE_SIZE);

  const updateStatus = async (task: AdminTask, status: AdminTaskStatus) => {
    const previous = task.status;
    try {
      await api.patch(`/tasks/${task.id}`, { status });
      onTasksChanged();
      onNotice(
        status === "COMPLETED" ? `Done: ${task.title}` : `Status updated: ${task.title}`,
        "neutral",
        async () => {
          try {
            await api.patch(`/tasks/${task.id}`, { status: previous });
            onTasksChanged();
          } catch (err) {
            console.warn("[admin] undo status failed:", err);
          }
        },
      );
    } catch (err) {
      console.warn("[admin] updateStatus failed:", err);
      onNotice("Couldn't update that task. Please try again.", "error");
    }
  };

  const deleteTask = async (task: AdminTask) => {
    try {
      await api.delete(`/tasks/${task.id}`);
      onTasksChanged();
      onNotice(`Deleted: ${task.title}`);
    } catch (err) {
      console.warn("[admin] delete task failed:", err);
      onNotice(err instanceof Error ? err.message : "Couldn't delete that task.", "error");
    }
  };

  return (
    <section id="tasks" aria-labelledby="tasks-heading" className="dash-panel scroll-mt-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-6 pt-5">
        <h2 id="tasks-heading" className="dash-display pb-3 text-xl text-(--dash-ink)">Tasks</h2>
        <div role="tablist" aria-label="Filter tasks" className="-mb-px flex flex-wrap gap-x-5">
          {FILTER_TABS.map((t) => {
            const selected = filter === t.value;
            const n = counts[t.value];
            return (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => { setFilter(t.value); setShowAll(false); }}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 pb-3 text-[0.8125rem] font-medium transition-colors",
                  selected ? "border-(--dash-blue) text-(--dash-ink)" : "border-transparent text-(--dash-ink-3) hover:text-(--dash-ink)",
                )}
              >
                {t.label}
                {n > 0 && (
                  <span className={cn(
                    "dash-num rounded-full px-1.5 text-[0.6875rem] font-semibold",
                    t.value === "OVERDUE" ? "bg-(--dash-red-wash) text-(--dash-red)" : "bg-(--dash-wash) text-(--dash-ink-2)",
                  )}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      <div role="tabpanel" className="border-t border-(--dash-rule) max-md:overflow-x-auto">
        <table className="w-full min-w-[700px] table-fixed text-sm">
          <thead>
            <tr className="border-b border-(--dash-rule) bg-(--dash-paper)">
              <th className={TH}>Task</th>
              <th className={cn(TH, "w-[9%]")}>Priority</th>
              <th className={cn(TH, "w-[16%]")}>Due</th>
              <th className={cn(TH, "w-[19%]")}>Owner</th>
              <th className={cn(TH, "w-[15%]")}>Status</th>
              <th className={cn(TH, "w-14")}><span className="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-(--dash-rule)">
            {display.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-sm text-(--dash-ink-2)">
                  {tasks.length === 0
                    ? "No tasks yet. Use New ▾ → Create task to assign the first one."
                    : filter === "OVERDUE"
                      ? "Nothing overdue. Every open task is on schedule."
                      : filter === "WEEK"
                        ? "Nothing due in the next seven days."
                        : "No tasks in this view."}
                </td>
              </tr>
            ) : (
              display.map((task) => (
                <TaskTableRow key={task.id} task={task} now={now} onUpdateStatus={updateStatus} onDelete={deleteTask} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > TASK_PAGE_SIZE && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full rounded-b-[7px] border-t border-(--dash-rule) px-6 py-2.5 text-left text-sm font-medium text-(--dash-blue) hover:bg-(--dash-paper)"
        >
          {showAll ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </section>
  );
}
