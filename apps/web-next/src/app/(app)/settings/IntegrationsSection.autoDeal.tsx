"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";

// Firm-wide switch for what Gmail sync does with deal emails
// (Organization.settings.autoDeal, read by the Gmail sync). OFF: emails are
// synced and scored only — the Inbox Deal Finder is the review-first way to
// add deals. ON: matched deals get updates (sensitive fields wait for
// approval) and new deals are created at or above the confidence threshold.
// Shown once Gmail is connected; only admins can change it.

interface AutoDealSettings {
  enabled: boolean;
  createThreshold: number;
  canEdit: boolean;
}

const THRESHOLDS = [0.75, 0.85, 0.95] as const;

export function GmailAutoDealToggle({
  onToast,
}: {
  onToast: (message: string, type: "success" | "error" | "info") => void;
}) {
  const [settings, setSettings] = useState<AutoDealSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<AutoDealSettings>("/integrations/auto-deal")
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch((err) => console.warn("[settings/integrations/auto-deal] load failed:", err));
    return () => { cancelled = true; };
  }, []);

  if (!settings) return null;

  const save = async (patch: Partial<Pick<AutoDealSettings, "enabled" | "createThreshold">>) => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await api.patch<AutoDealSettings>("/integrations/auto-deal", patch);
      setSettings(next);
      if (patch.enabled !== undefined) {
        onToast(next.enabled ? "Gmail will now create and update deals" : "Gmail auto-create turned off", "success");
      } else {
        onToast("Confidence threshold saved", "success");
      }
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : "Could not save";
      onToast(`Could not save: ${msg}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const { enabled, createThreshold, canEdit } = settings;

  return (
    <div className="mt-4 rounded-lg border border-border-subtle p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-text-main">Create deals from Gmail automatically</p>
          <p className="mt-0.5 text-xs text-text-muted">
            {enabled
              ? "New deal emails become deals when the AI is confident enough. Emails about an existing deal update it; changes to size, stage, revenue, EBITDA or owner wait for your approval."
              : "Off: emails are synced and linked to your contacts and deals, but no deals are created or changed. Use the Inbox Deal Finder on the dashboard to review candidates."}
          </p>
          {!canEdit && <p className="mt-1 text-xs text-text-muted">Only an admin can change this.</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Create deals from Gmail automatically"
          disabled={!canEdit || saving}
          onClick={() => save({ enabled: !enabled })}
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
      {enabled && (
        <label className="mt-3 flex items-center gap-2 text-xs text-text-muted">
          Create a deal when the AI is at least
          <select
            value={createThreshold}
            disabled={!canEdit || saving}
            onChange={(e) => save({ createThreshold: Number(e.target.value) })}
            className="rounded border border-border-subtle bg-surface-card px-2 py-1 text-xs text-text-main"
          >
            {/* Keep a custom value set outside the UI selectable. */}
            {[...new Set([...THRESHOLDS, createThreshold])].sort().map((t) => (
              <option key={t} value={t}>{Math.round(t * 100)}%</option>
            ))}
          </select>
          sure it&apos;s a deal email
        </label>
      )}
    </div>
  );
}
