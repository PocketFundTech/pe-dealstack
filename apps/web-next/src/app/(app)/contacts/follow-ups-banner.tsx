"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

// ─── Follow-ups Banner ─────────────────────────────────────
//
// Surfaces the `GET /contacts/insights/follow-ups` endpoint on the contacts
// list page. Previously this endpoint was never called — overdue badges were
// derived client-side and there was no upcoming view. This banner shows the
// server-computed overdue + upcoming follow-ups so a banker can act on them.

interface FollowUpContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  type?: string | null;
  company?: string | null;
  email?: string | null;
  followUpAt: string;
  followUpNote?: string | null;
  daysOverdue?: number;
  daysUntil?: number;
}

interface FollowUpsResponse {
  overdue: FollowUpContact[];
  upcoming: FollowUpContact[];
  counts: { overdue: number; upcoming: number };
  windowDays: number;
}

function contactName(c: FollowUpContact): string {
  const name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
  return name || c.email || "Unnamed contact";
}

function FollowUpItem({ c, kind, onOpen }: { c: FollowUpContact; kind: "overdue" | "upcoming"; onOpen: (id: string) => void }) {
  const overdue = kind === "overdue";
  const timing = overdue
    ? c.daysOverdue === 0
      ? "Due today"
      : `${c.daysOverdue}d overdue`
    : c.daysUntil === 0
      ? "Due today"
      : `in ${c.daysUntil}d`;
  return (
    <button
      onClick={() => onOpen(c.id)}
      className="flex items-center justify-between gap-3 w-full text-left px-3 py-2 rounded-lg bg-surface-card border border-border-subtle hover:border-primary/30 hover:shadow-sm transition-all"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main truncate">{contactName(c)}</p>
        <p className="text-xs text-text-muted truncate">
          {c.company ? `${c.company} · ` : ""}
          {c.followUpNote || "Follow up"}
        </p>
      </div>
      <span
        className={cn(
          "shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold",
          overdue ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"
        )}
      >
        {timing}
      </span>
    </button>
  );
}

export function FollowUpsBanner({ onOpenContact }: { onOpenContact: (id: string) => void }) {
  const [data, setData] = useState<FollowUpsResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<FollowUpsResponse>("/contacts/insights/follow-ups")
      .then((res) => { if (active) setData(res); })
      .catch((err) => { console.warn("[contacts] follow-ups load failed:", err); });
    return () => { active = false; };
  }, []);

  if (!data || dismissed) return null;
  const { overdue, upcoming, counts, windowDays } = data;
  if (counts.overdue === 0 && counts.upcoming === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-amber-600 text-[20px]">notifications_active</span>
          <h2 className="text-sm font-bold text-text-main">Follow-ups due</h2>
          {counts.overdue > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[11px] font-bold">
              {counts.overdue} overdue
            </span>
          )}
          {counts.upcoming > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">
              {counts.upcoming} upcoming · next {windowDays}d
            </span>
          )}
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Dismiss"
          aria-label="Dismiss follow-ups"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {overdue.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-bold text-red-600 uppercase tracking-wider">Overdue</p>
            <div className="flex flex-col gap-1.5">
              {overdue.map((c) => <FollowUpItem key={c.id} c={c} kind="overdue" onOpen={onOpenContact} />)}
            </div>
          </div>
        )}
        {upcoming.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Upcoming</p>
            <div className="flex flex-col gap-1.5">
              {upcoming.map((c) => <FollowUpItem key={c.id} c={c} kind="upcoming" onOpen={onOpenContact} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
