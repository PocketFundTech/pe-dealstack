"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// Lightweight Document shape — we only need id/name/type to render the
// per-doc Re-extract row. Mirrors the relevant fields from DocItem in
// ./components.tsx without taking a hard dependency on the full type.
export interface FinancialDocLite {
  id: string;
  name: string;
  type?: string | null;
  fileUrl?: string | null;
}

// Filename signals that a PDF is a financial statement. Kept in sync with
// FINANCIAL_STATEMENT_FILENAME_PATTERN in
// apps/api/src/routes/financials-extraction-utils.ts. If you change one,
// change the other — they have to stay aligned so the client-side
// Re-extract list matches what the API's `mode='all_financials'` will
// actually process.
const FINANCIAL_STATEMENT_FILENAME_PATTERN =
  /\b(?:profit\s*(?:&|and)\s*loss|p\s*(?:&|and)\s*l|income\s*statement|statement\s+of\s+(?:operations|income|cash\s+flows?)|balance\s+sheet|cash\s+flows?)\b/i;

// "Financial-shaped" predicate — mirrors isFinancialDoc in
// apps/api/src/routes/financials-extraction-utils.ts. Kept in sync so the
// docs we render Re-extract buttons for are exactly the docs the API would
// process under mode='all_financials'. mimeType isn't surfaced to the
// client, so for the PDF filename-pattern branch we use `.pdf` suffix as
// the proxy for "this is a PDF".
export function isFinancialShaped(d: FinancialDocLite): boolean {
  const t = (d.type ?? "").toUpperCase();
  if (
    t === "CIM" ||
    t === "FINANCIALS" ||
    t === "EXCEL" ||
    t === "PROFIT_LOSS" ||
    t === "BALANCE_SHEET" ||
    t === "CASH_FLOW" ||
    t === "INCOME_STATEMENT"
  ) return true;
  const n = (d.name ?? "").toLowerCase();
  if (n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv")) return true;
  if (n.endsWith(".pdf") && FINANCIAL_STATEMENT_FILENAME_PATTERN.test(d.name ?? "")) return true;
  return false;
}

interface DealFinancialsReextractListProps {
  /** Deal id — kept here for parity with the new onRemove contract. */
  dealId: string;
  /** Every doc on the deal. Non-financial-shaped docs render in a muted
   *  style so the user can still pick a misclassified PDF the predicate
   *  rejected, while financial-shaped docs stay visually primary. */
  allDocs: FinancialDocLite[];
  /** True while ANY extraction is in flight — disables every per-doc button. */
  extracting: boolean;
  /** ID of the doc whose single-doc extraction is currently running, if any. */
  extractingDocId: string | null;
  /** ID of the doc whose statements are being removed, if any. */
  removingDocId: string | null;
  /** Single-doc re-extract handler — forwards to the parent's handleExtract. */
  onReextract: (docId: string, docName: string) => void;
  /** Per-doc "remove all extracted statements" handler. Parent owns the
   *  API call, toast, and refetch. */
  onRemove: (docId: string, docName: string) => Promise<void> | void;
}

/**
 * Per-document Re-extract list — collapsible. Lets the user re-run the
 * agent against a single doc when one large file (e.g. a 36-month XLSX)
 * is timing out under the bulk multi-doc loop and shedding data for the
 * other docs. The bulk button in the parent toolbar stays unchanged.
 *
 * Shows ALL docs on the deal. Non-financial-shaped docs render in a
 * muted style so the user can still pick a misclassified PDF, while
 * financial-shaped docs (CIM / FINANCIALS / EXCEL / spreadsheet ext)
 * stay visually primary.
 */
export function DealFinancialsReextractList({
  allDocs,
  extracting,
  extractingDocId,
  removingDocId,
  onReextract,
  onRemove,
}: DealFinancialsReextractListProps) {
  // Local state for the per-doc remove confirmation modal — uses the shared
  // ConfirmDialog primitive (audit C4: no native confirm()).
  const [pendingRemove, setPendingRemove] = useState<FinancialDocLite | null>(null);

  if (allDocs.length === 0) return null;

  const financialCount = allDocs.filter(isFinancialShaped).length;
  const otherCount = allDocs.length - financialCount;
  // Any in-flight action — extract OR remove — disables every per-doc button
  // so users can't fire concurrent destructive ops while the UI is still
  // catching up.
  const anyBusy = extracting || removingDocId !== null;

  const handleConfirmRemove = async () => {
    if (!pendingRemove) return;
    const doc = pendingRemove;
    setPendingRemove(null);
    await onRemove(doc.id, doc.name);
  };

  return (
    <>
      <details className="mb-4 rounded-lg border border-gray-100 bg-gray-50/60">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 select-none flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm">description</span>
          Re-extract a single document
          <span className="text-gray-400 font-normal">
            ({financialCount} financial doc{financialCount === 1 ? "" : "s"}
            {otherCount > 0 ? `, ${otherCount} other` : ""})
          </span>
        </summary>
        <ul className="px-2 pb-2 pt-0 divide-y divide-gray-100">
          {allDocs.map((doc) => {
            const isFinancial = isFinancialShaped(doc);
            const busyExtract = extracting && extractingDocId === doc.id;
            const busyRemove = removingDocId === doc.id;
            return (
              <li key={doc.id} className="flex items-center gap-2 px-2 py-1.5">
                <span
                  className={cn(
                    "material-symbols-outlined shrink-0",
                    isFinancial ? "text-[14px] text-gray-400" : "text-[12px] text-gray-300",
                  )}
                >
                  description
                </span>
                <span
                  className={cn(
                    "truncate flex-1",
                    isFinancial
                      ? "text-xs text-gray-700"
                      : "text-[11px] text-gray-400 italic",
                  )}
                  title={
                    isFinancial
                      ? doc.name
                      : `${doc.name} — not detected as a financial document`
                  }
                >
                  {doc.name}
                </span>
                <button
                  onClick={() => onReextract(doc.id, doc.name)}
                  disabled={anyBusy}
                  aria-label="Re-extract this document"
                  title="Re-extract this document"
                  className="flex items-center justify-center text-gray-500 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded-md transition-all hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
                  style={{ width: 26, height: 26 }}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-sm",
                      busyExtract && "animate-spin",
                    )}
                  >
                    {busyExtract ? "progress_activity" : "refresh"}
                  </span>
                </button>
                <button
                  onClick={() => setPendingRemove(doc)}
                  disabled={anyBusy}
                  aria-label="Remove extracted financial data from this document"
                  title="Remove extracted financial data from this document"
                  className="flex items-center justify-center text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-300 rounded-md transition-all hover:bg-red-50 disabled:opacity-60 disabled:pointer-events-none"
                  style={{ width: 26, height: 26 }}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-sm",
                      busyRemove && "animate-spin",
                    )}
                  >
                    {busyRemove ? "progress_activity" : "playlist_remove"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </details>
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove extracted financial data?"
        message={
          pendingRemove
            ? `This will delete every financial statement row tied to "${pendingRemove.name}". The underlying document stays — only the extracted figures are removed. You can re-extract afterwards.`
            : ""
        }
        confirmLabel="Remove statements"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </>
  );
}
