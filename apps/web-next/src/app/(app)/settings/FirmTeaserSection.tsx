"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, NotFoundError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { TeaserCriterion, TeaserProfile } from "@/lib/teaser";
import { ProfilePicker } from "./firm-teaser/ProfilePicker";
import { CriteriaEditor } from "./firm-teaser/CriteriaEditor";

// ─── Constants ──────────────────────────────────────────────────────

const ROUTES = {
  config: "/firm-teaser",
  generatePrompt: "/firm-teaser/generate-prompt",
} as const;

// Banker Blue per repo style rules (inline, not a Tailwind class).
const BANKER_BLUE = "#003366";
const DEFAULT_PROFILE_NAME = "New profile";

// ─── Helpers ────────────────────────────────────────────────────────

function makeProfile(name = DEFAULT_PROFILE_NAME): TeaserProfile {
  return {
    id: crypto.randomUUID(),
    name,
    systemPrompt: "",
    criteria: [],
    updatedAt: new Date().toISOString(),
  };
}

function makeCriterion(): TeaserCriterion {
  return { id: crypto.randomUUID(), label: "", value: "" };
}

// ─── Component ──────────────────────────────────────────────────────

export function FirmTeaserSection() {
  const { showToast } = useToast();

  const [profiles, setProfiles] = useState<TeaserProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // GEN (system-prompt authoring) state
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId) ?? null,
    [profiles, activeId],
  );

  // ── Load saved profiles ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ profiles: TeaserProfile[] }>(ROUTES.config);
        if (cancelled) return;
        const loaded = Array.isArray(data?.profiles) ? data.profiles : [];
        setProfiles(loaded);
        setActiveId(loaded[0]?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        // 404 = endpoint/migration not deployed yet — treat as empty state, no toast.
        if (err instanceof NotFoundError) {
          console.warn("[settings/firm-teaser] config endpoint not found, using empty state");
        } else {
          console.warn("[settings/firm-teaser] failed to load config:", err);
          showToast(
            err instanceof Error ? err.message : "Failed to load teaser profiles",
            "error",
          );
        }
        setProfiles([]);
        setActiveId(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  // ── Profile mutation helpers ─────────────────────────────────────
  const patchActive = useCallback(
    (patch: Partial<TeaserProfile>) => {
      if (!activeId) return;
      setProfiles((prev) =>
        prev.map((p) =>
          p.id === activeId ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
        ),
      );
    },
    [activeId],
  );

  const handleAddProfile = () => {
    const next = makeProfile();
    setProfiles((prev) => [...prev, next]);
    setActiveId(next.id);
    setGenerateError(null);
  };

  const handleRename = (id: string, name: string) => {
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name, updatedAt: new Date().toISOString() } : p)),
    );
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== deleteId);
      if (activeId === deleteId) setActiveId(next[0]?.id ?? null);
      return next;
    });
    setDeleteId(null);
  };

  const handleAddCriterion = () =>
    patchActive({ criteria: [...(activeProfile?.criteria ?? []), makeCriterion()] });

  const handleUpdateCriterion = (
    id: string,
    patch: Partial<Pick<TeaserCriterion, "label" | "value">>,
  ) =>
    patchActive({
      criteria: (activeProfile?.criteria ?? []).map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });

  const handleRemoveCriterion = (id: string) =>
    patchActive({ criteria: (activeProfile?.criteria ?? []).filter((c) => c.id !== id) });

  // ── Save ─────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.put<{ profiles: TeaserProfile[] }>(ROUTES.config, { profiles });
      const saved = Array.isArray(data?.profiles) ? data.profiles : profiles;
      setProfiles(saved);
      if (!saved.some((p) => p.id === activeId)) setActiveId(saved[0]?.id ?? null);
      showToast("Teaser profiles saved", "success");
    } catch (err) {
      console.warn("[settings/firm-teaser] save failed:", err);
      showToast(
        err instanceof Error ? err.message : "Failed to save teaser profiles",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // ── Generate system prompt from notes + criteria ─────────────────
  const handleGeneratePrompt = async () => {
    if (!activeProfile) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const data = await api.post<{ systemPrompt: string }>(ROUTES.generatePrompt, {
        name: activeProfile.name,
        notes: activeProfile.systemPrompt,
        criteria: activeProfile.criteria,
        contextText: activeProfile.contextText ?? "",
      });
      const generated = typeof data?.systemPrompt === "string" ? data.systemPrompt.trim() : "";
      if (!generated) {
        setGenerateError("Generation returned an empty prompt — try again.");
        return;
      }
      patchActive({ systemPrompt: generated });
      showToast("System prompt generated", "success");
    } catch (err) {
      console.warn("[settings/firm-teaser] generate-prompt failed:", err);
      setGenerateError(
        err instanceof NotFoundError
          ? "Generation is not available yet (endpoint not deployed)."
          : err instanceof Error
            ? err.message
            : "Failed to generate system prompt",
      );
    } finally {
      setGenerating(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  return (
    <section
      id="section-firm-teaser"
      className="scroll-mt-6 overflow-hidden rounded-xl border border-border-subtle bg-surface-card shadow-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-primary/20 bg-primary-light p-2 text-primary">
            <span className="material-symbols-outlined block text-[20px]">auto_awesome</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-text-main">Firm Teaser</h2>
            <p className="text-xs text-text-muted">
              Internal triage blurbs scoring each deal against your investment criteria. Keep
              several profiles (one per fund/strategy).
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: BANKER_BLUE }}
        >
          {saving && (
            <span className="material-symbols-outlined animate-spin text-[18px]">sync</span>
          )}
          Save
        </button>
      </div>

      <div className="p-6">
        {loading ? (
          <p className="text-sm text-text-muted">Loading teaser profiles…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <ProfilePicker
              profiles={profiles}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
                setGenerateError(null);
              }}
              onAdd={handleAddProfile}
              onRename={handleRename}
              onRequestDelete={setDeleteId}
            />

            {activeProfile ? (
              <CriteriaEditor
                criteria={activeProfile.criteria}
                systemPrompt={activeProfile.systemPrompt}
                contextText={activeProfile.contextText ?? ""}
                onAddCriterion={handleAddCriterion}
                onUpdateCriterion={handleUpdateCriterion}
                onRemoveCriterion={handleRemoveCriterion}
                onSystemPromptChange={(value) => patchActive({ systemPrompt: value })}
                onContextTextChange={(value) => patchActive({ contextText: value })}
                onGenerate={handleGeneratePrompt}
                generating={generating}
                generateError={generateError}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-border-subtle bg-[#F8F9FA] px-3 py-6 text-center text-sm text-text-muted">
                No teaser profiles yet. Click &ldquo;Add profile&rdquo; to create your first one.
              </p>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteId}
        title="Delete profile"
        message="Delete this teaser profile? Its criteria and instructions will be removed. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </section>
  );
}
