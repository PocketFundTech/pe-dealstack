"use client";

import { cn } from "@/lib/cn";
import { Menu, type MenuItem } from "@/components/dash/menu";

type ActionKind = "assign" | "task" | "review" | "reminder";

interface Props {
  now: number;
  people: number;
  liveDeals: number;
  overdue: number;
  unowned: number;
  slipping: number;
  lastUpdated: number;
  refreshing: boolean;
  canManage: boolean;
  onRefresh: () => void;
  onJump: (target: "team" | "tasks-overdue" | "slipping") => void;
  onNew: (kind: ActionKind) => void;
}

function updatedLabel(last: number, now: number): string {
  const mins = Math.floor((now - last) / 60_000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins} min ago`;
  return `Updated ${Math.floor(mins / 60)}h ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const JUMP = "underline decoration-(--dash-rule-strong) underline-offset-4 hover:decoration-(--dash-blue)";

export function AdminMasthead(p: Props) {
  const today = new Date(p.now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const items: MenuItem[] = [
    ...(p.canManage
      ? [
          { key: "assign", icon: "add_business", label: "Assign a deal", onSelect: () => p.onNew("assign") },
          { key: "task", icon: "add_task", label: "Create a task", onSelect: () => p.onNew("task") },
        ]
      : []),
    { key: "review", icon: "event", label: "Schedule a review", onSelect: () => p.onNew("review") },
    { key: "reminder", icon: "notifications", label: "Send a reminder", onSelect: () => p.onNew("reminder") },
  ];

  return (
    <header className="relative z-20 flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <p className="dash-label">{today}</p>
          <h1 className="dash-display mt-2 text-[1.75rem] leading-[1.1] text-(--dash-ink) md:text-[2.125rem]">Command Center</h1>
          <p className="mt-2 max-w-[70ch] text-[0.9375rem] text-(--dash-ink-2)">
            <button type="button" onClick={() => p.onJump("team")} className={JUMP}>{plural(p.people, "person", "people")}</button>
            {" · "}{plural(p.liveDeals, "live deal")}
            {" · "}
            {p.overdue > 0 ? (
              <button type="button" onClick={() => p.onJump("tasks-overdue")} className={cn(JUMP, "font-semibold text-(--dash-red)")}>
                {plural(p.overdue, "task")} overdue
              </button>
            ) : (
              <span>nothing overdue</span>
            )}
            {p.unowned > 0 && (
              <>
                {" · "}
                <button type="button" onClick={() => p.onJump("slipping")} className={cn(JUMP, "font-semibold text-(--dash-ink)")}>
                  {plural(p.unowned, "deal")} without an owner
                </button>
              </>
            )}
            {p.slipping === 0 && <span className="text-(--dash-green)"> · all on track</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={p.onRefresh}
            disabled={p.refreshing}
            aria-label="Refresh Command Center"
            className="mr-1 flex items-center gap-1.5 rounded-md px-2 py-2 text-xs text-(--dash-ink-3) transition-colors hover:text-(--dash-blue) disabled:opacity-60"
          >
            <span aria-hidden className={cn("material-symbols-outlined text-[16px]", p.refreshing && "animate-spin")}>refresh</span>
            <span className="hidden sm:inline">{p.refreshing ? "Refreshing…" : updatedLabel(p.lastUpdated, p.now)}</span>
          </button>
          <Menu
            items={items}
            triggerClassName="dash-btn-primary flex items-center gap-1 rounded-md py-2 pl-3 pr-2.5 text-sm font-semibold"
            trigger={<><span aria-hidden className="material-symbols-outlined text-[18px]">add</span>New<span aria-hidden className="material-symbols-outlined text-[18px]">expand_more</span></>}
          />
        </div>
      </div>
      <div className="dash-double-rule" />
    </header>
  );
}
