"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

// Admin-only toggle for Organization.requireMFA. When enabled, members
// without enrolled 2FA hit a 403 MFA_REQUIRED on protected routes and
// the api.ts interceptor bounces them to /settings#section-security to
// enroll. The toggle bypass list lets admins still flip this without
// being locked out themselves.

interface OrgMe {
  id: string;
  name: string;
  requireMFA?: boolean;
}

const ADMIN_ROLES: Array<string> = ["ADMIN", "PARTNER", "PRINCIPAL"];

export function RequireMfaToggle({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const { user } = useUser();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showEnableConfirm, setShowEnableConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<OrgMe>("/organizations/me");
        if (!cancelled) setEnabled(!!data.requireMFA);
      } catch (err) {
        console.warn("[settings/team/require-mfa] load failed:", err);
        if (!cancelled) setEnabled(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;
  const role = (user.systemRole || "").toUpperCase();
  if (!ADMIN_ROLES.includes(role)) return null;

  const apply = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setShowEnableConfirm(false);
    try {
      await api.patch<OrgMe>("/organizations/me", { requireMFA: next });
      setEnabled(next);
      onToast(
        next
          ? "Org-wide 2FA requirement enabled"
          : "Org-wide 2FA requirement disabled",
        "success",
      );
    } catch (err) {
      console.warn("[settings/team/require-mfa] update failed:", err);
      onToast(
        err instanceof Error ? err.message : "Failed to update setting",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const requestFlip = () => {
    if (enabled === null || saving) return;
    if (!enabled) {
      // Going off → on: confirm because it locks out un-enrolled members.
      setShowEnableConfirm(true);
      return;
    }
    apply(false);
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle flex items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-text-secondary mt-0.5">
            shield_with_heart
          </span>
          <div>
            <p className="text-sm font-semibold text-text-main">
              Require Two-Factor Authentication
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              When enabled, members without 2FA can&apos;t make API calls until
              they enroll.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          disabled={loading || saving || enabled === null}
          onClick={requestFlip}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? "" : "bg-gray-300"
          }`}
          style={enabled ? { backgroundColor: "#003366" } : undefined}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {showEnableConfirm && (
        <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 space-y-3">
          <p className="text-sm font-semibold text-amber-900">
            Require 2FA for everyone in your org?
          </p>
          <p className="text-xs text-amber-800">
            Members without 2FA enrolled will be redirected to enroll on their
            next request. Admins keep access to enrol via this page even when the
            requirement is on.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => apply(true)}
              disabled={saving}
              className="px-4 py-2 text-white text-sm font-semibold rounded-lg transition-colors shadow-card disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              {saving ? "Enabling..." : "Yes, require 2FA"}
            </button>
            <button
              type="button"
              onClick={() => setShowEnableConfirm(false)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
