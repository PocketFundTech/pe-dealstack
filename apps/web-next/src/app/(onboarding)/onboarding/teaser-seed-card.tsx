"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { TeaserCriterion, TeaserProfile } from "@/lib/teaser";

// Optional, SKIPPABLE onboarding card that seeds ONE Firm Teaser profile.
// Lives inside the existing firm step so it never gates onboarding completion —
// it writes via its own "Save criteria" button and is fully independent of the
// step's "Mark as done" flow. Users can ignore it entirely and proceed.
const TEASER_ROUTE = "/firm-teaser";
const SEED_PROFILE_NAME = "Default";
const PLACEHOLDER_ROWS: { label: string; value: string }[] = [
  { label: "EBITDA multiple", value: "e.g. 6-7x" },
  { label: "Sector", value: "e.g. B2B SaaS, healthcare IT" },
  { label: "Check size", value: "e.g. $10-50M" },
];

function makeRow(): TeaserCriterion {
  return { id: crypto.randomUUID(), label: "", value: "" };
}

export function TeaserSeedCard() {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TeaserCriterion[]>(() => [makeRow(), makeRow()]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const updateRow = (id: string, patch: Partial<Pick<TeaserCriterion, "label" | "value">>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRow = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));

  const filledRows = rows.filter((r) => r.label.trim() || r.value.trim());
  const canSave = filledRows.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // Merge into existing profiles if any (don't clobber another seed).
      let existing: TeaserProfile[] = [];
      try {
        const data = await api.get<{ profiles: TeaserProfile[] }>(TEASER_ROUTE);
        existing = Array.isArray(data?.profiles) ? data.profiles : [];
      } catch (err) {
        // 404 (not deployed) or first-time — start fresh.
        console.warn("[onboarding/teaser-seed] no existing profiles:", err);
      }

      const seed: TeaserProfile = {
        id: crypto.randomUUID(),
        name: SEED_PROFILE_NAME,
        systemPrompt: "",
        criteria: filledRows.map((r) => ({
          id: r.id,
          label: r.label.trim(),
          value: r.value.trim(),
        })),
        updatedAt: new Date().toISOString(),
      };

      await api.put(TEASER_ROUTE, { profiles: [...existing, seed] });
      setSaved(true);
      showToast("Saved your first teaser profile", "success");
    } catch (err) {
      console.warn("[onboarding/teaser-seed] save failed:", err);
      showToast(
        err instanceof Error ? err.message : "Couldn't save criteria — you can add them later in Settings",
        "warning",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-5 rounded-lg border border-border-subtle bg-[#F8F9FA] p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-text-main">
          <span className="material-symbols-outlined text-[18px] text-primary">auto_awesome</span>
          Add deal-matching criteria
          <span className="text-[11px] font-normal text-text-muted">(optional)</span>
        </span>
        <span className="material-symbols-outlined text-[20px] text-text-muted">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="mt-3">
          {saved ? (
            <div className="flex items-center gap-2 rounded-lg bg-secondary-light/40 px-3 py-2.5 text-[12px] font-medium text-secondary">
              <span
                className="material-symbols-outlined text-[16px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
              Saved — refine this anytime under Settings → Firm Teaser.
            </div>
          ) : (
            <>
              <p className="mb-2.5 text-[12px] text-text-secondary">
                We&apos;ll use these to write a short internal triage note for each new deal. You
                can skip this and set it up later.
              </p>
              <div className="flex flex-col gap-2">
                {rows.map((row, idx) => {
                  const ph = PLACEHOLDER_ROWS[idx % PLACEHOLDER_ROWS.length];
                  return (
                    <div key={row.id} className="flex items-center gap-2">
                      <input
                        value={row.label}
                        onChange={(e) => updateRow(row.id, { label: e.target.value })}
                        placeholder={ph.label}
                        className="w-2/5 rounded-lg border border-border-subtle bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      />
                      <input
                        value={row.value}
                        onChange={(e) => updateRow(row.id, { value: e.target.value })}
                        placeholder={ph.value}
                        className="flex-1 rounded-lg border border-border-subtle bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      />
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className="shrink-0 p-1 text-text-muted hover:text-red-500 transition-colors"
                        aria-label="Remove criterion"
                      >
                        <span className="material-symbols-outlined text-[16px] block">close</span>
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2.5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setRows((prev) => [...prev, makeRow()])}
                  className="flex items-center gap-1 text-[12px] font-semibold text-primary hover:opacity-80 transition-opacity"
                >
                  <span className="material-symbols-outlined text-[15px]">add</span>
                  Add row
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!canSave}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                  style={{ backgroundColor: "#003366" }}
                >
                  {saving && (
                    <span className="material-symbols-outlined animate-spin text-[15px]">sync</span>
                  )}
                  Save criteria
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
