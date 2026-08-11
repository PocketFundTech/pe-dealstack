"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// Customer security dashboard. Asymmetric, banker-grade narrative for a
// compliance officer scanning posture in 30 seconds.
//
// Order is the story:
//   1. Status hero (the headline takeaway)
//   2. Featured signal — Pocket Fund staff access (the unique moat)
//   3. Trust strip — three small verified-state metrics
//   4. Activity ledger — admin actions + most-viewed deals as lists
//   5. Inline footnote — degraded states (e.g., session counts unavailable)
//
// Zero is celebrated, not shown as empty.

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

interface SecurityDashboardData {
  windowDays: number;
  activeSessions: number | null;
  members: {
    total: number;
    mfaEnrolled: number | null;
    mfaPercent: number | null;
    requireMFA: boolean;
  };
  staffAccess: { windowDays: number; count: number | null };
  failedLogins: { windowDays: number; count: number | null };
  adminActions: { windowDays: number; total: number; recent: RecentAdminAction[] };
  topDeals: TopDeal[];
}

const BANKER_BLUE = "#003366";

// ─── helpers ────────────────────────────────────────────────────────

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

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    USER_INVITED: "invited a user",
    USER_ROLE_CHANGED: "changed a user role",
    USER_DELETED: "removed a user",
    SETTINGS_CHANGED: "updated settings",
    ORG_MFA_REQUIRED: "enabled org-wide 2FA",
    ORG_MFA_NOT_REQUIRED: "disabled org-wide 2FA",
    SECURITY_TEST_RUN: "ran isolation test",
    STAFF_WEBHOOK_TEST: "updated staff-access notifications",
  };
  return map[action] ?? action.toLowerCase().replace(/_/g, " ");
}

// ─── headline computation ───────────────────────────────────────────

function summariseHeadline(data: SecurityDashboardData): {
  status: "clear" | "watch" | "attention";
  title: string;
  subtitle: string;
} {
  const failedLogins = data.failedLogins.count ?? 0;
  const staffAccess = data.staffAccess.count ?? 0;

  if (staffAccess === 0 && failedLogins <= 2) {
    return {
      status: "clear",
      title: "All clear",
      subtitle: "No staff access, no anomalies, no incidents in the last 30 days.",
    };
  }
  if (staffAccess > 0) {
    return {
      status: "watch",
      title: `${staffAccess} staff access ${staffAccess === 1 ? "event" : "events"}`,
      subtitle:
        "Pocket Fund staff have accessed your data. Review the entries in Settings → Security.",
    };
  }
  return {
    status: "watch",
    title: `${failedLogins} failed login attempts`,
    subtitle: "Higher than baseline. Review the activity feed for patterns.",
  };
}

// ─── small UI atoms ─────────────────────────────────────────────────

function Skeleton() {
  return (
    <div
      className="rounded-xl bg-white p-8 border border-border-subtle"
      style={{ minHeight: 180 }}
    >
      <div className="animate-pulse space-y-4">
        <div className="h-3 w-24 bg-gray-200 rounded" />
        <div className="h-12 w-32 bg-gray-200 rounded" />
        <div className="h-3 w-48 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

// ─── main component ─────────────────────────────────────────────────

export function SecurityDashboard() {
  const [data, setData] = useState<SecurityDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<SecurityDashboardData>(
        "/admin/security/dashboard",
      );
      setData(result);
    } catch (err) {
      console.warn("[admin/security-dashboard] load failed:", err);
      setError("Couldn't load security dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && data === null) return <Skeleton />;

  if (error || !data) {
    return (
      <div className="rounded-xl p-5 bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-center justify-between">
        <span>{error ?? "No data."}</span>
        <button
          type="button"
          onClick={load}
          className="text-xs font-semibold underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const headline = summariseHeadline(data);
  const staffAccessZero = (data.staffAccess.count ?? 0) === 0;
  const failedZero = (data.failedLogins.count ?? 0) === 0;
  const adminActionsZero = data.adminActions.total === 0;

  return (
    <section className="space-y-5">
      {/* ───── Refresh control ───── */}
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-text-muted">
          Security · Last 30 days
        </p>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] font-bold uppercase tracking-wider text-text-muted hover:text-text-main transition-colors disabled:opacity-50 inline-flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>

      {/* ───── Status hero ───── */}
      <div
        className="rounded-2xl px-6 py-7"
        style={{
          background:
            headline.status === "clear"
              ? "linear-gradient(180deg, rgba(0,51,102,0.04) 0%, rgba(0,51,102,0) 100%)"
              : "linear-gradient(180deg, rgba(245,158,11,0.06) 0%, rgba(245,158,11,0) 100%)",
          border:
            headline.status === "clear"
              ? "1px solid rgba(0,51,102,0.12)"
              : "1px solid rgba(245,158,11,0.18)",
        }}
      >
        <div className="flex items-start gap-4">
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: 36,
              color: headline.status === "clear" ? BANKER_BLUE : "#b45309",
              fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0",
            }}
          >
            {headline.status === "clear" ? "verified_user" : "warning"}
          </span>
          <div className="flex-1 min-w-0">
            <h2
              className="text-2xl md:text-3xl font-bold leading-tight tracking-tight"
              style={{ color: BANKER_BLUE }}
            >
              {headline.title}
            </h2>
            <p className="mt-1 text-sm text-text-secondary max-w-prose">
              {headline.subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* ───── Featured signal — Pocket Fund staff access ───── */}
      <div
        className="rounded-2xl border bg-white px-6 py-6 sm:px-7 sm:py-7"
        style={{
          borderColor: staffAccessZero
            ? "rgba(0,51,102,0.12)"
            : "rgba(245,158,11,0.25)",
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-8 gap-y-3 items-baseline">
          <div className="flex items-baseline gap-3">
            <span
              className="font-bold leading-none tracking-tight tabular-nums"
              style={{
                fontSize: "clamp(56px, 9vw, 96px)",
                color: BANKER_BLUE,
                letterSpacing: "-0.02em",
              }}
            >
              {data.staffAccess.count ?? 0}
            </span>
            {staffAccessZero ? (
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 28,
                  color: "#15803d",
                  marginLeft: -8,
                  fontVariationSettings: "'FILL' 1, 'wght' 600",
                }}
              >
                check_circle
              </span>
            ) : null}
          </div>
          <div className="self-end pb-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
              Pocket Fund staff access · {data.staffAccess.windowDays} days
            </p>
            <p className="mt-2 text-base text-text-main font-medium leading-snug">
              {staffAccessZero
                ? "Pocket Fund staff have not accessed your data."
                : `Pocket Fund staff accessed your data ${data.staffAccess.count} time${
                    data.staffAccess.count === 1 ? "" : "s"
                  }.`}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {staffAccessZero
                ? "When they do, you'll see entries here in real-time."
                : "Review the entries in Settings → Security."}
            </p>
            <a
              href="/settings#section-security"
              className="mt-3 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider hover:underline"
              style={{ color: BANKER_BLUE }}
            >
              {staffAccessZero
                ? "Configure real-time alerts"
                : "Open access log"}
              <span className="material-symbols-outlined text-sm">arrow_forward</span>
            </a>
          </div>
        </div>
      </div>

      {/* ───── Trust strip — three supporting metrics, dense row ───── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 rounded-2xl border bg-white overflow-hidden divide-y sm:divide-y-0 sm:divide-x divide-border-subtle">
        <a
          href="/settings#section-team"
          className="group block px-6 py-5 hover:bg-gray-50 transition-colors"
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
            Members
          </p>
          <p
            className="mt-2 font-bold leading-none tabular-nums"
            style={{ fontSize: 36, color: BANKER_BLUE, letterSpacing: "-0.015em" }}
          >
            {data.members.total}
          </p>
          <p className="mt-2 text-xs text-text-secondary">
            <span
              className={
                data.members.requireMFA
                  ? "font-semibold text-emerald-700"
                  : "font-semibold text-amber-700"
              }
            >
              {data.members.requireMFA ? "2FA required" : "2FA optional"}
            </span>
            <span className="ml-1 text-text-muted opacity-70 group-hover:opacity-100 transition-opacity">
              · manage →
            </span>
          </p>
        </a>

        <div className="px-6 py-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
            Failed logins · 7d
          </p>
          <p
            className="mt-2 font-bold leading-none tabular-nums"
            style={{
              fontSize: 36,
              color: failedZero ? BANKER_BLUE : "#b45309",
              letterSpacing: "-0.015em",
            }}
          >
            {data.failedLogins.count ?? 0}
          </p>
          <p className="mt-2 text-xs text-text-muted">
            {failedZero
              ? "No failed login attempts."
              : "Review the activity feed for patterns."}
          </p>
        </div>

        <div className="px-6 py-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
            Admin actions · 30d
          </p>
          <p
            className="mt-2 font-bold leading-none tabular-nums"
            style={{ fontSize: 36, color: BANKER_BLUE, letterSpacing: "-0.015em" }}
          >
            {data.adminActions.total}
          </p>
          <p className="mt-2 text-xs text-text-muted">
            {adminActionsZero
              ? "No invites, role changes, or settings updates."
              : "Recent invites, role changes, settings updates."}
          </p>
        </div>
      </div>

      {/* ───── Activity ledger — admin actions + top deals as lists ───── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Recent admin actions */}
        <div className="rounded-2xl border border-border-subtle bg-white px-6 py-5">
          <div className="flex items-baseline justify-between mb-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
              Recent admin actions
            </p>
            {data.adminActions.recent.length > 0 ? (
              <p className="text-[10px] text-text-muted tabular-nums">
                showing {Math.min(data.adminActions.recent.length, 5)} of{" "}
                {data.adminActions.total}
              </p>
            ) : null}
          </div>
          {data.adminActions.recent.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              Nothing to report — your settings have been quiet for 30 days.
            </p>
          ) : (
            <ol className="divide-y divide-border-subtle">
              {data.adminActions.recent.slice(0, 5).map((a) => (
                <li
                  key={a.createdAt + a.action}
                  className="py-2.5 flex items-baseline gap-3"
                >
                  <span className="text-xs text-text-muted tabular-nums whitespace-nowrap min-w-[60px]">
                    {relTime(a.createdAt)}
                  </span>
                  <p className="text-sm text-text-main truncate flex-1">
                    <span className="font-semibold">
                      {a.userName ?? a.userEmail ?? "Someone"}
                    </span>{" "}
                    <span className="text-text-secondary">{actionLabel(a.action)}</span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Most-viewed deals */}
        <div className="rounded-2xl border border-border-subtle bg-white px-6 py-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted mb-3">
            Most-viewed deals · 30d
          </p>
          {data.topDeals.length === 0 ? (
            <p className="text-sm text-text-muted py-4">
              No deal views logged yet — activity will appear as your team reviews
              deals.
            </p>
          ) : (
            <ol className="divide-y divide-border-subtle">
              {data.topDeals.slice(0, 5).map((d, idx) => (
                <li
                  key={d.dealId}
                  className="py-2.5 flex items-baseline gap-3"
                >
                  <span
                    className="text-xs font-bold tabular-nums tracking-wider"
                    style={{
                      color: idx === 0 ? BANKER_BLUE : "#94a3b8",
                      minWidth: 18,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <a
                    href={`/deals/${d.dealId}`}
                    className="flex-1 truncate text-sm font-semibold text-text-main hover:underline"
                  >
                    {d.dealName ?? d.dealId}
                  </a>
                  <span className="text-xs text-text-muted tabular-nums whitespace-nowrap">
                    {d.views} {d.views === 1 ? "view" : "views"} · {d.uniqueViewers}{" "}
                    {d.uniqueViewers === 1 ? "viewer" : "viewers"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* ───── Footnote — degraded states ───── */}
      {data.activeSessions === null ? (
        <p className="text-[11px] text-text-muted px-1">
          Active session counts unavailable — Supabase{" "}
          <code className="font-mono">auth</code> schema needs to be exposed in
          PostgREST. (See master TODO ops item OPS-2.)
        </p>
      ) : (
        <p className="text-[11px] text-text-muted px-1">
          {data.activeSessions} active session
          {data.activeSessions === 1 ? "" : "s"} across your team right now.
        </p>
      )}
    </section>
  );
}
