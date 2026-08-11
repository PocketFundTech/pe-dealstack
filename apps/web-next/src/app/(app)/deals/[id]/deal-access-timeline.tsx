"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// Per-deal access timeline. Aggregates DEAL_VIEWED audit events for one
// deal into a "viewed N times by M users in last 30 days" card with the
// top 5 viewers. Backed by GET /api/deals/:dealId/access-timeline.

interface Viewer {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userRole: string | null;
  lastViewedAt: string;
  viewCount: number;
}

interface AccessTimeline {
  dealId: string;
  windowDays: number;
  totalViews: number;
  uniqueViewers: number;
  viewers: Viewer[];
}

function relTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function initials(name: string | null, email: string | null): string {
  const seed = name ?? email ?? "?";
  const parts = seed.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function DealAccessTimeline({ dealId }: { dealId: string }) {
  const [data, setData] = useState<AccessTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<AccessTimeline>(`/deals/${dealId}/access-timeline`);
      setData(result);
    } catch (err) {
      console.warn("[deal/access-timeline] load failed:", err);
      setError("Couldn't load access timeline.");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: "rgba(255, 255, 255, 0.8)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(229, 231, 235, 0.8)",
        boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-text-main uppercase tracking-wider flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-lg">visibility</span>
          Deal Access
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>

      {loading && data === null ? (
        <p className="text-xs text-text-muted py-2">Loading access history...</p>
      ) : error ? (
        <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800">
          {error}
        </div>
      ) : !data || data.totalViews === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-text-muted">
          <span className="material-symbols-outlined text-2xl mb-2">visibility_off</span>
          <p className="text-sm">No views logged yet</p>
          <p className="text-xs mt-1">
            Activity will appear here as your team reviews this deal.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3">
            <p className="text-sm text-text-main">
              Viewed{" "}
              <span className="font-bold" style={{ color: "#003366" }}>
                {data.totalViews}
              </span>{" "}
              {data.totalViews === 1 ? "time" : "times"} by{" "}
              <span className="font-bold" style={{ color: "#003366" }}>
                {data.uniqueViewers}
              </span>{" "}
              {data.uniqueViewers === 1 ? "user" : "users"} in the last{" "}
              {data.windowDays} days
            </p>
          </div>

          <ul className="space-y-2">
            {data.viewers.slice(0, 5).map((v) => (
              <li
                key={v.userId ?? `${v.userEmail}-${v.lastViewedAt}`}
                className="flex items-center gap-3 p-2 bg-white rounded-lg border border-border-subtle"
              >
                <div
                  className="size-8 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                  style={{ background: "#003366" }}
                >
                  {initials(v.userName, v.userEmail)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-main truncate">
                    {v.userName ?? v.userEmail ?? "Unknown"}
                    {v.userRole ? (
                      <span className="ml-2 text-[10px] uppercase font-medium text-text-muted tracking-wider">
                        {v.userRole}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[10px] text-text-muted">
                    Last viewed {relTime(v.lastViewedAt)} ·{" "}
                    {v.viewCount} {v.viewCount === 1 ? "view" : "views"}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {data.viewers.length > 5 ? (
            <p className="text-[10px] text-text-muted mt-2 text-center">
              + {data.viewers.length - 5} more viewer
              {data.viewers.length - 5 === 1 ? "" : "s"}
            </p>
          ) : null}

          <div className="mt-3 pt-3 border-t border-border-subtle">
            <a
              href={`/admin?activityFilter=DEAL_VIEWED&entityId=${dealId}`}
              className="text-xs font-semibold uppercase tracking-wide hover:underline"
              style={{ color: "#003366" }}
            >
              View full activity log →
            </a>
          </div>
        </>
      )}
    </div>
  );
}
