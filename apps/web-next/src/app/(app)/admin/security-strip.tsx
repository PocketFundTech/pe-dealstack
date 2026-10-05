"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/Skeleton";

// Compact security posture for the Command Center rail. Same data as the old
// full-width SecurityDashboard (GET /admin/security/dashboard); the headline
// and four figures are always visible, the lists fold open in place.

interface RecentAdminAction {
  action: string;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
}

interface TopDeal {
  dealId: string;
  dealName: string | null;
  views: number;
  uniqueViewers: number;
}

export interface SecurityDashboardData {
  windowDays: number;
  activeSessions: number | null;
  members: { total: number; mfaEnrolled: number | null; mfaPercent: number | null; requireMFA: boolean };
  staffAccess: { windowDays: number; count: number | null };
  failedLogins: { windowDays: number; count: number | null };
  adminActions: { windowDays: number; total: number; recent: RecentAdminAction[] };
  topDeals: TopDeal[];
}

const ACTION_LABELS: Record<string, string> = {
  USER_INVITED: "invited a user",
  USER_ROLE_CHANGED: "changed a user role",
  USER_DELETED: "removed a user",
  SETTINGS_CHANGED: "updated settings",
  ORG_MFA_REQUIRED: "enabled org-wide 2FA",
  ORG_MFA_NOT_REQUIRED: "disabled org-wide 2FA",
  SECURITY_TEST_RUN: "ran isolation test",
  STAFF_WEBHOOK_TEST: "updated staff-access notifications",
};
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a.toLowerCase().replace(/_/g, " ");

function relTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Same thresholds as the previous SecurityDashboard headline. */
export function headline(data: SecurityDashboardData): { ok: boolean; title: string; detail: string } {
  const staff = data.staffAccess.count ?? 0;
  const failed = data.failedLogins.count ?? 0;
  if (staff === 0 && failed <= 2) {
    return { ok: true, title: "All clear", detail: `No staff access or anomalies in the last ${data.windowDays} days.` };
  }
  if (staff > 0) {
    return { ok: false, title: `${staff} staff access ${staff === 1 ? "event" : "events"}`, detail: "Pocket Fund staff accessed your data. Review the access log." };
  }
  return { ok: false, title: `${failed} failed logins`, detail: "Higher than usual. Check the activity log for patterns." };
}

function Figure({ label, value, note, tone }: { label: string; value: React.ReactNode; note: string; tone?: "red" | "green" }) {
  return (
    <div className="bg-(--dash-panel) px-4 py-3">
      <p className="dash-label text-[0.625rem]">{label}</p>
      <p className={cn("dash-figure mt-1 text-xl leading-none", tone === "red" ? "text-(--dash-red)" : "text-(--dash-ink)")}>{value}</p>
      <p className={cn("mt-1 text-[0.6875rem]", tone === "green" ? "font-medium text-(--dash-green)" : "text-(--dash-ink-3)")}>{note}</p>
    </div>
  );
}

export function SecurityStrip() {
  const [data, setData] = useState<SecurityDashboardData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setData(await api.get<SecurityDashboardData>("/admin/security/dashboard"));
    } catch (err) {
      console.warn("[admin/security-strip] load failed:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
  useEffect(() => { load(); }, [load]);

  return (
    <section id="security" aria-labelledby="security-heading" className="dash-panel scroll-mt-6">
      <header className="flex items-center justify-between gap-3 border-b border-(--dash-rule) px-5 pt-4 pb-3">
        <h3 id="security-heading" className="dash-display text-lg text-(--dash-ink)">Security</h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label="Refresh security status"
          className="grid size-7 place-items-center rounded-md text-(--dash-ink-3) hover:bg-(--dash-wash) hover:text-(--dash-blue) disabled:opacity-50"
        >
          <span aria-hidden className={cn("material-symbols-outlined text-[16px]", loading && data && "animate-spin")}>refresh</span>
        </button>
      </header>

      {loading && !data ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Skeleton.Line width="45%" height={16} />
          <Skeleton.Line width="80%" height={11} />
          <Skeleton width="100%" height={56} rounded="md" />
        </div>
      ) : error || !data ? (
        <div className="flex items-center justify-between px-5 py-4 text-sm">
          <span className="text-(--dash-red)">Couldn&apos;t load security status.</span>
          <button type="button" onClick={load} className="dash-link">Retry</button>
        </div>
      ) : (
        <SecurityBody data={data} open={open} onToggle={() => setOpen((v) => !v)} />
      )}
    </section>
  );
}

function SecurityBody({ data, open, onToggle }: { data: SecurityDashboardData; open: boolean; onToggle: () => void }) {
  const h = headline(data);
  const staff = data.staffAccess.count;
  const failed = data.failedLogins.count;
  const mfa = data.members.requireMFA
    ? { value: "On", note: "Required for all", tone: "green" as const }
    : { value: data.members.mfaPercent != null ? `${data.members.mfaPercent}%` : "Off", note: "Optional — enable in Settings", tone: undefined };

  return (
    <>
      <div className="flex items-start gap-3 px-5 py-4">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", h.ok ? "bg-(--dash-wash) text-(--dash-green)" : "bg-(--dash-red-wash) text-(--dash-red)")}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">{h.ok ? "verified_user" : "gpp_maybe"}</span>
        </span>
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold", h.ok ? "text-(--dash-ink)" : "text-(--dash-red)")}>{h.title}</p>
          <p className="text-xs text-(--dash-ink-2)">{h.detail}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-(--dash-rule) bg-(--dash-rule)">
        <Figure label={`Staff access · ${data.staffAccess.windowDays}d`} value={staff ?? "—"} note={staff ? "Review the log" : "None"} tone={staff ? "red" : undefined} />
        <Figure label={`Failed logins · ${data.failedLogins.windowDays}d`} value={failed ?? "—"} note={failed && failed > 2 ? "Above usual" : "Normal"} tone={failed && failed > 2 ? "red" : undefined} />
        <Figure label={`Admin actions · ${data.adminActions.windowDays}d`} value={data.adminActions.total} note="Invites, roles, settings" />
        <Figure label="Two-factor" value={mfa.value} note={mfa.note} tone={mfa.tone} />
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 border-t border-(--dash-rule) px-5 py-2.5 text-xs font-medium text-(--dash-ink-2) hover:text-(--dash-ink)"
      >
        <span aria-hidden className={cn("material-symbols-outlined text-[16px] transition-transform", open && "rotate-90")}>chevron_right</span>
        Recent admin actions & most-viewed deals
      </button>

      {open && (
        <div className="dash-fade flex flex-col gap-4 border-t border-(--dash-rule) px-5 py-4 text-sm">
          <div>
            <p className="dash-label mb-1.5">Recent admin actions</p>
            {data.adminActions.recent.length === 0 ? (
              <p className="text-xs text-(--dash-ink-3)">Nothing in the last {data.adminActions.windowDays} days.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.adminActions.recent.slice(0, 5).map((a, i) => (
                  <li key={i} className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-(--dash-ink)"><span className="font-medium">{a.userName || a.userEmail || "Someone"}</span> {actionLabel(a.action)}</span>
                    <span className="shrink-0 text-(--dash-ink-3)">{relTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="dash-label mb-1.5">Most-viewed deals · {data.windowDays}d</p>
            {data.topDeals.length === 0 ? (
              <p className="text-xs text-(--dash-ink-3)">No deal views logged yet.</p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {data.topDeals.slice(0, 5).map((d, i) => (
                  <li key={d.dealId} className="flex items-baseline gap-2 text-xs">
                    <span className="dash-num w-3 text-(--dash-ink-3)">{i + 1}</span>
                    <Link href={`/deals/${d.dealId}`} className="min-w-0 flex-1 truncate font-medium text-(--dash-ink) hover:text-(--dash-blue)">{d.dealName || "Untitled deal"}</Link>
                    <span className="dash-num shrink-0 text-(--dash-ink-3)">{d.views} {d.views === 1 ? "view" : "views"} · {d.uniqueViewers} {d.uniqueViewers === 1 ? "viewer" : "viewers"}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href="/settings#section-security" className="dash-link text-xs">Access log & alerts →</a>
            <a href="/settings#section-team" className="dash-link text-xs">Manage 2FA →</a>
          </div>
        </div>
      )}
    </>
  );
}
