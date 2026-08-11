"use client";

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";

// Hook: per-doc "remove all extracted statements" — wipes every
// FinancialStatement row tied to a given document. Useful when a
// one-pager or marketing PDF was misclassified and is polluting the
// financials. Backend contract:
//   DELETE /api/deals/:dealId/financials/by-document/:documentId
//   200 -> { success: true, removedCount: number }
// Extracted from deal-financials.tsx so that file stays under the
// 500-line cap (web-next CLAUDE.md / repo-wide rules).
export function useRemoveByDocument(
  dealId: string,
  reload: () => Promise<void>,
) {
  const { showToast } = useToast();
  const [removingDocId, setRemovingDocId] = useState<string | null>(null);

  const handleRemoveByDocument = useCallback(
    async (documentId: string, documentName: string) => {
      if (removingDocId) return;
      setRemovingDocId(documentId);
      try {
        const res = await api.delete<{ success: boolean; removedCount: number }>(
          `/deals/${dealId}/financials/by-document/${documentId}`,
        );
        const removed = res?.removedCount ?? 0;
        // Mirror handleExtract: small delay before refetch since the API
        // may return before the DB delete is fully visible to the next read.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await reload();

        if (removed === 0) {
          showToast(
            `No financial data was extracted from "${documentName}"`,
            "info",
            { title: "Nothing to remove" },
          );
        } else {
          showToast(
            `Removed ${removed} statement${removed === 1 ? "" : "s"} from "${documentName}"`,
            "success",
            { title: "Statements removed" },
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not remove statements";
        showToast(msg, "warning", { title: "Remove failed" });
      } finally {
        setRemovingDocId(null);
      }
    },
    [dealId, removingDocId, reload, showToast],
  );

  return { removingDocId, handleRemoveByDocument };
}
