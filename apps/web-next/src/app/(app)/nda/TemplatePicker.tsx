"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { LegalDocTemplate } from "./types";

interface TemplatePickerProps {
  open: boolean;
  dealLabel: string;
  onCancel: () => void;
  onSelect: (template: LegalDocTemplate) => void;
}

/**
 * Step 2 of the create flow. Only `verifiedAt !== null` templates show up;
 * unverified drafts live in Settings → NDA Templates until someone signs off.
 * No more "blank document" tile — every NDA must come from a template.
 */
export function TemplatePicker({
  open,
  dealLabel,
  onCancel,
  onSelect,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<LegalDocTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<LegalDocTemplate[]>(
        "/legal-document-templates",
      );
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[nda] template list failed:", err);
      setError(err instanceof Error ? err.message : "Failed to load templates");
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Verified only — drafts never appear in the create flow. Default first,
  // then alphabetical, so the most common pick is where the eye lands.
  const verified = templates
    .filter((t) => t.verifiedAt !== null)
    .sort((a, b) => {
      if (a.isDefault === b.isDefault) return a.name.localeCompare(b.name);
      return a.isDefault ? -1 : 1;
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">
              Pick an NDA template
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              For <span className="text-[#003366] font-medium">{dealLabel}</span>{" "}
              · only verified templates are shown
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {error && (
            <div className="mb-3 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-700">
              <span className="material-symbols-outlined text-[18px]">error</span>
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-10 flex flex-col items-center justify-center text-slate-500">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[#003366] mb-3" />
              <span className="text-xs">Loading templates…</span>
            </div>
          ) : verified.length === 0 ? (
            <EmptyNoTemplates />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {verified.map((t) => (
                <TemplateTile
                  key={t.id}
                  template={t}
                  onClick={() => onSelect(t)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface TemplateTileProps {
  template: LegalDocTemplate;
  onClick: () => void;
}

function formatTs(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TemplateTile({ template, onClick }: TemplateTileProps) {
  const lastModified = formatTs(template.updatedAt);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group text-left rounded-lg border bg-white p-4 transition",
        "border-slate-200 hover:border-[#003366] hover:bg-[#E6EEF5]/40 hover:shadow-sm",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: "#E6EEF5", color: "#003366" }}
        >
          <span className="material-symbols-outlined text-[20px]">article</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-slate-900 truncate">
              {template.name}
            </div>
            {template.isDefault && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#003366] text-white shrink-0">
                Default
              </span>
            )}
          </div>
          {lastModified && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              Last modified {lastModified}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function EmptyNoTemplates() {
  return (
    <div className="py-10 flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <span className="material-symbols-outlined text-[24px]">article</span>
      </div>
      <div className="text-sm font-medium text-slate-700">No verified templates yet</div>
      <div className="text-xs text-slate-500 max-w-xs mt-1 mb-4">
        Upload one in Settings → NDA Templates and verify it before drafting
        your first NDA.
      </div>
      <Link
        href="/settings#nda-templates"
        className="px-3.5 py-2 rounded-md text-sm font-medium text-white hover:opacity-90 inline-flex items-center gap-1.5"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[16px]">upload</span>
        Go to Settings
      </Link>
    </div>
  );
}
