"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

// Active sessions list + revoke. Backed by /api/auth/sessions which
// gracefully degrades to 501 if the Supabase auth schema isn't exposed
// in PostgREST — we surface that as a friendly empty state instead of
// an error.

interface Session {
  id: string;
  lastActiveAt: string | null;
  createdAt: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

function relTime(ts: string | null): string {
  if (!ts) return "—";
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function shortDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Browser";
}

export function ActiveSessions({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ sessions: Session[] }>("/auth/sessions");
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setDegraded(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        setDegraded(true);
      } else {
        console.warn("[settings/security/sessions] load failed:", err);
      }
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (id: string) => {
    setRevokingId(id);
    try {
      await api.delete<{ success: true }>(`/auth/sessions/${id}`);
      onToast("Session revoked", "success");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        onToast("Session revocation unavailable in this environment", "error");
      } else {
        onToast(
          err instanceof Error ? err.message : "Failed to revoke session",
          "error",
        );
      }
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-text-secondary">devices</span>
          <div>
            <p className="text-sm font-semibold text-text-main">Active sessions</p>
            <p className="text-xs text-text-muted">
              Devices currently signed into your account.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-text-muted hover:text-text-main font-medium uppercase tracking-wide transition-colors disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {degraded ? (
        <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle text-xs text-text-muted">
          Session management is unavailable in this environment. (Supabase{" "}
          <code className="font-mono">auth</code> schema is not exposed via PostgREST.)
        </div>
      ) : loading && sessions === null ? (
        <p className="text-xs text-text-muted py-2">Loading sessions...</p>
      ) : sessions && sessions.length > 0 ? (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-lg border border-border-subtle"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-text-main truncate">
                    {shortDevice(s.userAgent)}
                  </p>
                  {s.current && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-green-50 text-green-700 border border-green-200">
                      This device
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted truncate">
                  {s.ipAddress || "Unknown IP"} · last active {relTime(s.lastActiveAt)}
                </p>
              </div>
              {!s.current && (
                <button
                  type="button"
                  onClick={() => revoke(s.id)}
                  disabled={revokingId === s.id}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md border border-red-200 text-red-600 bg-white hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  {revokingId === s.id ? "Revoking..." : "Sign out"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-muted py-2">No other active sessions.</p>
      )}
    </div>
  );
}
