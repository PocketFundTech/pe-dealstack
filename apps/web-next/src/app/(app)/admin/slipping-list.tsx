"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Menu } from "@/components/dash/menu";
import { Avatar } from "@/components/dash/avatar";
import { stageLabel } from "../dashboard/components";
import { dealContact, type SlipItem } from "./admin-logic";
import type { ActionPrefill } from "./form-primitives";
import type { AdminTask, AdminTeamMember } from "./types";

const VISIBLE = 6;

const KIND: Record<SlipItem["kind"], { label: string; tone: string }> = {
  overdue: { label: "Overdue", tone: "text-(--dash-red) bg-(--dash-red-wash)" },
  unowned: { label: "No owner", tone: "text-(--dash-blue) bg-(--dash-wash)" },
  stale: { label: "Going stale", tone: "text-(--dash-ink-2) bg-(--dash-wash)" },
};

const plainTitle = (t: AdminTask) => t.title.replace(/^\[Review\]\s*/, "Review: ");
const nameOf = (members: AdminTeamMember[], id?: string) => members.find((m) => m.id === id)?.name;

const GHOST = "dash-btn-ghost flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold";

interface Props {
  items: SlipItem[];
  members: AdminTeamMember[];
  canManage: boolean;
  onOpenAction: (kind: "assign" | "reminder", prefill: ActionPrefill) => void;
  onReassign: (task: AdminTask, member: AdminTeamMember) => void;
}

export function SlippingList({ items, members, canManage, onOpenAction, onReassign }: Props) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, VISIBLE);

  return (
    <section id="slipping" aria-labelledby="slipping-heading" className="dash-panel relative z-10 scroll-mt-6">
      <header className="flex items-baseline justify-between gap-4 px-6 pt-5 pb-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 id="slipping-heading" className="dash-display text-xl text-(--dash-ink)">Slipping</h2>
          {items.length > 0 && (
            <span className="dash-num rounded-full bg-(--dash-blue) px-2 py-px text-xs font-semibold text-(--dash-panel)">{items.length}</span>
          )}
        </div>
        <span className="hidden text-xs text-(--dash-ink-3) md:inline">Across the whole team</span>
      </header>

      {items.length === 0 ? (
        <div className="flex items-center gap-4 border-t border-(--dash-rule) px-6 py-6">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-(--dash-wash) text-(--dash-green)">
            <span aria-hidden className="material-symbols-outlined text-[20px]">done_all</span>
          </span>
          <div className="text-sm">
            <p className="font-semibold text-(--dash-ink)">Nothing is slipping.</p>
            <p className="text-(--dash-ink-2)">No overdue tasks, every live deal has an owner, and all of them moved in the last two weeks.</p>
          </div>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-(--dash-rule) border-t border-(--dash-rule) [&>li:last-child]:rounded-b-[7px]">
            {shown.map((item) => {
              const meta = KIND[item.kind];
              let title: React.ReactNode;
              let detail: React.ReactNode;
              let actions: React.ReactNode;

              if (item.kind === "overdue") {
                const t = item.task;
                const who = t.assignee?.name || nameOf(members, t.assignedTo);
                title = t.deal ? <Link href={`/deals/${t.deal.id}`} className="hover:text-(--dash-blue)">{plainTitle(t)}</Link> : plainTitle(t);
                detail = (
                  <>
                    <span className="text-(--dash-red)">{item.days === 1 ? "1 day overdue" : `${item.days} days overdue`}</span>
                    {" · "}{who ?? <span className="text-(--dash-blue)">Unassigned</span>}
                    {t.deal && <> · {t.deal.name}</>}
                  </>
                );
                actions = (
                  <>
                    {t.assignedTo && (
                      <button
                        type="button"
                        className={GHOST}
                        onClick={() => onOpenAction("reminder", {
                          userId: t.assignedTo,
                          dealId: t.dealId || t.deal?.id,
                          message: `Quick nudge: “${plainTitle(t)}” was due ${item.days === 1 ? "yesterday" : `${item.days} days ago`}. Can you update it, or let me know what's blocking it?`,
                        })}
                      >
                        <span aria-hidden className="material-symbols-outlined text-[16px]">notifications</span>
                        <span className="hidden sm:inline">Nudge</span>
                      </button>
                    )}
                    {canManage && (
                      <Menu
                        heading="Reassign to"
                        triggerClassName={GHOST}
                        trigger={<><span className="hidden sm:inline">Reassign</span><span aria-hidden className="material-symbols-outlined text-[16px]">expand_more</span></>}
                        triggerLabel="Reassign task"
                        items={members.filter((m) => m.id !== t.assignedTo).map((m) => ({
                          key: m.id,
                          label: <span className="flex items-center gap-2"><Avatar name={m.name || m.email} size={22} />{m.name || m.email}</span>,
                          onSelect: () => onReassign(t, m),
                        }))}
                      />
                    )}
                  </>
                );
              } else {
                const d = item.deal;
                const owner = d.assignedUser?.name;
                title = <Link href={`/deals/${d.id}`} className="hover:text-(--dash-blue)">{d.name}</Link>;
                if (item.kind === "unowned") {
                  detail = <>{stageLabel(d.stage)}{d.priority === "HIGH" || d.priority === "URGENT" ? ` · ${d.priority === "URGENT" ? "Urgent" : "High"} priority` : ""} · nobody is accountable</>;
                  actions = canManage ? (
                    <button type="button" className={GHOST} onClick={() => onOpenAction("assign", { dealId: d.id })}>
                      Assign<span aria-hidden className="material-symbols-outlined text-[16px]">arrow_forward</span>
                    </button>
                  ) : (
                    <Link href={`/deals/${d.id}`} className={GHOST}>Open</Link>
                  );
                } else {
                  const contact = dealContact(d);
                  detail = <>No update in {item.days} days · {stageLabel(d.stage)}{owner ? ` · ${owner}` : ""}</>;
                  actions = (
                    <>
                      {contact && (
                        <button
                          type="button"
                          className={GHOST}
                          onClick={() => onOpenAction("reminder", {
                            userId: contact,
                            dealId: d.id,
                            message: `${d.name} hasn't been updated in ${item.days} days. Can you post a quick status update on the deal?`,
                          })}
                        >
                          <span aria-hidden className="material-symbols-outlined text-[16px]">notifications</span>
                          <span className="hidden sm:inline">Nudge owner</span>
                        </button>
                      )}
                      <Link href={`/deals/${d.id}`} className={GHOST} aria-label={`Open ${d.name}`}>
                        <span aria-hidden className="material-symbols-outlined text-[16px]">arrow_forward</span>
                      </Link>
                    </>
                  );
                }
              }

              return (
                <li key={item.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-3 transition-colors hover:bg-(--dash-paper) sm:grid-cols-[auto_1fr_auto] sm:px-6">
                  <span className={cn("hidden w-[5.75rem] rounded-sm px-1.5 py-0.5 text-center text-[0.625rem] font-bold uppercase tracking-wider sm:block", meta.tone)}>
                    {meta.label}
                  </span>
                  <div className="min-w-0">
                    <p className={cn("text-[0.625rem] font-bold uppercase tracking-wider sm:hidden", meta.tone.split(" ")[0])}>{meta.label}</p>
                    <p className="truncate text-sm font-medium text-(--dash-ink)">{title}</p>
                    <p className="truncate text-xs text-(--dash-ink-3)">{detail}</p>
                  </div>
                  <div className="flex items-center gap-1.5">{actions}</div>
                </li>
              );
            })}
          </ul>
          {items.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full rounded-b-[7px] border-t border-(--dash-rule) px-6 py-2.5 text-left text-sm font-medium text-(--dash-blue) hover:bg-(--dash-paper)"
            >
              {expanded ? "Show less" : `Show ${items.length - VISIBLE} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
