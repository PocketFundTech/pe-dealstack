"use client";

import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Deal } from "./components";
import { PIPELINE, isLiveDeal, isStale, type StageBucket } from "./triage";

interface PipelineFunnelProps {
  deals: Deal[];
  loading: boolean;
  error: boolean;
  now: number;
  onRetry: () => void;
  onOpenStage: (bucket: StageBucket, deals: Deal[]) => void;
}

/**
 * Five-stage funnel. Each column is a button that opens the stage in the
 * deals drawer. Bars are scaled to the largest stage so the shape of the
 * funnel reads at a glance; stale counts surface where attention is needed.
 */
export function PipelineFunnel({ deals, loading, error, now, onRetry, onOpenStage }: PipelineFunnelProps) {
  const live = deals.filter((d) => isLiveDeal(d) || d.stage === "CLOSED_WON");
  const columns = PIPELINE.map((bucket) => {
    const inStage = live.filter((d) => bucket.stages.includes(d.stage));
    return { bucket, deals: inStage, stale: inStage.filter((d) => isStale(d, now)).length };
  });
  const max = Math.max(1, ...columns.map((c) => c.deals.length));
  const totalLive = deals.filter(isLiveDeal).length;
  const totalStale = columns.reduce((s, c) => s + c.stale, 0);

  return (
    <section aria-labelledby="pipeline-heading" className="dash-panel overflow-hidden">
      <header className="flex items-baseline justify-between gap-4 px-6 pt-5 pb-1">
        <h2 id="pipeline-heading" className="dash-display text-xl text-(--dash-ink)">Pipeline</h2>
        {!loading && !error && (
          <p className="dash-num text-xs text-(--dash-ink-3)">
            <span className="font-semibold text-(--dash-ink)">{totalLive}</span> live
            {totalStale > 0 && (
              <> · <span className="font-semibold text-(--dash-brass)">{totalStale}</span> stale</>
            )}
          </p>
        )}
      </header>

      {error ? (
        <div className="flex items-center justify-between gap-4 px-6 py-5 text-sm">
          <span className="text-(--dash-red)">Couldn&apos;t load the pipeline.</span>
          <button type="button" onClick={onRetry} className="dash-link">Retry</button>
        </div>
      ) : (
        <ol className="grid grid-cols-1 sm:grid-cols-5">
          {columns.map((c, i) => {
            const empty = !loading && c.deals.length === 0;
            return (
              <li key={c.bucket.key} className={cn("relative", i > 0 && "border-t border-(--dash-rule) sm:border-t-0 sm:border-l")}>
                <button
                  type="button"
                  onClick={() => onOpenStage(c.bucket, c.deals)}
                  disabled={loading}
                  aria-label={`${c.bucket.label}: ${c.deals.length} deals${c.stale ? `, ${c.stale} stale` : ""}. Show deals`}
                  className="group flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-(--dash-paper) sm:flex-col sm:items-start sm:gap-2.5 sm:pt-4 sm:pb-5"
                >
                  <span className="dash-label w-24 shrink-0 transition-colors group-hover:text-(--dash-blue) sm:w-auto">{c.bucket.label}</span>
                  {loading ? (
                    <Skeleton width={40} height={34} />
                  ) : (
                    <span className={cn("dash-figure text-[2.25rem] leading-none", empty ? "text-(--dash-rule-strong)" : "text-(--dash-ink)")}>
                      {c.deals.length}
                    </span>
                  )}
                  <span className="flex flex-1 flex-col gap-2 sm:w-full sm:flex-none">
                    <span className="block h-1 w-full overflow-hidden rounded-full bg-(--dash-wash)" aria-hidden>
                      {!loading && c.deals.length > 0 && (
                        <span
                          className="dash-bar block h-full rounded-full"
                          style={{ width: `${(c.deals.length / max) * 100}%`, background: c.bucket.tone }}
                        />
                      )}
                    </span>
                    <span className="h-4 text-xs">
                      {!loading && (c.stale > 0
                        ? <span className="font-medium text-(--dash-brass)">{c.stale} stale</span>
                        : <span className="text-(--dash-ink-3)">{empty ? "None" : "All active"}</span>)}
                    </span>
                  </span>
                </button>
                {i < columns.length - 1 && (
                  <span
                    className="material-symbols-outlined pointer-events-none absolute top-[1.1rem] -right-2 z-10 hidden bg-(--dash-panel) text-[16px] text-(--dash-rule-strong) sm:block"
                  >
                    chevron_right
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
