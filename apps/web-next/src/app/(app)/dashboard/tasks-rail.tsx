"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Task } from "./components";
import { DAY_MS, dueLabel, isMyTask, isOpenTask, startOfDay, taskBucket, type TaskBucket } from "./triage";
import { WidgetShell } from "./widgets/shell";

const GROUPS: Array<{ key: TaskBucket; label: string }> = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "undated", label: "No date" },
];
const COLLAPSED_LIMIT = 6;

const DUE_CHIPS = [
  { key: "none", label: "No date", days: null },
  { key: "today", label: "Today", days: 0 },
  { key: "tomorrow", label: "Tomorrow", days: 1 },
  { key: "week", label: "Next week", days: 7 },
] as const;
type DueChip = (typeof DUE_CHIPS)[number]["key"];

interface TasksRailProps {
  tasks: Task[];
  userId?: string;
  loading: boolean;
  error: boolean;
  now: number;
  onRetry: () => void;
  onToggle: (task: Task) => void;
  onAdd: (input: { title: string; dueDate?: string }) => Promise<void>;
}

function TaskRow({ task, now, onToggle }: { task: Task; now: number; onToggle: (t: Task) => void }) {
  const done = !isOpenTask(task);
  const bucket = taskBucket(task, now);
  const dealName = task.deal?.name || task.dealName;
  const dealId = task.deal?.id || task.dealId;
  const pending = task.id.startsWith("temp-");
  const dueTone = bucket === "overdue" ? "text-(--dash-red)" : bucket === "today" ? "text-(--dash-brass)" : "text-(--dash-ink-3)";

  return (
    <li className={cn("group flex items-start gap-3 px-5 py-2.5 transition-colors hover:bg-(--dash-paper)", pending && "opacity-60")}>
      <input
        type="checkbox"
        checked={done}
        disabled={pending}
        onChange={() => onToggle(task)}
        aria-label={done ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
        className="mt-[3px] size-4 shrink-0 cursor-pointer accent-[#003366]"
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm leading-snug", done ? "text-(--dash-ink-3) line-through" : "text-(--dash-ink)")}>
          {task.title}
          {!done && (task.priority === "HIGH" || task.priority === "URGENT") && (
            <span className="ml-1.5 align-[1px] text-[0.625rem] font-bold uppercase tracking-wider text-(--dash-red)">High</span>
          )}
        </p>
        {(task.dueDate || dealName) && !done && (
          <p className="truncate text-xs text-(--dash-ink-3)">
            {task.dueDate && <span className={dueTone}>{dueLabel(task.dueDate, now)}</span>}
            {task.dueDate && dealName && " · "}
            {dealName && (dealId
              ? <Link href={`/deals/${dealId}`} className="hover:text-(--dash-blue) hover:underline">{dealName}</Link>
              : dealName)}
          </p>
        )}
      </div>
    </li>
  );
}

function AddTask({ onAdd, now }: { onAdd: TasksRailProps["onAdd"]; now: number }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<DueChip>("none");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = title.trim();
    if (!clean || saving) return;
    const days = DUE_CHIPS.find((c) => c.key === due)?.days;
    // Noon local keeps the date stable across timezones when stored as UTC.
    const dueDate = days == null ? undefined : new Date(startOfDay(now) + days * DAY_MS + 12 * 3_600_000).toISOString();
    setSaving(true);
    setTitle("");
    try {
      await onAdd({ title: clean, dueDate });
      setDue("none");
    } catch {
      setTitle(clean); // give the text back so nothing is lost
    } finally {
      setSaving(false);
      inputRef.current?.focus();
    }
  };

  return (
    <form onSubmit={submit} className="border-t border-(--dash-rule) px-5 py-3">
      <label className="flex items-center gap-2.5">
        <span aria-hidden className="material-symbols-outlined text-[18px] text-(--dash-ink-3)">add</span>
        <span className="sr-only">New task</span>
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={255}
          placeholder="Add a task…"
          className="min-w-0 flex-1 bg-transparent text-sm text-(--dash-ink) placeholder:text-(--dash-ink-3) focus:outline-none"
        />
        {title.trim() && (
          <button type="submit" disabled={saving} className="dash-btn-primary rounded-md px-2.5 py-1 text-xs font-semibold">
            Add
          </button>
        )}
      </label>
      {title.trim() && (
        <div role="radiogroup" aria-label="Due" className="dash-fade mt-2.5 flex flex-wrap gap-1.5 pl-7">
          {DUE_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={due === c.key}
              onClick={() => setDue(c.key)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                due === c.key
                  ? "border-(--dash-blue) bg-(--dash-blue) text-(--dash-panel)"
                  : "border-(--dash-rule-strong) text-(--dash-ink-2) hover:border-(--dash-blue-3)",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

export function TasksRail({ tasks, userId, loading, error, now, onRetry, onToggle, onAdd }: TasksRailProps) {
  const [showAll, setShowAll] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const mine = tasks.filter((t) => isMyTask(t, userId));
  const open = mine
    .filter(isOpenTask)
    .sort((a, b) => (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity));
  const done = mine.filter((t) => !isOpenTask(t));
  const visibleOpen = showAll ? open : open.slice(0, COLLAPSED_LIMIT);

  return (
    <WidgetShell
      title="My Tasks"
      headerRight={!loading && !error && (
        <span className="dash-num text-xs text-(--dash-ink-3)">
          <span className="font-semibold text-(--dash-ink)">{open.length}</span> open
        </span>
      )}
    >
      {loading ? (
        <div className="flex flex-col gap-3.5 px-5 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton width={16} height={16} rounded="sm" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton.Line width={`${80 - i * 8}%`} height={12} />
                <Skeleton.Line width="45%" height={10} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center justify-between px-5 py-5 text-sm">
          <span className="text-(--dash-red)">Couldn&apos;t load tasks.</span>
          <button type="button" onClick={onRetry} className="dash-link">Retry</button>
        </div>
      ) : (
        <>
          {open.length === 0 ? (
            <p className="px-5 py-5 text-sm text-(--dash-ink-2)">
              No open tasks. Add one below, or create tasks from any deal page.
            </p>
          ) : (
            <div className="py-1.5">
              {GROUPS.map((g) => {
                const items = visibleOpen.filter((t) => taskBucket(t, now) === g.key);
                if (items.length === 0) return null;
                return (
                  <div key={g.key}>
                    <p className={cn("dash-label px-5 pt-2.5 pb-1", g.key === "overdue" && "text-(--dash-red)")}>{g.label}</p>
                    <ul>{items.map((t) => <TaskRow key={t.id} task={t} now={now} onToggle={onToggle} />)}</ul>
                  </div>
                );
              })}
              {open.length > COLLAPSED_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="px-5 pt-1.5 pb-1 text-xs font-semibold text-(--dash-blue) hover:underline"
                >
                  {showAll ? "Show fewer" : `Show all ${open.length}`}
                </button>
              )}
            </div>
          )}

          {done.length > 0 && (
            <div className="border-t border-(--dash-rule)">
              <button
                type="button"
                aria-expanded={showDone}
                onClick={() => setShowDone((v) => !v)}
                className="flex w-full items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-(--dash-ink-3) hover:text-(--dash-ink)"
              >
                <span aria-hidden className={cn("material-symbols-outlined text-[16px] transition-transform", showDone && "rotate-90")}>chevron_right</span>
                <span className="dash-num">{done.length} done</span>
              </button>
              {showDone && (
                <ul className="dash-fade pb-1.5">
                  {done.slice(0, 10).map((t) => <TaskRow key={t.id} task={t} now={now} onToggle={onToggle} />)}
                </ul>
              )}
            </div>
          )}

          <AddTask onAdd={onAdd} now={now} />
        </>
      )}
    </WidgetShell>
  );
}
