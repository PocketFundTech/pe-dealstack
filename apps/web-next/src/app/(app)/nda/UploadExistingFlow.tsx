"use client";

import { useState } from "react";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { cn } from "@/lib/cn";
import { DealPicker, type PickableDeal } from "./DealPicker";
import { UploadExistingMetadataForm } from "./UploadExistingMetadataForm";
import type {
  LegalDocument,
  UploadExistingKind,
  UploadExistingMetadata,
} from "./types";

interface UploadExistingFlowProps {
  /**
   * Pre-resolved deal context. When provided we skip the deal picker step
   * and go straight to file pick + metadata. The page.tsx state machine
   * passes this through when the user starts the flow from a deal-scoped
   * entry point in the future. v1 always starts at pickDeal.
   */
  initialDeal?: PickableDeal;
  onCancel: () => void;
  onCreated: (doc: LegalDocument) => void;
}

type Step =
  | { kind: "pickDeal" }
  | { kind: "pickFile"; deal: PickableDeal }
  | {
      kind: "form";
      deal: PickableDeal;
      file: File;
      fileKind: UploadExistingKind;
      suggestedTitle: string;
    };

const ACCEPTED_EXT = ["docx", "html", "md", "pdf"] as const;
type AcceptedExt = (typeof ACCEPTED_EXT)[number];

function detectFileKind(name: string): AcceptedExt | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  // .htm aliases to .html for the kind enum
  if (ext === "htm") return "html";
  return (ACCEPTED_EXT as readonly string[]).includes(ext)
    ? (ext as AcceptedExt)
    : null;
}

function stripExtension(name: string): string {
  return name.replace(/\.(docx|html|htm|md|markdown|pdf)$/i, "");
}

/**
 * Three-step import flow for an NDA that was sent or signed outside this
 * app. Mirrors TemplateUploadFlow's drop-zone UX but lands on a
 * LegalDocument row instead of a LegalDocTemplate.
 *
 * Steps:
 *   1) pickDeal — DealPicker modal (skipped if initialDeal supplied)
 *   2) pickFile — full-screen drop-zone for .docx / .html / .md
 *   3) form     — metadata + status (SENT|SIGNED); submit fires the
 *                 multipart POST and hands the row back to the parent
 *
 * Parsing happens server-side on submit (one round-trip) — we don't
 * stream the file to a separate /parse endpoint first because the only
 * thing we'd do with the parsed body before submit is show it read-only,
 * which the FullEditPage already handles after creation.
 */
export function UploadExistingFlow({
  initialDeal,
  onCancel,
  onCreated,
}: UploadExistingFlowProps) {
  const [step, setStep] = useState<Step>(
    initialDeal ? { kind: "pickFile", deal: initialDeal } : { kind: "pickDeal" },
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function handleDealSelect(deal: PickableDeal) {
    setStep({ kind: "pickFile", deal });
  }

  function handleFile(file: File) {
    const detected = detectFileKind(file.name);
    if (!detected) {
      setPickError(
        "Unsupported file type. Drop a .docx, .html, .md, or .pdf file.",
      );
      return;
    }
    setPickError(null);
    setStep((prev) =>
      prev.kind === "pickFile"
        ? {
            kind: "form",
            deal: prev.deal,
            file,
            fileKind: detected,
            suggestedTitle: stripExtension(file.name),
          }
        : prev,
    );
  }

  function handleDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function handleBrowse(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so re-selecting the same file fires onChange again.
    e.target.value = "";
  }

  async function handleSubmit(meta: UploadExistingMetadata) {
    if (step.kind !== "form") return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.append("file", step.file);
      fd.append("kind", step.fileKind);
      // Append metadata fields individually — multer/Express parse the
      // form-data into req.body and zod coerces from there. Skip undefined
      // so the optional fields remain genuinely optional server-side.
      for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null) continue;
        fd.append(key, String(value));
      }
      // authFetchRaw + FormData — do NOT set Content-Type so the browser
      // attaches the multipart boundary. Mandatory per CLAUDE.md.
      const res = await authFetchRaw(
        `/deals/${step.deal.id}/legal-documents/upload`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const code = (body as { code?: string }).code;
        const msg =
          (body as { error?: string; message?: string }).error ??
          (body as { message?: string }).message ??
          `Import failed (${res.status})`;
        if (code === "INVALID_FILE_FORMAT") {
          throw new Error(
            "We couldn't read that file. Try a different .docx, .html, .md, or .pdf.",
          );
        }
        throw new Error(msg);
      }
      const doc = (await res.json()) as LegalDocument;
      onCreated(doc);
    } catch (err) {
      console.warn("[nda] upload-existing failed:", err);
      setSubmitError(err instanceof Error ? err.message : "Failed to import NDA");
    } finally {
      setSubmitting(false);
    }
  }

  if (step.kind === "pickDeal") {
    return (
      <DealPicker open onCancel={onCancel} onSelect={handleDealSelect} />
    );
  }

  if (step.kind === "pickFile") {
    return (
      <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col">
        {/* Header */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Back"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </button>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">
              Import existing NDA
            </h2>
            <p className="text-xs text-slate-500 truncate">
              For{" "}
              <span className="text-[#003366] font-medium">{step.deal.label}</span>
              {" · "}Drop the file you want to archive — we&rsquo;ll parse it
              and you&rsquo;ll fill in metadata next.
            </p>
          </div>
        </div>

        {/* Body — drop zone, centered */}
        <div className="flex-1 overflow-y-auto flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-xl">
            {pickError && (
              <div className="mb-4 rounded-lg px-3 py-2.5 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
                <div className="flex-1 min-w-0">{pickError}</div>
              </div>
            )}
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={cn(
                "block rounded-xl border-2 border-dashed bg-white p-10 text-center cursor-pointer transition",
                dragging
                  ? "border-[#003366] bg-[#E6EEF5]/40"
                  : "border-slate-300 hover:border-[#003366] hover:bg-[#E6EEF5]/30",
              )}
            >
              <input
                type="file"
                accept=".docx,.html,.htm,.md,.pdf"
                onChange={handleBrowse}
                className="hidden"
              />
              <div className="mx-auto w-12 h-12 rounded-full bg-[#E6EEF5] flex items-center justify-center text-[#003366] mb-3">
                <span className="material-symbols-outlined text-[28px]">
                  upload_file
                </span>
              </div>
              <div className="text-sm font-semibold text-slate-800">
                Drag &amp; drop the NDA file, or click to browse
              </div>
              <div className="text-[12px] text-slate-500 mt-1">
                Accepts <span className="font-mono">.docx</span>,{" "}
                <span className="font-mono">.html</span>,{" "}
                <span className="font-mono">.md</span>, or{" "}
                <span className="font-mono">.pdf</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-3">
                PDF text is extracted as plain paragraphs — you can edit
                the structure in the in-app editor after import.
              </div>
            </label>
          </div>
        </div>
      </div>
    );
  }

  // step.kind === "form"
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && !submitting && onCancel()}
    >
      <UploadExistingMetadataForm
        dealLabel={step.deal.label}
        suggestedTitle={step.suggestedTitle}
        originalFileName={step.file.name}
        submitting={submitting}
        error={submitError}
        onBack={() =>
          setStep((prev) =>
            prev.kind === "form" ? { kind: "pickFile", deal: prev.deal } : prev,
          )
        }
        onCancel={onCancel}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
