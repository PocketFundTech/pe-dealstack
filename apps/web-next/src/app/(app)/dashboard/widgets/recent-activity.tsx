"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatRelativeTime, getInitials } from "@/lib/formatters";
import { WidgetShell, WidgetEmpty, WidgetError, WidgetLoading } from "./shell";

// Ported from recent-activity.js +
// activity-formatters.js. Top 10 audit logs grouped by day with rich formatting.
type AuditLog = {
  id: string;
  action: string;
  description?: string;
  userName?: string | null;
  userEmail?: string | null;
  entityName?: string | null;
  resourceName?: string | null;
  resourceType?: string;
  createdAt: string;
};

// Action-to-icon map matching legacy activity-formatters.js
const ACTION_ICONS: Record<string, string> = {
  DEAL_CREATED: "add_circle",
  DEAL_UPDATED: "edit",
  DEAL_DELETED: "delete",
  DEAL_STAGE_CHANGED: "arrow_forward",
  DEAL_ASSIGNED: "person_add",
  DEAL_VIEWED: "visibility",
  DEAL_EXPORTED: "file_download",
  DOCUMENT_UPLOADED: "upload_file",
  DOCUMENT_DELETED: "delete",
  DOCUMENT_DOWNLOADED: "download",
  DOCUMENT_VIEWED: "visibility",
  MEMO_CREATED: "description",
  MEMO_UPDATED: "edit_note",
  MEMO_EXPORTED: "file_download",
  USER_CREATED: "person_add",
  USER_UPDATED: "manage_accounts",
  USER_INVITED: "mail",
  AI_INGEST: "auto_awesome",
  AI_GENERATE: "auto_awesome",
  AI_CHAT: "auto_awesome",
  LOGIN: "login",
  LOGOUT: "logout",
  SETTINGS_CHANGED: "settings",
};

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86400000);
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  if (dayStart.toDateString() === today.toDateString()) return "Today";
  if (dayStart.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function groupByDay(logs: AuditLog[]): Array<{ label: string; logs: AuditLog[] }> {
  const map = new Map<string, AuditLog[]>();
  for (const l of logs) {
    const label = dayLabel(l.createdAt);
    const arr = map.get(label) || [];
    arr.push(l);
    map.set(label, arr);
  }
  return [...map.entries()].map(([label, logs]) => ({ label, logs }));
}

export function RecentActivityWidget() {
  const [groups, setGroups] = useState<Array<{ label: string; logs: AuditLog[] }> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ logs?: AuditLog[] }>("/audit?limit=10");
        if (cancelled) return;
        const logs = data?.logs || [];
        setGroups(logs.length === 0 ? [] : groupByDay(logs));
      } catch (err) {
        console.warn("[dashboard/recent-activity] failed to load audit logs:", err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <WidgetShell title="Recent Activity" icon="history">
      {error ? (
        <WidgetError message="Could not load activity" />
      ) : !groups ? (
        <WidgetLoading />
      ) : groups.length === 0 ? (
        <WidgetEmpty message="Activity will appear here as your team works" icon="rss_feed" />
      ) : (
        <div className="p-5">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted mt-2 mb-2 first:mt-0">{g.label}</p>
              {g.logs.map((l) => {
                const isAI = l.action?.startsWith("AI_");
                const icon = ACTION_ICONS[l.action] || "info";
                const userName = l.userName || l.userEmail?.split("@")[0] || "System";
                const initials = isAI ? null : getInitials(userName);
                const entityName = l.entityName || l.resourceName || "";
                return (
                  <div key={l.id} className="flex gap-3 relative z-10 mb-4">
                    <div className="relative flex-shrink-0">
                      <div
                        className="w-9 h-9 rounded-full text-white text-xs font-medium flex items-center justify-center"
                        style={{ backgroundColor: "#003366" }}
                      >
                        {isAI ? (
                          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
                        ) : (
                          initials
                        )}
                      </div>
                      <div
                        className="absolute -bottom-0.5 -right-0.5 rounded-full w-[18px] h-[18px] flex items-center justify-center border-2 border-white overflow-hidden"
                        style={{ backgroundColor: "#003366" }}
                      >
                        {/* opsz 20 is the lowest Material Symbols optical-size variant — pair with 12px font-size so glyphs render at their designed metrics. */}
                        <span
                          className="material-symbols-outlined text-white leading-none"
                          style={{ fontSize: "12px", fontVariationSettings: "'opsz' 20, 'wght' 400, 'FILL' 1, 'GRAD' 0", lineHeight: 1 }}
                        >{icon}</span>
                      </div>
                    </div>
                    <div className="flex-1 pt-0.5">
                      <p className="text-sm text-text-main">
                        <span className={`font-semibold${isAI ? " text-primary" : ""}`}>
                          {isAI ? "Avise AI" : userName}
                        </span>{" "}
                        {l.description || l.action.toLowerCase().replace(/_/g, " ")}
                        {entityName && (
                          <> <span className="text-primary font-medium">{entityName}</span></>
                        )}
                      </p>
                      <p className="text-xs text-text-muted mt-1">{formatRelativeTime(l.createdAt)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
