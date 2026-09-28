"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Deal, Task } from "./components";
import { stageLabel } from "./components";
import { AssignMenu } from "./assign-menu";
import { daysSince, dueLabel, SNOOZE_DAYS, type QueueItem, type QueueKind } from "./triage";
import type { TeamMember } from "./use-dashboard-data";

const VISIBLE = 6;

const KIND_META: Record<QueueKind, { label: string; tone: string; ink: string }> = {
  overdue: { label: "Overdue", tone: "text-(--dash-red) bg-(--dash-red-wash)", ink: "text-(--dash-red)" },
  "due-today": { label: "Due today", tone: "text-(--dash-brass) bg-(--dash-brass-wash)", ink: "text-(--dash-brass)" },
  unowned: { label: "No owner", tone: "text-(--dash-blue) bg-(--dash-wash)", ink: "text-(--dash-blue)" },
  stale: { label: "Going stale", tone: "text-(--dash-ink-2) bg-(--dash-wash)", ink: "text-(--dash-ink-3)" },
};

interface TodayQueueProps {
  items: QueueItem[];
  loading: boolean;
  error: boolean;
  now: number;
  nextTask: Task | null;
  onRetry: () => void;
  onComplete: (task: Task) => void;
  onSnooze: (item: QueueItem) => void;
  onAssign: (deal: Deal, member: TeamMember) => void;
  loadTeam: () => Promise<TeamMember[]>;
}

function IconAction({ icon, label, onClick, className }: { icon: string; label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-8 place-items-center rounded-md text-(--dash-ink-3) transition-colors hover:bg-(--dash-wash) hover:text-(--dash-ink)",
        className,
      )}
    >
      <span aria-hidden className="material-symbols-outlined text-[18px]">{icon}</span>
    </button>
  );
}

function QueueRow({ item, now, onComplete, onSnooze, onAssign, loadTeam }: {
  item: QueueItem;
  now: number;
} & Pick<TodayQueueProps, "onComplete" | "onSnooze" | "onAssign" | "loadTeam">) {
  const meta = KIND_META[item.kind];
  const snoozeLabel = SNOOZE_DAYS[item.kind] === 1 ? "Snooze until tomorrow" : "Snooze for a week";

  let title: React.ReactNode;
  let detail: React.ReactNode;
  let href: string | null = null;
  let primary: React.ReactNode = null;

  if ("task" in item) {
    const t = item.task;
    const dealName = t.deal?.name || t.dealName;
    const dealId = t.deal?.id || t.dealId;
    href = dealId ? `/deals/${dealId}` : null;
    title = t.title;
    detail = (
      <>
        <span className={item.kind === "overdue" ? "text-(--dash-red)" : "text-(--dash-brass)"}>{dueLabel(t.dueDate!, now)}</span>
        {dealName && <> · {dealName}</>}
      </>
    );
    primary = (
      <button
        type="button"
        onClick={() => onComplete(t)}
        className="dash-btn-ghost flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold"
      >
        <span aria-hidden className="material-symbols-outlined text-[16px]">check</span>
        <span className="hidden sm:inline">Done</span>
      </button>
    );
  } else {
    const d = item.deal;
    href = `/deals/${d.id}`;
    title = d.name;
    if (item.kind === "stale") {
      detail = <>No update in {daysSince(d.updatedAt, now)} days · {stageLabel(d.stage)}{d.assignedUser?.name ? ` · ${d.assignedUser.name}` : ""}</>;
      primary = (
        <Link
          href={href}
          className="dash-btn-ghost flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold"
        >
          <span className="hidden sm:inline">Review</span>
          <span aria-hidden className="material-symbols-outlined text-[16px]">arrow_forward</span>
        </Link>
      );
    } else {
      detail = <>{stageLabel(d.stage)}{d.priority && d.priority !== "MEDIUM" ? ` · ${d.priority.charAt(0)}${d.priority.slice(1).toLowerCase()} priority` : ""} · nobody is accountable</>;
      primary = <AssignMenu loadTeam={loadTeam} onAssign={(m) => onAssign(d, m)} />;
    }
  }

  return (
    <li className="dash-row group grid grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-3 transition-colors hover:bg-(--dash-paper) sm:grid-cols-[auto_1fr_auto] sm:px-6">
      <span className={cn("hidden w-[5.75rem] rounded-sm px-1.5 py-0.5 text-center text-[0.625rem] font-bold uppercase tracking-wider sm:block", meta.tone)}>
        {meta.label}
      </span>
      <div className="min-w-0">
        <p className={cn("text-[0.625rem] font-bold uppercase tracking-wider sm:hidden", meta.ink)}>{meta.label}</p>
        {href ? (
          <Link href={href} className="block truncate text-sm font-medium text-(--dash-ink) hover:text-(--dash-blue)">
            {title}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium text-(--dash-ink)">{title}</p>
        )}
        <p className="truncate text-xs text-(--dash-ink-3)">{detail}</p>
      </div>
      <div className="flex items-center gap-1">
        {primary}
        <IconAction
          icon="snooze"
          label={snoozeLabel}
          onClick={() => onSnooze(item)}
          className="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
        />
      </div>
    </li>
  );
}

export function TodayQueue(props: TodayQueueProps) {
  const { items, loading, error, now, nextTask, onRetry } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, VISIBLE);
  const hidden = items.length - shown.length;

  return (
    <section aria-labelledby="today-heading" className="dash-panel relative z-10">
      <header className="flex items-baseline justify-between gap-4 px-6 pt-5 pb-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 id="today-heading" className="dash-display text-xl text-(--dash-ink)">Today</h2>
          {!loading && items.length > 0 && (
            <span className="dash-num rounded-full bg-(--dash-blue) px-2 py-px text-xs font-semibold text-(--dash-panel)">
              {items.length}
            </span>
          )}
        </div>
        {!loading && items.length > 0 && (
          <span className="hidden text-xs text-(--dash-ink-3) md:inline">Snoozed items come back on their own</span>
        )}
      </header>

      {loading ? (
        <ul className="divide-y divide-(--dash-rule) border-t border-(--dash-rule)">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="flex items-center gap-4 px-6 py-3.5">
              <Skeleton width={92} height={18} rounded="sm" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton.Line width={`${60 - i * 12}%`} height={13} />
                <Skeleton.Line width="35%" height={11} />
              </div>
              <Skeleton width={64} height={26} rounded="md" />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div className="flex items-center justify-between gap-4 border-t border-(--dash-rule) px-6 py-5 text-sm">
          <span className="text-(--dash-red)">Couldn&apos;t load today&apos;s items.</span>
          <button type="button" onClick={onRetry} className="dash-link">Retry</button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-4 border-t border-(--dash-rule) px-6 py-6">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-(--dash-wash) text-(--dash-green)">
            <span aria-hidden className="material-symbols-outlined text-[20px]">done_all</span>
          </span>
          <div className="text-sm">
            <p className="font-semibold text-(--dash-ink)">You&apos;re clear for today.</p>
            <p className="text-(--dash-ink-2)">
              {nextTask
                ? <>Next up: <span className="text-(--dash-ink)">{nextTask.title}</span>, {dueLabel(nextTask.dueDate!, now).toLowerCase()}.</>
                : "No deadlines coming up, and every live deal has an owner and recent activity."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <ul aria-live="polite" className="divide-y divide-(--dash-rule) border-t border-(--dash-rule) [&>li:last-child]:rounded-b-[7px]">
            {shown.map((item) => (
              <QueueRow key={item.key} item={item} {...props} />
            ))}
          </ul>
          {(hidden > 0 || expanded) && items.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full rounded-b-[7px] border-t border-(--dash-rule) px-6 py-2.5 text-left text-sm font-medium text-(--dash-blue) hover:bg-(--dash-paper)"
            >
              {expanded ? "Show less" : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
