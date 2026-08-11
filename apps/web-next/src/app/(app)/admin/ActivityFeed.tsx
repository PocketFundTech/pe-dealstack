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
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card flex flex-col"
      style={{ height: 420 }}
    >
      <div className="p-5 border-b border-border-subtle space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-text-muted text-[20px]">rss_feed</span>
            Team Activity
          </h2>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-border-subtle bg-white text-text-main hover:bg-gray-50 transition-colors disabled:opacity-50"
            title="Export filtered audit log as CSV"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            {exporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filters.range}
            onChange={(e) =>
              setFilters((f) => ({ ...f, range: e.target.value as DateRange }))
            }
            className="text-xs rounded-md border border-border-subtle bg-white px-2 py-1.5 font-medium text-text-main focus:border-primary focus:ring-1 focus:ring-primary outline-none"
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
            className="text-xs rounded-md border border-border-subtle bg-white px-2 py-1.5 font-medium text-text-main focus:border-primary focus:ring-1 focus:ring-primary outline-none"
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
            className="text-xs rounded-md border border-border-subtle bg-white px-2 py-1.5 font-medium text-text-main focus:border-primary focus:ring-1 focus:ring-primary outline-none"
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
              className="text-xs text-text-muted hover:text-primary font-medium transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-5 relative custom-scrollbar">
        {/* Vertical timeline rail — matches admin-dashboard.html .activity-timeline::before:
            2px wide, gray, 24px inset from top/bottom of the scroll container, at left:17px
            (sits just inside the 20px container padding, against the left edge of the avatar column). */}
        {!loading && !error && logs.length > 0 && (
          <div
            aria-hidden
            className="absolute w-0.5 bg-border-subtle pointer-events-none"
            style={{ left: 17, top: 24, bottom: 24 }}
          />
        )}
        {loading ? (
          <div className="text-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-[24px] mb-2 block animate-spin">
              progress_activity
            </span>
            <p className="text-sm">Loading activity...</p>
          </div>
        ) : error ? (
          <div className="text-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-[32px] mb-2 block">cloud_off</span>
            <p className="text-sm font-medium">Could not load activity</p>
            <button
              type="button"
              onClick={() => load(false, filters)}
              className="mt-3 text-sm text-primary font-medium hover:text-primary-hover transition-colors"
            >
              Retry
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-[32px] mb-2 block">rss_feed</span>
            <p className="text-sm font-medium">No activity yet</p>
            <p className="text-xs mt-1">Actions across your org will appear here</p>
          </div>
        ) : (
          <div className="relative">
            {grouped.map(({ label, logs: dayLogs }) => (
              <div key={label}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mt-2 mb-2 first:mt-0">
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
        <div className="p-3 border-t border-border-subtle text-center">
          <button
            type="button"
            onClick={() => load(true, filters)}
            disabled={loadingMore}
            className="text-xs text-text-muted hover:text-primary font-medium uppercase tracking-wide transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "View Full History"}
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
    <div className="flex gap-3 relative z-10 mb-4">
      <div className="relative flex-shrink-0">
        <div
          className="w-9 h-9 rounded-full text-white text-xs font-medium flex items-center justify-center"
          style={{ backgroundColor: "#003366" }}
        >
          {ai ? (
            <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          ) : (
            initials(actor)
          )}
        </div>
        <div
          className="absolute -bottom-0.5 -right-0.5 rounded-full w-[18px] h-[18px] flex items-center justify-center border-2 border-white overflow-hidden"
          style={{ backgroundColor: "#003366" }}
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
        <p className="text-sm text-text-main">
          <span className={cn("font-semibold", ai && "text-primary")}>{actor}</span>{" "}
          {prefix}
          {entity && <span className="text-primary font-medium">{entity}</span>}
          {suffix}
        </p>
        <p className="text-xs text-text-muted mt-1">{formatRelativeTime(log.createdAt)}</p>
      </div>
    </div>
  );
}
