"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// HubSpot import progress + history (6 Oct testing: a long import showed a
// bare counter with no end in sight, so users felt lost). The job carries
// per-object totals from HubSpot (objectCounts[obj].total), so each row shows
// "X of Y" with a bar, plus an overall percentage and a time estimate from
// the rate this tab has observed.

export interface HubSpotJobCounts {
  processed: number;
  created: number;
  updated: number;
  failed: number;
  skipped?: number;
  /** Records HubSpot reports for this object; null/undefined when unknown. */
  total?: number | null;
}

export interface HubSpotImportJob {
  id: string;
  status: string;
  currentObject: string | null;
  objectCounts: Record<string, HubSpotJobCounts>;
  error?: string | null;
}

interface HistoryJob extends HubSpotImportJob {
  startedAt: string | null;
  finishedAt: string | null;
  startedByName: string | null;
}

export const HUBSPOT_OBJECTS = ["companies", "contacts", "deals", "notes", "calls", "meetings", "emails", "tasks"] as const;

/** Wait this long before showing an estimate, so it isn't based on one batch. */
const MIN_SAMPLE_MS = 20_000;

const fmt = (n: number) => n.toLocaleString();

function imported(c: HubSpotJobCounts | undefined): number {
  return c ? c.created + c.updated : 0;
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** Overall processed / known total, and the objects whose size HubSpot didn't report. */
function overall(job: HubSpotImportJob) {
  let done = 0;
  let total = 0;
  const unknown: string[] = [];
  for (const obj of HUBSPOT_OBJECTS) {
    const c = job.objectCounts?.[obj];
    const t = c?.total;
    if (typeof t === "number") {
      total += t;
      done += Math.min(c?.processed ?? 0, t);
    } else if (t === null) {
      // null = HubSpot couldn't say; undefined = not fetched (older job).
      unknown.push(obj);
    }
  }
  return { done, total, unknown };
}

export function HubSpotImportProgress({ job, driving }: { job: HubSpotImportJob; driving: boolean }) {
  const running = job.status === "running";
  const { done, total, unknown } = overall(job);

  // Rate from what this tab has seen: first sample → latest sample. Kept in
  // a ref (not render state); the estimate itself is state set by the effect.
  const firstSample = useRef<{ t: number; done: number } | null>(null);
  const [eta, setEta] = useState<string | null>(null);
  useEffect(() => {
    if (!running) { firstSample.current = null; setEta(null); return; }
    const t = Date.now();
    if (!firstSample.current) { firstSample.current = { t, done }; return; }
    const elapsed = t - firstSample.current.t;
    const rate = (done - firstSample.current.done) / elapsed; // records per ms
    setEta(total > 0 && elapsed >= MIN_SAMPLE_MS && rate > 0
      ? `about ${formatDuration((total - done) / rate)} left`
      : null);
  }, [running, done, total]);

  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null;

  return (
    <div className="rounded-lg border border-border-subtle bg-gray-50 p-4 space-y-2">
      {pct !== null && (
        <div className="pb-2" data-testid="hubspot-overall">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-text-main">
              {running ? "Overall" : "Imported"} {fmt(done)} of {fmt(total)} records ({pct}%)
            </span>
            {eta && <span className="text-xs text-text-muted">{eta}</span>}
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: "#003366" }} />
          </div>
          {unknown.length > 0 && (
            <p className="mt-1 text-[11px] text-text-muted">HubSpot didn&apos;t report a size for {unknown.join(", ")}.</p>
          )}
        </div>
      )}
      {HUBSPOT_OBJECTS.map((obj) => {
        const c = job.objectCounts?.[obj];
        const t = c?.total;
        const isCurrent = running && job.currentObject === obj;
        const objPct = typeof t === "number" && t > 0 ? Math.min(100, Math.round(((c?.processed ?? 0) / t) * 100)) : null;
        return (
          <div key={obj}>
            <div className="flex items-center justify-between text-sm">
              <span className={`capitalize ${isCurrent ? "font-semibold text-text-main" : "text-text-secondary"}`}>
                {obj}{isCurrent ? " — importing" : ""}
              </span>
              <span className="text-text-main font-medium">
                {c
                  ? `${fmt(imported(c))}${typeof t === "number" ? ` of ${fmt(t)}` : ""} imported · ${fmt(c.failed)} failed`
                  : "—"}
              </span>
            </div>
            {isCurrent && objPct !== null && (
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-200">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${objPct}%` }} />
              </div>
            )}
          </div>
        );
      })}
      <div className="pt-1 text-xs text-text-muted" data-testid="hubspot-job-status">
        Status: <span className="font-semibold">{job.status}</span>
        {job.currentObject ? ` (syncing ${job.currentObject})` : ""}
        {job.error ? ` — ${job.error}` : ""}
      </div>
      {running && driving && (
        <p className="text-xs text-text-muted">
          Importing in batches of 100. Keep this tab open — closing it pauses the import. Click &quot;Resume import&quot;
          any time to carry on; nothing is imported twice.
        </p>
      )}
    </div>
  );
}

export function HubSpotImportHistory({ refreshKey }: { refreshKey: string }) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.get<{ jobs: HistoryJob[] }>("/integrations/hubspot/import/history")
      .then((r) => { if (!cancelled) setJobs(r.jobs ?? []); })
      .catch((err) => console.warn("[settings/hubspot] history load failed:", err));
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (jobs.length === 0) return null;

  return (
    <details className="rounded-lg border border-border-subtle p-3 text-sm" data-testid="hubspot-history">
      <summary className="cursor-pointer font-semibold text-text-main">Past imports ({jobs.length})</summary>
      <ul className="mt-2 divide-y divide-border-subtle">
        {jobs.map((j) => {
          const counts = Object.values(j.objectCounts ?? {});
          const ok = counts.reduce((n, c) => n + imported(c), 0);
          const failed = counts.reduce((n, c) => n + (c.failed ?? 0), 0);
          const took = j.startedAt && j.finishedAt
            ? formatDuration(new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime())
            : null;
          return (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-text-main">
                {j.startedAt ? new Date(j.startedAt).toLocaleString() : "—"}
                {j.startedByName ? <span className="text-text-muted"> · {j.startedByName}</span> : null}
              </span>
              <span className="text-xs text-text-secondary">
                <span className={`mr-2 rounded px-1.5 py-0.5 font-semibold ${
                  j.status === "completed" ? "bg-emerald-50 text-emerald-700"
                    : j.status === "running" ? "bg-blue-50 text-blue-700"
                      : "bg-red-50 text-red-700"
                }`}>{j.status}</span>
                {fmt(ok)} imported · {fmt(failed)} failed{took ? ` · took ${took}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
