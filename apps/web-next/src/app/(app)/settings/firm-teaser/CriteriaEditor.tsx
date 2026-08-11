"use client";

import { useRef, useState } from "react";
import type { TeaserCriterion } from "@/lib/teaser";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";

// Banker Blue per repo style rules (inline, not a Tailwind class).
const BANKER_BLUE = "#003366";

// File types the firm-context extractor accepts (mirrors the backend contract).
const CONTEXT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv";

// Response shape from POST /firm-teaser/extract-context (multipart field `file`).
interface ExtractContextResponse {
  text: string;
  filename: string;
  chars: number;
}

// Editor for the active profile's criteria rows ("rec questions" in the sketch:
// each is a label + the firm's answer/threshold) and the system-prompt box. GEN
// expands the user's rough notes + criteria into a full system prompt in place;
// the user edits and saves it. Pure controlled component — all state lives in
// the parent section so Save sends one consistent profiles array.
export function CriteriaEditor({
  criteria,
  systemPrompt,
  contextText,
  onAddCriterion,
  onUpdateCriterion,
  onRemoveCriterion,
  onSystemPromptChange,
  onContextTextChange,
  onGenerate,
  generating,
  generateError,
}: {
  criteria: TeaserCriterion[];
  systemPrompt: string;
  contextText: string;
  onAddCriterion: () => void;
  onUpdateCriterion: (id: string, patch: Partial<Pick<TeaserCriterion, "label" | "value">>) => void;
  onRemoveCriterion: (id: string) => void;
  onSystemPromptChange: (value: string) => void;
  onContextTextChange: (value: string) => void;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
}) {
  const canGenerate =
    !generating &&
    (criteria.length > 0 || systemPrompt.trim().length > 0 || contextText.trim().length > 0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<{ filename: string; chars: number } | null>(null);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await authFetchRaw("/firm-teaser/extract-context", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        let message = `Extraction failed (${res.status}).`;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          message = body?.error || body?.message || message;
        } catch (parseErr) {
          // Non-JSON error body — keep the status-based message.
          console.warn("[settings/firm-teaser] non-JSON extract-context error body:", parseErr);
        }
        throw new Error(message);
      }
      const data = (await res.json()) as ExtractContextResponse;
      const extracted = typeof data?.text === "string" ? data.text.trim() : "";
      if (!extracted) {
        setUploadError("No text could be extracted from that file.");
        return;
      }
      // Append the extracted doc text into the editable context field.
      const next = contextText.trim().length > 0 ? `${contextText.trim()}\n\n${extracted}` : extracted;
      onContextTextChange(next);
      setLastUpload({
        filename: data.filename || file.name,
        chars: typeof data.chars === "number" ? data.chars : extracted.length,
      });
    } catch (err) {
      console.warn("[settings/firm-teaser] extract-context failed:", err);
      setUploadError(err instanceof Error ? err.message : "Failed to extract document text.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Criteria rows */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs font-bold uppercase tracking-wider text-text-secondary">
            Investment criteria
          </label>
          <button
            type="button"
            onClick={onAddCriterion}
            className="flex items-center gap-1 text-xs font-semibold text-primary hover:opacity-80 transition-opacity"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            Add criterion
          </button>
        </div>

        {criteria.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-subtle bg-[#F8F9FA] px-3 py-4 text-center text-sm text-text-muted">
            No criteria yet. Add rows like &ldquo;Sector&rdquo; / &ldquo;B2B SaaS, healthcare IT&rdquo;.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {criteria.map((row, idx) => (
              <div key={row.id} className="flex items-start gap-2">
                <span className="mt-2.5 w-5 shrink-0 text-center text-xs font-bold text-text-muted">
                  {String.fromCharCode(65 + (idx % 26))}
                </span>
                <input
                  value={row.label}
                  onChange={(e) => onUpdateCriterion(row.id, { label: e.target.value })}
                  placeholder="Criterion (e.g. EBITDA multiple)"
                  className="w-2/5 rounded-lg border border-border-subtle px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <input
                  value={row.value}
                  onChange={(e) => onUpdateCriterion(row.id, { value: e.target.value })}
                  placeholder="Firm's answer / threshold (e.g. 6-7x)"
                  className="flex-1 rounded-lg border border-border-subtle px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={() => onRemoveCriterion(row.id)}
                  className="mt-1 shrink-0 p-1 text-text-muted hover:text-red-500 transition-colors"
                  aria-label="Remove criterion"
                  title="Remove"
                >
                  <span className="material-symbols-outlined text-[18px] block">close</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Firm context — pasted free-text + extracted document text. Grounds
          GEN and is persisted with the profile (an authoring input only — it
          does not affect generated teasers). */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="text-xs font-bold uppercase tracking-wider text-text-secondary">
            Firm context
          </label>
          <div className="flex items-center gap-2">
            {lastUpload && (
              <span className="text-xs text-text-muted" title={lastUpload.filename}>
                {lastUpload.filename} · {lastUpload.chars.toLocaleString()} chars
              </span>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              title="Upload a document to extract its text into the firm context"
            >
              {uploading ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-[15px]">
                    progress_activity
                  </span>
                  Extracting…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[15px]">upload_file</span>
                  Upload document
                </>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={CONTEXT_ACCEPT}
              onChange={handleFileSelected}
              className="hidden"
            />
          </div>
        </div>
        <textarea
          value={contextText}
          onChange={(e) => onContextTextChange(e.target.value)}
          rows={6}
          placeholder="Paste any firm context to ground the prompt — investment thesis, portfolio examples, past deals, IC notes — or upload a document above to extract its text here. It grounds GEN and is saved with the profile."
          className="w-full resize-y rounded-lg border border-border-subtle px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        {uploadError && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="material-symbols-outlined text-[16px]">error</span>
            {uploadError}
          </div>
        )}
      </div>

      {/* System prompt — written by hand, or expanded from notes + criteria via GEN */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="text-xs font-bold uppercase tracking-wider text-text-secondary">
            System prompt
          </label>
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: BANKER_BLUE }}
            title="Expand your notes + criteria into a full system prompt"
          >
            {generating ? (
              <>
                <span className="material-symbols-outlined animate-spin text-[15px]">progress_activity</span>
                Generating…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[15px]">auto_awesome</span>
                GEN
              </>
            )}
          </button>
        </div>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          rows={8}
          placeholder="Jot what you're looking for (e.g. 'I like deep-tech businesses with recurring revenue'), then hit GEN to expand it — using your criteria above — into a full system prompt. Edit it freely before saving."
          className="w-full resize-y rounded-lg border border-border-subtle px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        {generateError && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="material-symbols-outlined text-[16px]">error</span>
            {generateError}
          </div>
        )}
      </div>
    </div>
  );
}
