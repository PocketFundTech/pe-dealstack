"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";
import { cn } from "@/lib/cn";
import type { CsvImportResult } from "./types";

// ---------------------------------------------------------------------------
// One CSV-upload button, reused for both /outreach/import/private-circle and
// /outreach/import/clay-csv — the two endpoints share an identical response
// shape (services/outreachCsvImport.ts is the same engine underneath both),
// so this component only needs the endpoint path + label to vary. Extracted
// out of OutreachBoard.tsx to keep that file under the 500-line convention
// once a second import source was added, not just for reuse's sake.
//
// Multipart upload goes through authFetchRaw (not api.post) per the
// convention in deal-intake/components.tsx: FormData body, no manual
// Content-Type, caller parses the JSON response itself.
// ---------------------------------------------------------------------------

interface CsvImportButtonProps {
  label: string;
  endpoint: string;
  onImported: () => void | Promise<void>;
}

function buildImportSummary(result: CsvImportResult): string {
  const { received, created, updated, flaggedForReview, enriched } = result;
  const rowWord = `row${received !== 1 ? "s" : ""}`;
  if (received === 0) return "No rows found in that file";
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (flaggedForReview > 0) parts.push(`${flaggedForReview} flagged for review`);
  if (enriched > 0) parts.push(`${enriched} enriched`);
  if (parts.length === 0) return `Imported ${received} ${rowWord} — no changes`;
  return `Imported ${received} ${rowWord} — ${parts.join(", ")}`;
}

export function CsvImportButton({ label, endpoint, onImported }: CsvImportButtonProps) {
  const { showToast } = useToast();
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleClick() {
    if (!importing) inputRef.current?.click();
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!file || importing) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await authFetchRaw(endpoint, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const message =
          (body as { error?: string; message?: string }).error ??
          (body as { message?: string }).message ??
          `Import failed (${res.status})`;
        throw new Error(message);
      }
      const result: CsvImportResult = await res.json();
      await onImported();
      showToast(buildImportSummary(result), "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to import ${label}`;
      showToast(message, "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleFileChange} />
      <button
        type="button"
        onClick={handleClick}
        disabled={importing}
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border-subtle bg-surface-card text-text-secondary shadow-sm hover:bg-primary-light hover:text-[#003366] hover:border-primary/30 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={cn("material-symbols-outlined text-[18px]", importing && "animate-spin")}>
          {importing ? "progress_activity" : "upload_file"}
        </span>
        {importing ? "Importing..." : label}
      </button>
    </>
  );
}
