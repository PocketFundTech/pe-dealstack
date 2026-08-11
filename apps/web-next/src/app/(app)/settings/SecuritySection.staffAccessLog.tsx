"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

// Customer-visible Pocket Fund staff access log + Slack/email
// notification config. The audit log feed is read by every user;
// the notification config is admin-only. Default state for a new
// org is "0 accesses" — that's the point.

interface StaffAccessEntry {
  id: string;
  createdAt: string;
  metadata?: {
    staffEmail?: string;
    method?: string;
    path?: string;
    ip?: string | null;
    ua?: string | null;
  } | null;
}

interface AuditListResponse {
  success?: boolean;
  count: number | null;
  logs: StaffAccessEntry[];
}

interface OrgWebhookConfig {
  id: string;
  name?: string;
  staffAccessWebhookUrl: string | null;
  staffAccessNotifyEmail: string | null;
}

const ADMIN_ROLES: Array<string> = ["ADMIN", "PARTNER", "PRINCIPAL"];

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

function StaffAccessFeed() {
  const [count, setCount] = useState<number | null>(null);
  const [logs, setLogs] = useState<StaffAccessEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<AuditListResponse>(
        "/audit?action=STAFF_ACCESS&limit=10",
      );
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
      setCount(typeof data?.count === "number" ? data.count : null);
    } catch (err) {
      console.warn("[settings/security/staff-access-log] load failed:", err);
      setError("Couldn't load staff access log.");
      setLogs([]);
      setCount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  if (loading && count === null) {
    return (
      <p className="text-xs text-text-muted py-2">Loading staff access log...</p>
    );
  }

  if (error) {
    return (
      <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800 flex items-center justify-between gap-3">
        <span>{error}</span>
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

  if (!count) {
    return (
      <div className="p-4 bg-green-50 rounded-lg border border-green-200 flex items-start gap-3">
        <span className="material-symbols-outlined text-green-700 text-[28px] flex-shrink-0">
          verified
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-main">
            Pocket Fund staff has accessed your data{" "}
            <span className="text-green-700">0 times</span> in the last 90 days.
          </p>
          <p className="text-xs text-text-muted mt-1">
            When staff access your data, you&apos;ll see the entries here in
            real-time.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {count} staff access{count === 1 ? " event" : " events"} in the last 90 days
        </p>
        <a
          href="/admin?activityFilter=STAFF_ACCESS"
          className="text-xs font-semibold uppercase tracking-wide hover:underline"
          style={{ color: "#003366" }}
        >
          View full audit log →
        </a>
      </div>
      <ul className="space-y-1.5">
        {logs.slice(0, 10).map((entry) => (
          <li
            key={entry.id}
            className="p-3 bg-gray-50 rounded-lg border border-border-subtle text-xs"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono font-semibold text-text-main">
                {entry.metadata?.staffEmail ?? "unknown@pocket-fund.com"}
              </span>
              <span className="text-text-muted">
                {relTime(entry.createdAt)}
              </span>
            </div>
            <div className="mt-1 text-text-secondary">
              <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded bg-white border border-border-subtle font-mono text-[10px] uppercase tracking-wide">
                {entry.metadata?.method ?? "?"}
              </span>
              <span className="font-mono">
                {entry.metadata?.path ?? "(unknown)"}
              </span>
              {entry.metadata?.ip ? (
                <span className="ml-2 text-text-muted">
                  · IP {entry.metadata.ip}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotificationConfig({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const { user } = useUser();
  const role = (user?.systemRole || "").toUpperCase();
  const isAdmin = ADMIN_ROLES.includes(role);

  const [webhookUrl, setWebhookUrl] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<OrgWebhookConfig>("/organizations/me");
        if (cancelled) return;
        setWebhookUrl(data.staffAccessWebhookUrl ?? "");
        setNotifyEmail(data.staffAccessNotifyEmail ?? "");
      } catch (err) {
        console.warn("[settings/security/notify-config] load failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!user) return null;

  if (!isAdmin) {
    return (
      <div className="border-t border-border-subtle pt-4">
        <p className="text-xs text-text-muted">
          Your admin can configure real-time notifications for Pocket Fund staff
          access in Settings → Security &amp; Privacy.
        </p>
      </div>
    );
  }

  const validate = (): string | null => {
    if (webhookUrl) {
      try {
        const u = new URL(webhookUrl);
        if (u.protocol !== "https:") return "Webhook URL must use https://";
      } catch {
        return "Webhook URL is not a valid URL";
      }
    }
    if (notifyEmail) {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail);
      if (!emailOk) return "Notification email is not valid";
    }
    return null;
  };

  const save = async () => {
    if (saving) return;
    const validationErr = validate();
    if (validationErr) {
      onToast(validationErr, "error");
      return;
    }
    setSaving(true);
    try {
      await api.patch<OrgWebhookConfig>("/organizations/me/staff-access-webhook", {
        staffAccessWebhookUrl: webhookUrl || null,
        staffAccessNotifyEmail: notifyEmail || null,
      });
      const wired = !!(webhookUrl || notifyEmail);
      onToast(
        wired
          ? "Saved. Test event sent — check your Slack/email."
          : "Notifications disabled.",
        "success",
      );
    } catch (err) {
      console.warn("[settings/security/notify-config] save failed:", err);
      onToast(
        err instanceof Error ? err.message : "Failed to save notification config",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border-subtle pt-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-text-main">
          Real-time notifications
        </p>
        <p className="text-xs text-text-muted mt-0.5">
          Page your security team the moment Pocket Fund staff accesses your
          data. Configure a Slack incoming webhook URL and/or an email address.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1">
            Slack webhook URL
          </span>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            disabled={loading}
            placeholder="https://hooks.slack.com/services/..."
            className="w-full px-3 py-2 text-sm rounded-md border border-border-subtle bg-white text-text-main placeholder-text-muted focus:outline-none focus:ring-2 disabled:opacity-50"
            style={{
              outlineColor: "#003366",
            }}
          />
        </label>

        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1">
            Notification email
          </span>
          <input
            type="email"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
            disabled={loading}
            placeholder="security@yourfirm.com"
            className="w-full px-3 py-2 text-sm rounded-md border border-border-subtle bg-white text-text-main placeholder-text-muted focus:outline-none focus:ring-2 disabled:opacity-50"
            style={{
              outlineColor: "#003366",
            }}
          />
        </label>

        <button
          type="button"
          onClick={save}
          disabled={saving || loading}
          className="px-4 py-2 text-white text-sm font-semibold rounded-lg transition-colors shadow-card disabled:opacity-50"
          style={{ backgroundColor: "#003366" }}
        >
          {saving ? "Saving and sending test..." : "Save and test"}
        </button>
      </div>
    </div>
  );
}

export function StaffAccessLog({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  return (
    <div className="border-t border-border-subtle pt-4 space-y-4">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-text-secondary">
          policy
        </span>
        <div>
          <p className="text-sm font-semibold text-text-main">
            Pocket Fund staff access log
          </p>
          <p className="text-xs text-text-muted">
            Every time a Pocket Fund employee accesses your data, you see it
            here in real-time.
          </p>
        </div>
      </div>

      <StaffAccessFeed />
      <NotificationConfig onToast={onToast} />
    </div>
  );
}
