"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// ─── Constants ──────────────────────────────────────────────────────
//
// Backend contract: apps/api/src/routes/outreach-settings.ts, mounted at
// /api/outreach — GET/PATCH /outreach/settings, POST /outreach/settings/reset.
// Org-scoped: controls the Stale view threshold and which auto-advance rules
// fire on the outreach board (apps/web-next/.../outreach/page.tsx).

// Banker Blue per repo style rules (inline, not a Tailwind class).
const BANKER_BLUE = "#003366";

const ROUTES = {
  settings: "/outreach/settings",
  reset: "/outreach/settings/reset",
} as const;

interface OutreachSettings {
  staleDays: number;
  autoAdvanceSourceToEnrich: boolean;
  autoAdvanceEnrichToSend: boolean;
  autoAdvanceSendToHandleReply: boolean;
}

const DEFAULT_SETTINGS: OutreachSettings = {
  staleDays: 21,
  autoAdvanceSourceToEnrich: true,
  autoAdvanceEnrichToSend: true,
  autoAdvanceSendToHandleReply: true,
};

type ToggleKey =
  | "autoAdvanceSourceToEnrich"
  | "autoAdvanceEnrichToSend"
  | "autoAdvanceSendToHandleReply";

const TOGGLE_ITEMS: Array<{ key: ToggleKey; label: string; description: string }> = [
  {
    key: "autoAdvanceSourceToEnrich",
    label: "Source → Enrich",
    description: "Automatically move a contact from Source to Enrich once enrichment finds something.",
  },
  {
    key: "autoAdvanceEnrichToSend",
    label: "Enrich → Send",
    description: "Automatically move a contact from Enrich to Send once it has a real email address.",
  },
  {
    key: "autoAdvanceSendToHandleReply",
    label: "Send → Handle Reply",
    description: "Automatically move a contact from Send to Handle Reply once it's actually been sent.",
  },
];

// ─── Component ──────────────────────────────────────────────────────

export function OutreachPipelineSection() {
  const { showToast } = useToast();

  const [settings, setSettings] = useState<OutreachSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState<OutreachSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<OutreachSettings>(ROUTES.settings);
      setSettings(data);
      setLoaded(data);
    } catch (err) {
      console.warn("[settings/outreach-pipeline] load failed:", err);
      setLoadError(
        err instanceof Error ? err.message : "Failed to load outreach pipeline settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Dirty / validity checks ───────────────────────────────────────
  const hasChanges = useMemo(() => {
    if (!loaded) return false;
    return (
      settings.staleDays !== loaded.staleDays ||
      settings.autoAdvanceSourceToEnrich !== loaded.autoAdvanceSourceToEnrich ||
      settings.autoAdvanceEnrichToSend !== loaded.autoAdvanceEnrichToSend ||
      settings.autoAdvanceSendToHandleReply !== loaded.autoAdvanceSendToHandleReply
    );
  }, [settings, loaded]);

  const staleDaysValid =
    Number.isInteger(settings.staleDays) && settings.staleDays >= 1 && settings.staleDays <= 365;

  const canSave = !loading && !loadError && !saving && !resetting && hasChanges && staleDaysValid;

  // ── Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!loaded || !canSave) return;
    setSaving(true);
    try {
      const patch: Partial<OutreachSettings> = {};
      if (settings.staleDays !== loaded.staleDays) patch.staleDays = settings.staleDays;
      if (settings.autoAdvanceSourceToEnrich !== loaded.autoAdvanceSourceToEnrich) {
        patch.autoAdvanceSourceToEnrich = settings.autoAdvanceSourceToEnrich;
      }
      if (settings.autoAdvanceEnrichToSend !== loaded.autoAdvanceEnrichToSend) {
        patch.autoAdvanceEnrichToSend = settings.autoAdvanceEnrichToSend;
      }
      if (settings.autoAdvanceSendToHandleReply !== loaded.autoAdvanceSendToHandleReply) {
        patch.autoAdvanceSendToHandleReply = settings.autoAdvanceSendToHandleReply;
      }
      if (Object.keys(patch).length === 0) return;

      const updated = await api.patch<OutreachSettings>(ROUTES.settings, patch);
      setSettings(updated);
      setLoaded(updated);
      showToast("Outreach pipeline settings saved", "success");
    } catch (err) {
      console.warn("[settings/outreach-pipeline] save failed:", err);
      showToast(
        err instanceof Error ? err.message : "Failed to save outreach pipeline settings",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ── Reset to defaults ─────────────────────────────────────────────
  const handleResetConfirm = async () => {
    setShowResetConfirm(false);
    setResetting(true);
    try {
      const defaults = await api.post<OutreachSettings>(ROUTES.reset, {});
      setSettings(defaults);
      setLoaded(defaults);
      showToast("Reset to defaults", "success");
    } catch (err) {
      console.warn("[settings/outreach-pipeline] reset failed:", err);
      showToast(
        err instanceof Error ? err.message : "Failed to reset outreach pipeline settings",
        "error",
      );
    } finally {
      setResetting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  return (
    <section
      id="section-outreach-pipeline"
      className="scroll-mt-6 overflow-hidden rounded-xl border border-border-subtle bg-surface-card shadow-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-primary/20 bg-primary-light p-2 text-primary">
            <span className="material-symbols-outlined block text-[20px]">tune</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-text-main">Outreach Pipeline</h2>
            <p className="text-xs text-text-muted">
              Controls how contacts move through the outreach board automatically.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            disabled={loading || !!loadError || saving || resetting}
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {resetting && (
              <span className="material-symbols-outlined animate-spin text-[16px]">sync</span>
            )}
            Reset to Defaults
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: BANKER_BLUE }}
          >
            {saving && (
              <span className="material-symbols-outlined animate-spin text-[18px]">sync</span>
            )}
            Save
          </button>
        </div>
      </div>

      <div className="p-6">
        {loading ? (
          <p className="text-sm text-text-muted">Loading outreach pipeline settings…</p>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <span>{loadError}</span>
            <button
              type="button"
              onClick={load}
              className="shrink-0 text-xs font-semibold underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Stale threshold */}
            <label className="block max-w-xs">
              <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">
                Stale threshold (days)
              </span>
              <input
                type="number"
                min={1}
                max={365}
                value={Number.isNaN(settings.staleDays) ? "" : settings.staleDays}
                onChange={(e) => {
                  const raw = e.target.value;
                  setSettings((prev) => ({
                    ...prev,
                    staleDays: raw === "" ? NaN : Number(raw),
                  }));
                }}
                className="mt-1 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="mt-1 text-xs text-text-muted">
                Contacts with no activity in this many days show up in the board&apos;s Stale
                view.
              </p>
              {!staleDaysValid && (
                <p className="mt-1 text-xs text-red-600">
                  Enter a whole number between 1 and 365.
                </p>
              )}
            </label>

            {/* Auto-advance toggles */}
            <div className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {TOGGLE_ITEMS.map((item) => {
                const enabled = settings[item.key];
                return (
                  <div
                    key={item.key}
                    className="flex items-center justify-between gap-4 px-4 py-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-main">{item.label}</p>
                      <p className="text-xs text-text-muted">{item.description}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      onClick={() =>
                        setSettings((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                      }
                      className={cn(
                        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                        enabled ? "bg-primary" : "bg-gray-300",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform",
                          enabled ? "translate-x-5" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>

            {hasChanges && (
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                <span className="material-symbols-outlined text-[14px]">info</span>
                You have unsaved changes.
              </p>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showResetConfirm}
        title="Reset to Defaults"
        message="Reset the stale threshold and auto-advance rules to their defaults (21 days, all auto-advance rules on)? This overwrites your current pipeline settings."
        confirmLabel="Reset"
        variant="danger"
        onConfirm={handleResetConfirm}
        onCancel={() => setShowResetConfirm(false)}
      />
    </section>
  );
}
