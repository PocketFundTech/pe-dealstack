"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { dayOffset, dueLabel } from "../dashboard/triage";
import { isOpen, isReview } from "./admin-logic";
import type { AdminTask } from "./types";

interface Props {
  tasks: AdminTask[];
  now: number;
  onScheduleClick: () => void;
}

// "Reviews" are tasks with a "[Review]" prefix (legacy convention, kept so
// existing reviews still show). Soonest first, up to 4.
export function UpcomingReviews({ tasks, now, onScheduleClick }: Props) {
  const reviews = tasks
    .filter((t) => isReview(t) && isOpen(t))
    .sort((a, b) => (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity))
    .slice(0, 4);

  return (
    <section aria-labelledby="reviews-heading" className="dash-panel">
      <header className="flex items-center justify-between gap-3 border-b border-(--dash-rule) px-5 pt-4 pb-3">
        <h3 id="reviews-heading" className="dash-display text-lg text-(--dash-ink)">Upcoming reviews</h3>
        <button type="button" onClick={onScheduleClick} className="dash-link text-xs">+ Schedule</button>
      </header>

      {reviews.length === 0 ? (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2)">
          No reviews on the calendar. Schedule an IC or pipeline review and it will show here and in the reviewer&apos;s tasks.
        </p>
      ) : (
        <ul className="divide-y divide-(--dash-rule)">
          {reviews.map((r) => {
            const title = r.title.replace(/^\[Review\]\s*/, "");
            const date = r.dueDate ? new Date(r.dueDate) : null;
            const late = !!r.dueDate && dayOffset(r.dueDate, now) < 0;
            const who = r.assignee?.name || r.assignee?.email?.split("@")[0];
            return (
              <li key={r.id} className="flex items-center gap-4 px-5 py-3">
                <span
                  className={cn(
                    "flex w-11 shrink-0 flex-col items-center rounded-md border py-1 leading-none",
                    late ? "border-(--dash-red-wash) bg-(--dash-red-wash) text-(--dash-red)" : "border-(--dash-rule) text-(--dash-ink)",
                  )}
                >
                  <span className="text-[0.625rem] font-bold uppercase tracking-wider">
                    {date ? date.toLocaleDateString("en-US", { month: "short" }) : "TBD"}
                  </span>
                  <span className="dash-figure text-lg">{date ? date.getDate() : "—"}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-(--dash-ink)">
                    {r.deal ? <Link href={`/deals/${r.deal.id}`} className="hover:text-(--dash-blue)">{title}</Link> : title}
                  </p>
                  <p className="truncate text-xs text-(--dash-ink-3)">
                    {r.dueDate && <span className={late ? "font-medium text-(--dash-red)" : undefined}>{dueLabel(r.dueDate, now)}</span>}
                    {who && ` · ${who}`}
                    {r.deal && ` · ${r.deal.name}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
