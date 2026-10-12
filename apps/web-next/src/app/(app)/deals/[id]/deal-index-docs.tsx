"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface IndexRound { indexed: number; failed: number; remaining: number; error: string | null }

/**
 * Files added without AI (e.g. the HubSpot import) aren't searchable by Deal
 * Chat until indexed. Indexing uses AI credit, so it runs only on a click.
 */
export function IndexDocumentsForAi({ dealId }: { dealId: string }) {
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexedTotal, setIndexedTotal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ pending: number }>(`/deals/${dealId}/documents/index-pending`)
      .then((r) => { if (!cancelled) setPending(r.pending ?? 0); })
      .catch((err) => console.warn("[deal/index-docs] pending count failed:", err));
    return () => { cancelled = true; };
  }, [dealId]);

  async function run() {
    setRunning(true);
    setError(null);
    let indexed = 0;
    let failed = 0;
    try {
      for (;;) {
        const r = await api.post<IndexRound>(`/deals/${dealId}/documents/index-pending`, {});
        indexed += r.indexed;
        failed += r.failed;
        setPending(r.remaining);
        if (r.remaining === 0 || r.indexed === 0) {
          const reason = r.error ?? "unknown reason";
          if (failed > 0) setError(`Couldn't index ${failed} document(s): ${reason}.`);
          else if (r.remaining > 0) setError(`Couldn't index ${r.remaining} document(s): ${reason}.`);
          break;
        }
      }
      setIndexedTotal(indexed);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Indexing failed.");
    } finally {
      setRunning(false);
    }
  }

  if (pending === 0 && indexedTotal === null && !error) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-white p-3 text-sm">
      {pending > 0 && (
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">{running ? "progress_activity" : "auto_awesome"}</span>
          {running ? `Indexing… ${pending} left` : `Index ${pending} documents for AI`}
        </button>
      )}
      {!running && pending > 0 && (
        <span className="text-xs text-text-muted">These files aren&apos;t searchable by Deal Chat yet. Indexing uses AI credit.</span>
      )}
      {indexedTotal !== null && indexedTotal > 0 && (
        <span className="text-xs text-emerald-700">{indexedTotal} documents indexed for Deal Chat.</span>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
