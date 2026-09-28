"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/formatters";
import { Skeleton } from "@/components/ui/Skeleton";
import { type Deal, fmtNextAction, stageLabel, stageStep, STAGE_STEP_COUNT } from "./components";
import { Avatar } from "./assign-menu";
import { isLiveDeal, isStale, isUnowned, priorityRank, touchLabel } from "./triage";

const ROWS = 6;

type TabKey = "priority" | "attention" | "recent";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "priority", label: "By priority" },
  { key: "attention", label: "Needs attention" },
  { key: "recent", label: "Recently updated" },
];

const byRecent = (a: Deal, b: Deal) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

function rowsFor(tab: TabKey, deals: Deal[], now: number): Deal[] {
  const live = deals.filter(isLiveDeal);
  if (tab === "recent") return [...live].sort(byRecent);
  if (tab === "attention") {
    return live
      .filter((d) => isStale(d, now) || isUnowned(d))
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  }
  return [...live].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byRecent(a, b));
}

function StageTicks({ stage }: { stage: string }) {
  const step = stageStep(stage);
  if (!step) return null;
  return (
    <span className="flex gap-0.5" aria-label={`Step ${step} of ${STAGE_STEP_COUNT}`}>
      {Array.from({ length: STAGE_STEP_COUNT }).map((_, i) => (
        <span
          key={i}
          className="h-[3px] w-2.5 rounded-full"
          style={{ background: i < step ? "var(--dash-blue)" : "var(--dash-rule)" }}
        />
      ))}
    </span>
  );
}

const TH = "dash-label whitespace-nowrap px-4 py-2.5 text-left font-semibold first:pl-6 last:pr-6";
const TD = "px-4 py-3 first:pl-6 last:pr-6";

export function PrioritiesTable({ deals, loading, error, now, onRetry }: {
  deals: Deal[];
  loading: boolean;
  error: boolean;
  now: number;
  onRetry: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("priority");
  const rows = rowsFor(tab, deals, now);
  const liveCount = deals.filter(isLiveDeal).length;
  const attentionCount = rowsFor("attention", deals, now).length;

  return (
    <section aria-labelledby="priorities-heading" className="dash-panel overflow-hidden">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-6 pt-5">
        <h2 id="priorities-heading" className="dash-display pb-3 text-xl text-(--dash-ink)">Active Priorities</h2>
        <div role="tablist" aria-label="Sort priorities" className="-mb-px flex gap-5">
          {TABS.map((t) => {
            const selected = tab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 pb-3 text-[0.8125rem] font-medium transition-colors",
                  selected ? "border-(--dash-blue) text-(--dash-ink)" : "border-transparent text-(--dash-ink-3) hover:text-(--dash-ink)",
                )}
              >
                {t.label}
                {t.key === "attention" && !loading && attentionCount > 0 && (
                  <span className="dash-num rounded-full bg-(--dash-brass-wash) px-1.5 text-[0.6875rem] font-semibold text-(--dash-brass)">
                    {attentionCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      <div role="tabpanel" className="overflow-x-auto border-t border-(--dash-rule)">
        <table className="w-full min-w-[840px] table-fixed text-sm">
          <thead>
            <tr className="border-b border-(--dash-rule) bg-(--dash-paper)">
              <th className={cn(TH, "w-[29%]")}>Deal</th>
              <th className={cn(TH, "w-[14%]")}>Stage</th>
              <th className={cn(TH, "w-[9%]")}>Owner</th>
              <th className={cn(TH, "w-[10%]")}>Updated</th>
              <th className={TH}>Next action</th>
              <th className={cn(TH, "w-[12%] text-right")}>Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-(--dash-rule)">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td className={TD}><div className="flex flex-col gap-1.5"><Skeleton.Line width="70%" height={13} /><Skeleton.Line width="40%" height={11} /></div></td>
                  <td className={TD}><Skeleton.Line width={90} height={12} /></td>
                  <td className={TD}><Skeleton.Circle size={26} /></td>
                  <td className={TD}><Skeleton.Line width={56} height={12} /></td>
                  <td className={TD}><Skeleton.Line width="80%" height={12} /></td>
                  <td className={TD}><Skeleton.Line width={60} height={13} className="ml-auto" /></td>
                </tr>
              ))
            ) : error ? (
              <tr><td colSpan={6} className="px-6 py-6">
                <span className="text-(--dash-red)">Couldn&apos;t load deals.</span>{" "}
                <button type="button" onClick={onRetry} className="dash-link">Retry</button>
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-8 text-(--dash-ink-2)">
                {tab === "attention"
                  ? "Every live deal has an owner and has been touched in the last two weeks."
                  : <>No live deals yet. <Link href="/deals" className="dash-link">Add one to your pipeline</Link>.</>}
              </td></tr>
            ) : rows.slice(0, ROWS).map((deal) => {
              const stale = isStale(deal, now);
              const owners = [deal.assignedUser, ...(deal.teamMembers?.map((m) => m.user) ?? [])]
                .filter((u): u is NonNullable<typeof u> => Boolean(u))
                .filter((u, i, all) => all.findIndex((x) => (x.id ?? x.name) === (u.id ?? u.name)) === i);
              const urgent = deal.priority === "HIGH" || deal.priority === "URGENT";
              return (
                <tr
                  key={deal.id}
                  onClick={() => router.push(`/deals/${deal.id}`)}
                  className="group cursor-pointer transition-colors hover:bg-(--dash-paper)"
                >
                  <td className={TD}>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/deals/${deal.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate font-semibold text-(--dash-ink) group-hover:text-(--dash-blue)"
                      >
                        {deal.name}
                      </Link>
                      {urgent && (
                        <span className="shrink-0 rounded-sm bg-(--dash-brass-wash) px-1.5 py-px text-[0.625rem] font-bold uppercase tracking-wider text-(--dash-brass)">
                          {deal.priority === "URGENT" ? "Urgent" : "High"}
                        </span>
                      )}
                    </div>
                    {deal.industry && <div className="mt-0.5 truncate text-xs text-(--dash-ink-3)">{deal.industry}</div>}
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-1.5">
                      <span className="whitespace-nowrap text-[0.8125rem] text-(--dash-ink)">{stageLabel(deal.stage)}</span>
                      <StageTicks stage={deal.stage} />
                    </div>
                  </td>
                  <td className={TD}>
                    {owners.length === 0 ? (
                      <span className="text-xs font-medium text-(--dash-blue)">Unassigned</span>
                    ) : (
                      <div className="flex -space-x-1.5">
                        {owners.slice(0, 3).map((m, i) => <Avatar key={i} name={m.name || m.email || "?"} size={26} />)}
                      </div>
                    )}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <span className={cn("dash-num text-[0.8125rem]", stale ? "font-medium text-(--dash-brass)" : "text-(--dash-ink-2)")}>
                      {touchLabel(deal.updatedAt, now)}
                    </span>
                  </td>
                  <td className={cn(TD, "text-(--dash-ink-2)")}>
                    <span className="block truncate" title={deal.nextAction || fmtNextAction(deal.stage)}>{deal.nextAction || fmtNextAction(deal.stage)}</span>
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <div className="relative flex items-center justify-end">
                      <span className="dash-num whitespace-nowrap font-semibold text-(--dash-ink) transition-opacity pointer-fine:group-hover:opacity-0 pointer-fine:group-focus-within:opacity-0">
                        {deal.dealSize != null ? formatCurrency(deal.dealSize, deal.currency) : <span className="font-normal text-(--dash-ink-3)">—</span>}
                      </span>
                      <span className="pointer-events-none absolute right-0 hidden items-center gap-1 opacity-0 transition-opacity pointer-fine:flex pointer-fine:group-hover:pointer-events-auto pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100">
                        <Link
                          href={`/data-room/${deal.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="dash-btn-ghost whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold"
                        >
                          Data room
                        </Link>
                        <Link
                          href={`/deals/${deal.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="dash-btn-primary whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold"
                        >
                          Open
                        </Link>
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && !error && (
        <footer className="flex items-center justify-between border-t border-(--dash-rule) px-6 py-3 text-sm">
          <span className="dash-num text-(--dash-ink-3)">
            Showing {Math.min(ROWS, rows.length)} of {rows.length}
          </span>
          <Link href="/deals" className="dash-link">All {liveCount} live deals &rarr;</Link>
        </footer>
      )}
    </section>
  );
}
