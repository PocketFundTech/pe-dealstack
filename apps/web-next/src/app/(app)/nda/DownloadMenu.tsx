"use client";

import { useEffect, useRef, useState } from "react";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";

interface DownloadMenuProps {
  docId: string;
  title: string;
  /** Disable when there's no content to export (an empty draft). */
  disabled?: boolean;
}

type Format = "docx" | "pdf";

const FORMATS: { key: Format; label: string; icon: string }[] = [
  { key: "docx", label: "Download .docx", icon: "description" },
  { key: "pdf", label: "Download PDF", icon: "picture_as_pdf" },
];

// The server sets Content-Disposition with the canonical filename; fall back
// to the title when the header is missing (e.g. proxy strips it).
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="?([^"]+)"?/i.exec(header);
  return match?.[1] ?? fallback;
}

/**
 * Toolbar "Download ▾" menu for an NDA. Hits
 * `GET /legal-documents/:id/export?format=docx|pdf`, which renders the
 * binary via Google Drive's native Doc export, and triggers a browser
 * download. Both formats need the user's Google Workspace connection — a
 * 409 surfaces a "connect Google" toast rather than a silent failure.
 */
export function DownloadMenu({ docId, title, disabled }: DownloadMenuProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function download(format: Format) {
    if (busy) return;
    setBusy(format);
    try {
      const res = await authFetchRaw(
        `/legal-documents/${docId}/export?format=${format}`,
        { method: "GET" },
      );
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code = (body as { code?: string }).code;
        if (code === "GOOGLE_NOT_CONNECTED" || code === "GOOGLE_SCOPES_MISSING") {
          throw new Error(
            "Connect Google in Settings → Integrations to download.",
          );
        }
        const msg =
          (body as { error?: string }).error ?? `Download failed (${res.status})`;
        throw new Error(msg);
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(
        res.headers.get("Content-Disposition"),
        `${title || "document"}.${format}`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      console.warn("[nda] download failed:", err);
      showToast(err instanceof Error ? err.message : "Download failed", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy !== null}
        className={cn(
          "px-3 py-1.5 rounded-md text-xs font-semibold border inline-flex items-center gap-1.5",
          disabled
            ? "border-slate-200 text-slate-400 cursor-not-allowed"
            : "border-slate-200 text-slate-700 hover:bg-slate-100",
        )}
        title={disabled ? "Add content first" : "Download as .docx or PDF"}
      >
        <span
          className={cn(
            "material-symbols-outlined text-[14px]",
            busy && "animate-spin",
          )}
        >
          {busy ? "progress_activity" : "download"}
        </span>
        Download
        <span className="material-symbols-outlined text-[14px]">
          arrow_drop_down
        </span>
      </button>
      {open && !disabled && (
        <div className="absolute right-0 mt-1 w-44 rounded-md border border-slate-200 bg-white shadow-lg z-50 py-1">
          {FORMATS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => download(f.key)}
              disabled={busy !== null}
              className="w-full px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2 disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[16px] text-slate-500">
                {f.icon}
              </span>
              {f.label}
              {busy === f.key && (
                <span className="material-symbols-outlined text-[14px] animate-spin ml-auto">
                  progress_activity
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact draft-only hint that answers "where is eSign?". On a draft there's
 * no Google Doc yet, so the counterparty can't be asked to sign — the
 * "Request signature" action only appears in the emerald action bar after a
 * successful send. This explains that without duplicating the send flow.
 */
export function DraftEsignHint() {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        showToast(
          'Send the NDA first — the eSignature request opens inside the Google Doc the counterparty receives. After sending, use “Request signature” in the green bar.',
          "info",
          { title: "eSignature", duration: 7000 },
        )
      }
      className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1.5"
      title="How to get an eSignature"
    >
      <span className="material-symbols-outlined text-[14px]">draw</span>
      eSign
    </button>
  );
}
