// ---------------------------------------------------------------------------
// "Extract all" — continue until every document has been processed
// ---------------------------------------------------------------------------
//
// The API processes a deal's documents as a bounded queue inside one
// request, capped by the 300s function limit. Documents it couldn't reach
// come back as `pendingDocumentIds`; we re-send exactly those until none
// remain, and merge the rounds into one result for the toast / modal.
// (Before, the API ran every document at once and silently skipped all but
// two — fix plan B3.)

import type { ExtractionResult } from "./deal-financials-modal";

type Post = <T>(path: string, body: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;

type RoundResult = ExtractionResult & {
  pendingDocumentIds?: string[];
  success?: boolean;
  hasConflicts?: boolean;
  result?: ExtractionResult["result"] & { documentsPending?: number };
};

export interface ExtractAllProgress {
  done: number;
  total: number;
  round: number;
}

/** Safety cap: a round that makes no progress, or a runaway loop, stops here. */
const MAX_ROUNDS = 8;

export async function runExtractAll(
  post: Post,
  dealId: string,
  opts: { timeoutMs: number; onProgress?: (p: ExtractAllProgress) => void },
): Promise<RoundResult> {
  const merged: RoundResult = { documentsProcessed: [], result: { periodsStored: 0, statementsStored: 0, documentsUsed: 0, documentsFailed: 0, warnings: [], hasConflicts: false } };
  let pending: string[] | undefined;
  let total = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let r: RoundResult;
    try {
      r = await post<RoundResult>(
        `/deals/${dealId}/financials/extract`,
        pending ? { mode: "all_financials", documentIds: pending } : { mode: "all_financials" },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    const finished = (r.documentsProcessed ?? []).filter((d) => d.status !== "pending");
    if (round === 1) total = r.documentsProcessed?.length ?? 0;
    merged.documentsProcessed = [...(merged.documentsProcessed ?? []), ...finished];
    const m = merged.result!;
    const rr = r.result ?? {};
    m.periodsStored = (m.periodsStored ?? 0) + (rr.periodsStored ?? 0);
    m.statementsStored = (m.statementsStored ?? 0) + (rr.statementsStored ?? 0);
    m.documentsUsed = (m.documentsUsed ?? 0) + (rr.documentsUsed ?? 0);
    m.documentsFailed = (m.documentsFailed ?? 0) + (rr.documentsFailed ?? 0);
    m.warnings = [...(m.warnings ?? []), ...(rr.warnings ?? [])];
    m.hasConflicts = !!(m.hasConflicts || rr.hasConflicts);
    m.overallConfidence ??= rr.overallConfidence;
    merged.hasConflicts = m.hasConflicts;

    const next = r.pendingDocumentIds ?? [];
    opts.onProgress?.({ done: total - next.length, total, round });
    // Stop when done, or when a round made no progress (nothing finished).
    if (next.length === 0 || finished.length === 0) {
      if (next.length > 0) {
        m.warnings.push(`${next.length} document(s) were not reached — run Extract again to continue.`);
      }
      break;
    }
    pending = next;
  }

  const m = merged.result!;
  m.allFailed = (m.documentsUsed ?? 0) === 0 && (m.documentsFailed ?? 0) > 0;
  return merged;
}
