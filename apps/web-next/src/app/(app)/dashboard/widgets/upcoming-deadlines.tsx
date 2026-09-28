"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { WidgetShell, WidgetEmpty, WidgetError, WidgetLoading } from "./shell";

// Ported from upcoming-deadlines.js.
type TaskRow = {
  id: string;
  title: string;
  dueDate?: string;
  status?: string;
  deal?: { name?: string };
};

function colorForDue(dueDate: string) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { color: "var(--dash-red)", label: "Overdue", bg: "var(--dash-red-wash)" };
  if (days <= 2) return { color: "var(--dash-brass)", label: days === 0 ? "Today" : `In ${days}d`, bg: "var(--dash-brass-wash)" };
  if (days <= 7) return { color: "var(--dash-blue)", label: `In ${days}d`, bg: "var(--dash-wash)" };
  return { color: "var(--dash-ink-2)", label: `In ${days}d`, bg: "var(--dash-wash)" };
}

export function UpcomingDeadlinesWidget() {
  const [upcoming, setUpcoming] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ tasks?: TaskRow[] } | TaskRow[]>("/tasks?limit=100");
        if (cancelled) return;
        const tasks = Array.isArray(data) ? data : data.tasks || [];
        const cutoff = Date.now() + 14 * 86400000;
        const filtered = tasks
          .filter((t) => t.dueDate && t.status !== "COMPLETED" && new Date(t.dueDate).getTime() <= cutoff)
          .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
          .slice(0, 8);
        setUpcoming(filtered);
      } catch (err) {
        console.warn("[dashboard/upcoming-deadlines] failed to load tasks:", err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <WidgetShell title="Upcoming Deadlines" icon="event_upcoming">
      {error ? (
        <WidgetError message="Could not load deadlines" />
      ) : !upcoming ? (
        <WidgetLoading />
      ) : upcoming.length === 0 ? (
        <WidgetEmpty message="No upcoming deadlines" icon="event_available" />
      ) : (
        <ul className="flex flex-col divide-y divide-(--dash-rule)">
          {upcoming.map((t) => {
            const meta = colorForDue(t.dueDate!);
            const due = new Date(t.dueDate!);
            return (
              <li key={t.id} className="flex items-center gap-4 px-5 py-3">
                <span className="flex w-9 shrink-0 flex-col items-center leading-none">
                  <span className="dash-label text-[0.625rem]">{due.toLocaleDateString("en-US", { month: "short" })}</span>
                  <span className="dash-figure text-xl text-(--dash-ink)">{due.getDate()}</span>
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-(--dash-ink) truncate">{t.title}</span>
                  {t.deal?.name && <span className="block text-xs text-(--dash-ink-3) truncate">{t.deal.name}</span>}
                </span>
                <span
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wider"
                  style={{ background: meta.bg, color: meta.color }}
                >
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}
