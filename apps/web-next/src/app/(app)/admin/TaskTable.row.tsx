"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/dash/avatar";
import { Menu } from "@/components/dash/menu";
import { isOverdue, isReview, taskDueText } from "./admin-logic";
import type { AdminTask, AdminTaskStatus } from "./types";
import { PriorityTag, STATUS_OPTIONS, StatusBadge } from "./TaskTable.helpers";

const TONE = {
  red: "font-medium text-(--dash-red)",
  brass: "font-medium text-(--dash-brass)",
  ink: "text-(--dash-ink)",
  muted: "text-(--dash-ink-3)",
} as const;

export const TD = "px-4 py-3 align-middle first:pl-6 last:pr-6";

/** One task row. Status changes via a small menu; delete confirms inline. */
export function TaskTableRow({
  task,
  now,
  onUpdateStatus,
  onDelete,
}: {
  task: AdminTask;
  now: number;
  onUpdateStatus: (task: AdminTask, status: AdminTaskStatus) => void;
  onDelete: (task: AdminTask) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const due = taskDueText(task, now);
  const review = isReview(task);
  const title = review ? task.title.replace(/^\[Review\]\s*/, "") : task.title;
  const who = task.assignee?.name || task.assignee?.email?.split("@")[0];

  return (
    <tr className={cn("group transition-colors hover:bg-(--dash-paper)", isOverdue(task, now) && "bg-(--dash-red-wash)/40")}>
      <td className={TD}>
        <div className="flex min-w-0 items-center gap-2">
          {review && (
            <span className="shrink-0 rounded-sm bg-(--dash-wash) px-1.5 py-px text-[0.625rem] font-bold uppercase tracking-wider text-(--dash-blue)">Review</span>
          )}
          <span className="truncate font-medium text-(--dash-ink)" title={title}>{title}</span>
        </div>
        {task.deal && (
          <Link href={`/deals/${task.deal.id}`} className="mt-0.5 block truncate text-xs text-(--dash-ink-3) hover:text-(--dash-blue) hover:underline" title={task.deal.name}>
            {task.deal.name}
          </Link>
        )}
      </td>
      <td className={TD}><PriorityTag priority={task.priority} /></td>
      <td className={cn(TD, "whitespace-nowrap text-[0.8125rem]", TONE[due.tone])}>{due.text}</td>
      <td className={TD}>
        {who ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={task.assignee?.name || task.assignee?.email || "?"} size={24} />
            <span className="truncate text-(--dash-ink-2)">{who}</span>
          </span>
        ) : (
          <span className="text-xs font-medium text-(--dash-blue)">Unassigned</span>
        )}
      </td>
      <td className={TD}>
        <Menu
          align="right"
          heading="Set status"
          triggerLabel={`Change status of ${title}`}
          triggerClassName="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-(--dash-wash)"
          trigger={<><StatusBadge status={task.status} /><span aria-hidden className="material-symbols-outlined text-[16px] text-(--dash-ink-3)">expand_more</span></>}
          items={STATUS_OPTIONS.filter((s) => s !== task.status).map((s) => ({
            key: s,
            label: <StatusBadge status={s} />,
            onSelect: () => onUpdateStatus(task, s),
          }))}
        />
      </td>
      <td className={cn(TD, "text-right")}>
        {confirming ? (
          <span className="flex items-center justify-end gap-1 whitespace-nowrap">
            <button type="button" onClick={() => { setConfirming(false); onDelete(task); }} className="rounded-md bg-(--dash-red) px-2 py-1 text-xs font-semibold text-(--dash-panel)">
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-xs font-medium text-(--dash-ink-2) hover:bg-(--dash-wash)">
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${title}`}
            className="grid size-8 place-items-center rounded-md text-(--dash-ink-3) transition-opacity hover:bg-(--dash-red-wash) hover:text-(--dash-red) pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
          >
            <span aria-hidden className="material-symbols-outlined text-[18px]">delete</span>
          </button>
        )}
      </td>
    </tr>
  );
}
