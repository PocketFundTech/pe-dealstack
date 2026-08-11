"use client";

import { useState } from "react";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { cn } from "@/lib/cn";
import { TemplateVerifier } from "./TemplateVerifier";
import type { LegalDocTemplate, ParsedTemplateDraft } from "./types";

interface TemplateUploadFlowProps {
  onCancel: () => void;
  onSaved: (template: LegalDocTemplate) => void;
}

type Step =
  | { kind: "upload" }
  | { kind: "parsing"; fileName: string }
  | { kind: "verify"; draft: ParsedTemplateDraft };

const ACCEPTED_EXT = ["docx", "html", "md", "pdf"] as const;
type AcceptedExt = (typeof ACCEPTED_EXT)[number];

function fileKind(name: string): AcceptedExt | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  // .htm aliases to .html for the kind enum (mirrors UploadExistingFlow).
  if (ext === "htm") return "html";
  return (ACCEPTED_EXT as readonly string[]).includes(ext)
    ? (ext as AcceptedExt)
    : null;
}

/**
 * Two-step upload flow: drop a file, backend parses to HTML, then hands off
 * to the TemplateVerifier so the user can mark up tokens before saving.
 *
 * The drag-drop zone gates on extension. Parsing failures show inline; the
 * user can drop a different file without remounting.
 */
export function TemplateUploadFlow({
  onCancel,
  onSaved,
}: TemplateUploadFlowProps) {
  const [step, setStep] = useState<Step>({ kind: "upload" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function handleFile(file: File) {
    const kind = fileKind(file.name);
    if (!kind) {
      setError("Unsupported file type. Drop a .docx, .html, .md, or .pdf file.");
      return;
    }
    setError(null);
    setStep({ kind: "parsing", fileName: file.name });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    try {
      // authFetchRaw + FormData — do NOT set Content-Type so the browser
      // adds the multipart boundary itself. CLAUDE.md mandates this path
      // for uploads.
      const res = await authFetchRaw("/legal-document-templates/parse", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const code = (body as { code?: string }).code;
        const msg = (body as { error?: string; message?: string }).error
          ?? (body as { message?: string }).message
          ?? `Parse failed (${res.status})`;
        if (code === "INVALID_FILE_FORMAT") {
          throw new Error(
            "We couldn't read that file. Try a different .docx, .html, .md, or .pdf",
          );
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { draft: ParsedTemplateDraft };
      if (!data?.draft?.bodyHtml) {
        throw new Error("Parse succeeded but no body returned. Try another file.");
      }
      setStep({ kind: "verify", draft: data.draft });
    } catch (err) {
      console.warn("[nda] template parse failed:", err);
      setError(err instanceof Error ? err.message : "Failed to parse file");
      setStep({ kind: "upload" });
    }
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
    // Reset so re-selecting the same file fires onChange.
    e.target.value = "";
  }

  if (step.kind === "verify") {
    return (
      <TemplateVerifier
        mode="create"
        draft={step.draft}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );
  }

  const isParsing = step.kind === "parsing";

  return (
    <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={isParsing}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-50"
          aria-label="Back"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Upload NDA template
          </h2>
          <p className="text-xs text-slate-500">
            Drop a Word doc, HTML, markdown, or PDF file. We&rsquo;ll parse it
            so you can mark up placeholder tokens on the next screen.
          </p>
        </div>
      </div>

      {/* Body — drop zone, centered */}
      <div className="flex-1 overflow-y-auto flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-xl">
          {error && (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
              <div className="flex-1 min-w-0">{error}</div>
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
              isParsing && "pointer-events-none opacity-70",
            )}
          >
            <input
              type="file"
              accept=".docx,.html,.htm,.md,.pdf"
              onChange={handleBrowse}
              className="hidden"
              disabled={isParsing}
            />
            {isParsing ? (
              <>
                <div className="mx-auto w-12 h-12 rounded-full bg-[#E6EEF5] flex items-center justify-center text-[#003366] mb-3">
                  <span className="material-symbols-outlined text-[28px] animate-spin">
                    progress_activity
                  </span>
                </div>
                <div className="text-sm font-semibold text-slate-800">
                  Parsing {step.fileName}…
                </div>
                <div className="text-[12px] text-slate-500 mt-1">
                  This usually takes a second or two.
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto w-12 h-12 rounded-full bg-[#E6EEF5] flex items-center justify-center text-[#003366] mb-3">
                  <span className="material-symbols-outlined text-[28px]">
                    upload_file
                  </span>
                </div>
                <div className="text-sm font-semibold text-slate-800">
                  Drag &amp; drop a file, or click to browse
                </div>
                <div className="text-[12px] text-slate-500 mt-1">
                  Accepts <span className="font-mono">.docx</span>,{" "}
                  <span className="font-mono">.html</span>,{" "}
                  <span className="font-mono">.md</span>, or{" "}
                  <span className="font-mono">.pdf</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-3">
                  PDF text is extracted as plain paragraphs — headings, bold,
                  and lists won&rsquo;t carry over. You can re-format in the
                  verifier.
                </div>
              </>
            )}
          </label>
        </div>
      </div>
    </div>
  );
}
