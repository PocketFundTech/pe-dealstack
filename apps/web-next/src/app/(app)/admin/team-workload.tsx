"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/dash/avatar";
import { Menu, type MenuItem } from "@/components/dash/menu";
import { dealNameSummary, type MemberLoad } from "./admin-logic";
import type { ActionPrefill } from "./form-primitives";

const COLLAPSED = 8;
type ActionKind = "assign" | "task" | "reminder";

const TH = "dash-label whitespace-nowrap px-4 py-2.5 text-left font-semibold first:pl-6 last:pr-6";
const TD = "px-4 py-3 first:pl-6 last:pr-6";

/**
 * One row per person: live deals, open tasks, overdue, and a load bar scaled
 * to the busiest teammate (so "full" means "busiest on this team", not an
 * arbitrary deals ÷ 5). The ⋯ menu opens the action sheet pre-filled.
 */
export function TeamWorkload({ rows, canManage, onOpenAction }: {
  rows: MemberLoad[];
  canManage: boolean;
  onOpenAction: (kind: ActionKind, prefill: ActionPrefill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, COLLAPSED);
  const idle = rows.filter((r) => r.tag === "idle").length;
  const stretched = rows.filter((r) => r.tag === "stretched").length;

  if (rows.length === 0) {
    return (
      <section id="team" className="dash-panel scroll-mt-6 px-6 py-6">
        <h2 className="dash-display text-xl text-(--dash-ink)">Team workload</h2>
        <p className="mt-2 text-sm text-(--dash-ink-2)">
          Nobody else is on your workspace yet. <Link href="/settings" className="dash-link">Invite your team</Link> to start assigning deals.
        </p>
      </section>
    );
  }

  return (
    <section id="team" aria-labelledby="team-heading" className="dash-panel scroll-mt-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 pt-5 pb-3.5">
        <h2 id="team-heading" className="dash-display text-xl text-(--dash-ink)">Team workload</h2>
        <p className="dash-num text-xs text-(--dash-ink-3)">
          {stretched > 0 && <><span className="font-semibold text-(--dash-red)">{stretched} stretched</span> · </>}
          {idle > 0 && <><span className="font-semibold text-(--dash-ink)">{idle} idle</span> · </>}
          Load is relative to the busiest person
        </p>
      </header>

      <div className="border-t border-(--dash-rule) max-md:overflow-x-auto">
        <table className="w-full min-w-[680px] table-fixed text-sm">
          <thead>
            <tr className="border-b border-(--dash-rule) bg-(--dash-paper)">
              <th className={cn(TH, "w-[34%]")}>Person</th>
              <th className={cn(TH, "w-[10%] text-right")}>Deals</th>
              <th className={cn(TH, "w-[13%] text-right")}>Open tasks</th>
              <th className={cn(TH, "w-[12%] text-right")}>Overdue</th>
              <th className={TH}>Load</th>
              <th className={cn(TH, "w-14")}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-(--dash-rule)">
            {shown.map((r) => {
              const m = r.member;
              const label = m.name || m.email;
              const first = label.split(" ")[0];
              const names = dealNameSummary(r.deals);
              const items: MenuItem[] = [
                ...(canManage
                  ? [
                      { key: "assign", icon: "add_business", label: `Assign a deal to ${first}`, onSelect: () => onOpenAction("assign", { userId: m.id }) },
                      { key: "task", icon: "add_task", label: `Create a task for ${first}`, onSelect: () => onOpenAction("task", { userId: m.id }) },
                    ]
                  : []),
                { key: "remind", icon: "notifications", label: `Send ${first} a reminder`, onSelect: () => onOpenAction("reminder", { userId: m.id }) },
              ];
              const barTone = r.tag === "stretched" ? "var(--dash-red)" : r.loadPct >= 60 ? "var(--dash-blue)" : "var(--dash-blue-3)";
              return (
                <tr key={m.id} className="group transition-colors hover:bg-(--dash-paper)">
                  <td className={TD}>
                    <div className="flex items-center gap-3">
                      <Avatar name={label} size={32} />
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 truncate font-semibold text-(--dash-ink)">
                          <span className="truncate">{label}</span>
                          {r.tag && (
                            <span className={cn(
                              "shrink-0 rounded-sm px-1.5 py-px text-[0.625rem] font-bold uppercase tracking-wider",
                              r.tag === "stretched" ? "bg-(--dash-red-wash) text-(--dash-red)" : "bg-(--dash-wash) text-(--dash-ink-3)",
                            )}>
                              {r.tag === "stretched" ? "Stretched" : "Idle"}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-(--dash-ink-3)" title={names.join(", ")}>
                          {names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : (m.title || m.role || "").toString().toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) || "No live deals"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, "dash-num text-right text-(--dash-ink)")}>{r.deals.length || <span className="text-(--dash-ink-3)">—</span>}</td>
                  <td className={cn(TD, "dash-num text-right text-(--dash-ink)")}>{r.openTasks || <span className="text-(--dash-ink-3)">—</span>}</td>
                  <td className={cn(TD, "dash-num text-right")}>
                    {r.overdue ? <span className="font-semibold text-(--dash-red)">{r.overdue}</span> : <span className="text-(--dash-ink-3)">—</span>}
                  </td>
                  <td className={TD}>
                    <div className="flex items-center gap-3">
                      <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-(--dash-wash)" aria-hidden>
                        {r.loadPct > 0 && <span className="dash-bar block h-full rounded-full" style={{ width: `${r.loadPct}%`, background: barTone }} />}
                      </span>
                      <span className="dash-num w-9 text-right text-xs text-(--dash-ink-3)">{r.loadPct}%</span>
                    </div>
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <Menu
                      triggerLabel={`Actions for ${label}`}
                      triggerClassName="grid size-8 place-items-center rounded-md text-(--dash-ink-3) hover:bg-(--dash-wash) hover:text-(--dash-ink)"
                      trigger={<span aria-hidden className="material-symbols-outlined text-[20px]">more_horiz</span>}
                      items={items}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full rounded-b-[7px] border-t border-(--dash-rule) px-6 py-2.5 text-left text-sm font-medium text-(--dash-blue) hover:bg-(--dash-paper)"
        >
          {expanded ? "Show fewer" : `Show all ${rows.length} people`}
        </button>
      )}
    </section>
  );
}
