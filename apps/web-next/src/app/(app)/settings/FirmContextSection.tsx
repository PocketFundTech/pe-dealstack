"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// ─── Types ──────────────────────────────────────────────────────────

interface FirmContext {
  text: string;
  generatedAt: string;
  sourcesUsed: string[];
}

interface GetFirmContextResponse {
  firmContext: FirmContext | null;
}

interface Status {
  type: "success" | "error" | "loading";
  text: string;
}

// ─── Component ──────────────────────────────────────────────────────

export function FirmContextSection() {
  const [text, setText] = useState("");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);
  const [hasContext, setHasContext] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const applyContext = useCallback((ctx: FirmContext) => {
    setText(ctx.text || "");
    setGeneratedAt(ctx.generatedAt || null);
    setSourcesUsed(Array.isArray(ctx.sourcesUsed) ? ctx.sourcesUsed : []);
    setHasContext(true);
  }, []);

  const loadFirmContext = useCallback(async () => {
    try {
      const data = await api.get<GetFirmContextResponse>("/firm-context");
      if (data?.firmContext) {
        applyContext(data.firmContext);
      } else {
        setHasContext(false);
      }
      setLoadError(false);
    } catch (err) {
      console.warn("[settings/firm-context] failed to load:", err);
      setLoadError(true);
      setHasContext(false);
    } finally {
      setLoading(false);
    }
  }, [applyContext]);

  useEffect(() => {
    loadFirmContext();
  }, [loadFirmContext]);

  const runGenerate = async () => {
    setConfirmRegenerate(false);
    setGenerating(true);
    setStatus({ type: "loading", text: "Generating… (15–30s)" });
    try {
      const result = await api.post<FirmContext>("/firm-context/generate", {});
      applyContext(result);
      setStatus({ type: "success", text: "Firm context generated" });
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      console.warn("[settings/firm-context] generate failed:", err);
      setStatus({ type: "error", text: "Generation failed. Try again." });
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateClick = () => {
    if (hasContext) {
      setConfirmRegenerate(true);
    } else {
      runGenerate();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus({ type: "loading", text: "Saving…" });
    try {
      await api.put<{ ok: true }>("/firm-context", { text });
      setStatus({ type: "success", text: "Saved" });
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      console.warn("[settings/firm-context] save failed:", err);
      setStatus({ type: "error", text: "Save failed. Try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      id="section-firm-context"
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
    >
      <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-light rounded-lg text-primary border border-primary/20">
            <span className="material-symbols-outlined text-[20px] block">menu_book</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-text-main">Firm Context</h2>
            <p className="text-xs text-text-muted">
              A generated brief your AI assistant uses as standing context across deals, chat, teasers, and memos.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <div
              className={`text-sm flex items-center gap-2 ${
                status.type === "success"
                  ? "text-green-600"
                  : status.type === "error"
                    ? "text-red-500"
                    : "text-primary"
              }`}
            >
              {status.type === "loading" && (
                <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              )}
              {status.type === "success" && (
                <span
                  className="material-symbols-outlined text-[16px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
              )}
              {status.text}
            </div>
          )}
          <button
            type="button"
            onClick={handleGenerateClick}
            disabled={generating || saving || loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#003366" }}
          >
            <span className={`material-symbols-outlined text-[16px] ${generating ? "animate-spin" : ""}`}>
              {generating ? "progress_activity" : hasContext ? "refresh" : "auto_awesome"}
            </span>
            {generating ? "Generating…" : hasContext ? "Regenerate" : "Generate"}
          </button>
        </div>
      </div>
      <div className="p-6">
        {loading ? (
          <p className="text-sm text-text-muted">Loading firm context…</p>
        ) : loadError ? (
          <p className="text-sm text-text-muted">Could not load firm context.</p>
        ) : !hasContext ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-6 border border-dashed border-border-subtle rounded-lg">
            <span className="material-symbols-outlined text-[32px] text-text-muted mb-2">auto_awesome</span>
            <p className="text-sm font-medium text-text-main mb-1">No firm context yet</p>
            <p className="text-xs text-text-muted max-w-md">
              Click <span className="font-medium">Generate</span> in the top-right to synthesize a standing brief from
              your firm profile and teaser settings. You can edit the result afterwards.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {generatedAt && (
                <span className="text-xs text-text-muted">
                  Generated {formatRelativeTime(generatedAt)}
                </span>
              )}
              {sourcesUsed.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {sourcesUsed.map((source) => (
                    <span
                      key={source}
                      className="inline-flex items-center px-2 py-0.5 rounded-full bg-primary-light text-primary text-[11px] font-medium border border-primary/20"
                    >
                      {source}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              disabled={generating}
              className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 font-mono"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || generating}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-border-subtle hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className={`material-symbols-outlined text-[16px] ${saving ? "animate-spin" : ""}`}>
                  {saving ? "progress_activity" : "save"}
                </span>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRegenerate}
        title="Regenerate firm context?"
        message="This will overwrite the current firm context with a freshly synthesized version. Any unsaved edits will be lost."
        confirmLabel="Regenerate"
        onConfirm={runGenerate}
        onCancel={() => setConfirmRegenerate(false)}
      />
    </section>
  );
}
