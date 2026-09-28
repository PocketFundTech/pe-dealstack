"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { authFetchRaw } from "../deal-intake/components";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import {
  formatAuditAction,
  getActorName,
  groupLogsByDay,
  isAIAction,
  type AuditLog,
} from "../dashboard/widgets/activity-formatters";
import type { AdminAuditLog } from "./types";

const PAGE_SIZE = 10;

type DateRange = "all" | "7d" | "30d" | "90d";

interface AuditFilters {
  range: DateRange;
  action: string;
  resourceType: string;
}

const DEFAULT_FILTERS: AuditFilters = {
  range: "all",
  action: "",
  resourceType: "",
};

const RESOURCE_TYPES: Array<{ value: string; label: string }> = [
  { value: "", label: "All resource types" },
  { value: "DEAL", label: "Deal" },
  { value: "DOCUMENT", label: "Document" },
  { value: "MEMO", label: "Memo" },
  { value: "USER", label: "User" },
  { value: "ORGANIZATION", label: "Organization" },
  { value: "FOLDER", label: "Folder" },
];

const COMMON_ACTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All actions" },
  { value: "DEAL_VIEWED", label: "Deal viewed" },
  { value: "DEAL_CREATED", label: "Deal created" },
  { value: "DEAL_UPDATED", label: "Deal updated" },
  { value: "DOCUMENT_UPLOADED", label: "Document uploaded" },
  { value: "DOCUMENT_DOWNLOADED", label: "Document downloaded" },
  { value: "MEMO_CREATED", label: "Memo created" },
  { value: "USER_INVITED", label: "User invited" },
  { value: "SECURITY_TEST_RUN", label: "Isolation test run" },
];

function rangeToStart(r: DateRange): string | null {
  if (r === "all") return null;
  const days = r === "7d" ? 7 : r === "30d" ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function buildAuditQuery(
  filters: AuditFilters,
  limit: number,
  offset: number,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (filters.action) params.set("action", filters.action);
  if (filters.resourceType) params.set("resourceType", filters.resourceType);
  const start = rangeToStart(filters.range);
  if (start) params.set("startDate", start);
  return params.toString();
}

// Mirrors legacy getInitials in activity-formatters.js —
// splits on whitespace AND `@` so an email-derived display name still produces
// two-letter initials (e.g. "alice.bobson@firm.com" → "AF"). The shared
// getInitials in lib/formatters.ts only splits on space, so it's not a direct
// substitute here.
function initials(raw: string): string {
  return (
    raw
      .split(/[\s@]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "?"
  );
}

export function ActivityFeed() {
  const [logs, setLogs] = useState<AdminAuditLog[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(
    async (append: boolean, activeFilters: AuditFilters) => {
      const nextOffset = append ? offset : 0;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(false);
      }
      try {
        const qs = buildAuditQuery(activeFilters, PAGE_SIZE, nextOffset);
        const data = await api.get<{ logs: AdminAuditLog[] }>(`/audit?${qs}`);
        const newLogs = data.logs || [];
        setLogs((prev) => (append ? prev.concat(newLogs) : newLogs));
        setOffset(nextOffset + newLogs.length);
        setHasMore(newLogs.length === PAGE_SIZE);
      } catch (err) {
        console.warn("[admin] activity feed load failed:", err);
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [offset],
  );

  useEffect(() => {
    load(false, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.range, filters.action, filters.resourceType]);

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      if (filters.action) qs.set("action", filters.action);
      if (filters.resourceType) qs.set("resourceType", filters.resourceType);
      const start = rangeToStart(filters.range);
      if (start) qs.set("startDate", start);
      const res = await authFetchRaw(`/audit/export.csv?${qs.toString()}`);
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ||
        `pocket-fund-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[admin] audit CSV export failed:", err);
    } finally {
      setExporting(false);
    }
  };

  const grouped = groupLogsByDay(logs as AuditLog[]);

  return (
    <div
      className="dash-panel flex flex-col"
      style={{ height: 460 }}
    >
      <div className="space-y-3 border-b border-(--dash-rule) px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="dash-display text-lg text-(--dash-ink)">Team activity</h3>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="dash-btn-ghost inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold"
            title="Export filtered audit log as CSV"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            {exporting ? "Exporting…" : "CSV"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filters.range}
            onChange={(e) =>
              setFilters((f) => ({ ...f, range: e.target.value as DateRange }))
            }
            className="rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-2 py-1 text-xs font-medium text-(--dash-ink-2) outline-none focus:border-(--dash-blue-2)"
          >
            <option value="all">All time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <select
            value={filters.action}
            onChange={(e) =>
              setFilters((f) => ({ ...f, action: e.target.value }))
            }
            className="rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-2 py-1 text-xs font-medium text-(--dash-ink-2) outline-none focus:border-(--dash-blue-2)"
          >
            {COMMON_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            value={filters.resourceType}
            onChange={(e) =>
              setFilters((f) => ({ ...f, resourceType: e.target.value }))
            }
            className="rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-2 py-1 text-xs font-medium text-(--dash-ink-2) outline-none focus:border-(--dash-blue-2)"
          >
            {RESOURCE_TYPES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {(filters.range !== "all" ||
            filters.action ||
            filters.resourceType) && (
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_FILTERS)}
              className="text-xs font-medium text-(--dash-blue) hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="custom-scrollbar relative flex-1 overflow-y-auto px-5 py-4">
        {/* Vertical timeline rail — matches admin-dashboard.html .activity-timeline::before:
            2px wide, gray, 24px inset from top/bottom of the scroll container, at left:17px
            (sits just inside the 20px container padding, against the left edge of the avatar column). */}
        {!loading && !error && logs.length > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute w-px bg-(--dash-rule)"
            style={{ left: 35, top: 28, bottom: 24 }}
          />
        )}
        {loading ? (
          <p className="py-6 text-sm text-(--dash-ink-3)">Loading activity…</p>
        ) : error ? (
          <p className="py-6 text-sm">
            <span className="text-(--dash-red)">Couldn&apos;t load activity.</span>{" "}
            <button type="button" onClick={() => load(false, filters)} className="dash-link">Retry</button>
          </p>
        ) : logs.length === 0 ? (
          <p className="py-6 text-sm text-(--dash-ink-2)">
            No activity for these filters. Views, edits, uploads and admin changes across the team appear here as they happen.
          </p>
        ) : (
          <div className="relative">
            {grouped.map(({ label, logs: dayLogs }) => (
              <div key={label}>
                <p className="dash-label relative z-10 mt-3 mb-2 w-fit bg-(--dash-panel) pr-2 first:mt-0">
                  {label}
                </p>
                {dayLogs.map((log) => (
                  <ActivityItem key={log.id} log={log as AuditLog} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {logs.length > 0 && hasMore && (
        <div className="border-t border-(--dash-rule) px-5 py-2.5">
          <button
            type="button"
            onClick={() => load(true, filters)}
            disabled={loadingMore}
            className="text-sm font-medium text-(--dash-blue) hover:underline disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older activity"}
          </button>
        </div>
      )}
    </div>
  );
}

// Single activity row. Matches the legacy renderActivityItem layout in
// activity-formatters.js, with the corrected action-icon
// badge sizing from commit 3d87c52 (badge 18×18, icon 12px font-size, opsz 20).
function ActivityItem({ log }: { log: AuditLog }) {
  const ai = isAIAction(log);
  const actor = getActorName(log);
  const { prefix, entity, suffix, icon } = formatAuditAction(log);

  return (
    <div className="relative z-10 mb-3.5 flex gap-3">
      <div className="relative flex-shrink-0">
        <div
          className="flex size-8 items-center justify-center rounded-full bg-(--dash-wash) text-[0.6875rem] font-bold text-(--dash-blue) ring-2 ring-(--dash-panel)"
        >
          {ai ? (
            <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          ) : (
            initials(actor)
          )}
        </div>
        <div
          className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center overflow-hidden rounded-full border-2 border-(--dash-panel) bg-(--dash-blue)"
        >
          {/* opsz 20 is the lowest Material Symbols optical-size variant — pair with 12px font-size so glyphs render at their designed metrics. */}
          <span
            className="material-symbols-outlined text-white leading-none"
            style={{
              fontSize: "12px",
              fontVariationSettings: "'opsz' 20, 'wght' 400, 'FILL' 1, 'GRAD' 0",
              lineHeight: 1,
            }}
          >
            {icon}
          </span>
        </div>
      </div>
      <div className="flex-1 pt-0.5">
        <p className="text-[0.8125rem] leading-snug text-(--dash-ink-2)">
          <span className={cn("font-semibold text-(--dash-ink)", ai && "text-(--dash-blue)")}>{actor}</span>{" "}
          {prefix}
          {entity && <span className="font-medium text-(--dash-blue)">{entity}</span>}
          {suffix}
        </p>
        <p className="mt-0.5 text-xs text-(--dash-ink-3)">{formatRelativeTime(log.createdAt)}</p>
      </div>
    </div>
  );
}
