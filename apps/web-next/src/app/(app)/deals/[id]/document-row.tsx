"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { formatRelativeTime, formatFileSize, getDocIcon } from "@/lib/formatters";
import type { DocItem } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Document row — ported from deal-documents.js (updateDocumentsList +
// fetchAndPreviewDocument + fetchAndShowAnalysis). Whole row is keyboard- and
// click-activatable; an explicit Download button on the right edge triggers
// the same signed URL but forces a download instead of a preview.
// ---------------------------------------------------------------------------

interface DocumentRowProps {
  doc: DocItem;
  onShowAnalysis: (doc: DocItem) => void;
}

// Heuristic for "AI-generated" docs that have no backing file. Mirrors the
// legacy `isGenerated` check in deal-documents.js:17 — `Deal Overview` /
// `Web Research` are the two flows that produce analysis-only documents.
function isAIOnlyDoc(doc: DocItem): boolean {
  if (doc.fileUrl) return false;
  if (doc.aiAnalysis) return true;
  return doc.name.includes("Deal Overview") || doc.name.includes("Web Research");
}

export function DocumentRow({ doc, onShowAnalysis }: DocumentRowProps) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const aiOnly = isAIOnlyDoc(doc);

  /**
   * Fetch the document. PDFs come back as a watermarked binary stream (with
   * the viewer's email + timestamp + IP stamped on every page); other types
   * still come back as a JSON URL pointer. Returns either:
   *   - { kind: "blob", url, filename }  for watermarked PDFs (caller revokes
   *     the URL after use)
   *   - { kind: "passthrough", url }     for non-PDFs / oversized PDFs
   *   - null on failure
   */
  type DocResource =
    | { kind: "blob"; url: string; filename: string }
    | { kind: "passthrough"; url: string };

  async function fetchDocResource(): Promise<DocResource | null> {
    try {
      const res = await api.getRaw(`/documents/${doc.id}/download`);
      if (!res.ok) {
        showToast("Could not load document", "error");
        return null;
      }
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ct.includes("application/pdf")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        return { kind: "blob", url, filename: doc.name };
      }
      const data = (await res.json()) as { url?: string };
      if (!data?.url) {
        showToast("Could not generate preview URL", "error");
        return null;
      }
      return { kind: "passthrough", url: data.url };
    } catch (err) {
      console.error("[doc-row] download URL failed", err);
      showToast("Failed to load document", "error");
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // In-app document preview — intentional MVP decision (audit A3)
  //
  // The legacy docPreview.js rendered PDF, Excel, Word, and CSV
  // files entirely in-browser using PDF.js (PDF), SheetJS (XLSX), and
  // Mammoth.js (DOCX). That 543-line subsystem was intentionally NOT ported
  // during the migration to web-next.
  //
  // The current approach — window.open(signedUrl, "_blank") — covers the 80%
  // case: modern browsers render PDFs inline in a new tab, XLSX/DOCX files
  // get downloaded by the browser (there is no in-app renderer), and CSV
  // opens as plaintext. This is sufficient for MVP.
  //
  // NOTE: The API currently returns a raw Supabase signed URL without setting
  // Content-Disposition: inline. Browsers still render PDFs inline by default
  // when opened in a new tab, but explicit inline disposition would make the
  // behaviour more reliable across browsers. That is a separate concern in
  // the API layer — do not change it here.
  //
  // If product wants in-app Excel/Word rendering back: port
  // docPreview.js and add `xlsx` + `mammoth` to
  // apps/web-next/package.json. Reference: docs/MIGRATION-AUDIT-REPORT.md A3.
  // -------------------------------------------------------------------------
  async function handleActivate() {
    if (busy) return;
    if (aiOnly) {
      // AI-generated doc — fetch full record and show its aiAnalysis text.
      onShowAnalysis(doc);
      return;
    }
    setBusy(true);
    try {
      const resource = await fetchDocResource();
      if (!resource) return;
      // For both shapes, open in a new tab. For PDFs this is the watermarked
      // blob URL (browser previews inline); for other types it's the signed
      // URL (browser previews or downloads based on its own settings).
      window.open(resource.url, "_blank", "noopener,noreferrer");
      // If we created a blob URL, revoke it after the new tab has had a
      // chance to load it. 60s is plenty for the browser to fetch the bytes.
      if (resource.kind === "blob") {
        setTimeout(() => URL.revokeObjectURL(resource.url), 60_000);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(e: React.MouseEvent | React.KeyboardEvent) {
    // Prevent the row's activate handler from firing.
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    if (aiOnly) {
      // No file to download — open the analysis modal instead so the user
      // can copy the text. Same fallback the legacy flow takes.
      onShowAnalysis(doc);
      return;
    }
    setBusy(true);
    try {
      const resource = await fetchDocResource();
      if (!resource) return;
      const a = document.createElement("a");
      a.href = resource.url;
      a.download = resource.kind === "blob" ? resource.filename : doc.name;
      a.rel = "noopener";
      // Passthrough URLs go to a new tab so the browser shows the download
      // dialog without leaving the page. Blob URLs are same-origin, so the
      // download attribute works directly on the current tab.
      if (resource.kind === "passthrough") {
        a.target = "_blank";
      }
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (resource.kind === "blob") {
        setTimeout(() => URL.revokeObjectURL(resource.url), 60_000);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Enter / Space activate, matching native button semantics.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleActivate();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${doc.name}`}
      aria-busy={busy}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer transition-colors"
    >
      <span className="material-symbols-outlined text-[20px] text-text-muted">
        {getDocIcon(doc.name)}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-main truncate flex items-center gap-1.5">
          {doc.name}
          {aiOnly && (
            <span className="text-[9px] font-bold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">
              AI
            </span>
          )}
        </p>
        <p className="text-xs text-text-muted">
          {doc.fileSize ? formatFileSize(doc.fileSize) : "AI Generated"}
          {doc.createdAt && <> · {formatRelativeTime(doc.createdAt)}</>}
        </p>
      </div>
      <button
        type="button"
        onClick={handleDownload}
        onKeyDown={(e) => {
          // Don't let Space/Enter on the button bubble up and re-trigger the
          // row activation handler.
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
        disabled={busy}
        aria-label={aiOnly ? `View analysis for ${doc.name}` : `Download ${doc.name}`}
        title={aiOnly ? "View analysis" : "Download"}
        className="p-1.5 text-text-muted hover:text-primary hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
      >
        <span className="material-symbols-outlined text-[20px]">
          {busy ? "progress_activity" : aiOnly ? "summarize" : "download"}
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI analysis modal — shows the aiAnalysis (or extractedText) of an
// AI-generated document. Modal pattern mirrors edit-deal-modal.tsx:
// fixed overlay, centered card, Esc + backdrop close, body scroll lock.
// ---------------------------------------------------------------------------

interface DocumentAnalysisModalProps {
  doc: DocItem;
  onClose: () => void;
}

export function DocumentAnalysisModal({ doc, onClose }: DocumentAnalysisModalProps) {
  const { showToast } = useToast();
  const [text, setText] = useState<string | null>(doc.aiAnalysis || null);
  const [loading, setLoading] = useState(!doc.aiAnalysis);

  // Esc key + body scroll lock.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Lazy-fetch the doc record if we don't have aiAnalysis already.
  useEffect(() => {
    if (text != null) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await api.get<{ aiAnalysis?: string; extractedText?: string }>(
          `/documents/${doc.id}`,
        );
        if (cancelled) return;
        setText(full.aiAnalysis || full.extractedText || "No content available");
      } catch (err) {
        if (cancelled) return;
        console.error("[doc-row] fetch analysis failed", err);
        showToast("Failed to load document", "error");
        setText("Failed to load document content.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id, text, showToast]);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-md z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-purple-500">summarize</span>
            <h3 className="text-lg font-bold text-text-main truncate">{doc.name}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-8 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors"
          >
            <span className="material-symbols-outlined text-text-muted">close</span>
          </button>
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-text-muted">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading analysis…
            </div>
          ) : (
            <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
              {text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
