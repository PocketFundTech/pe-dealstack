// ---------------------------------------------------------------------------
// batchPlan — pure planning logic for the multi-file deal-intake upload flow.
// Extracted out of IngestDealForm so "which endpoint / dealId does file N
// get" can be unit tested without mounting the form or hitting the network.
//
//   - planFileUpload: given a file's position in the batch and the current
//     mode, decides which endpoint to POST to and which dealId (if any) to
//     attach.
//   - resolveDealFromResponse: given a server response (single-document
//     ingest OR bulk-import summary), figures out which deal it resolved to,
//     and flags the case where a bulk import created MORE THAN ONE deal (so
//     the caller knows it can't safely attach further files to "the" deal).
// ---------------------------------------------------------------------------

export type UploadEndpoint = "/ingest" | "/ingest/bulk";

const SPREADSHEET_RE = /\.(xlsx|xls|csv)$/i;

export interface PlanFileUploadParams {
  fileName: string;
  /** Position of this file within the current batch (0-based). */
  index: number;
  mode: "new" | "existing";
  /** The deal selected in "Update Existing Deal" mode, if any. */
  selectedDealId: string | null;
  /** The deal id created by the FIRST file in the batch, in "new" mode. */
  createdDealId: string | null;
}

export interface PlannedUpload {
  endpoint: UploadEndpoint;
  dealId?: string;
}

/**
 * Decide which endpoint a given file in the batch should be sent to, and
 * which dealId (if any) it should carry.
 *
 * - "existing" mode: every file goes to /ingest with the selected dealId —
 *   it only ever updates that one deal.
 * - "new" mode, first file: creates the deal. Spreadsheets go to
 *   /ingest/bulk (which can import a deal list, or falls back server-side to
 *   single-document ingest for a non-deal-list spreadsheet like a financial
 *   model). Everything else goes to /ingest.
 * - "new" mode, subsequent files: attach to the deal the first file created.
 */
export function planFileUpload({
  fileName,
  index,
  mode,
  selectedDealId,
  createdDealId,
}: PlanFileUploadParams): PlannedUpload {
  if (mode === "existing") {
    return { endpoint: "/ingest", dealId: selectedDealId ?? undefined };
  }

  if (index === 0) {
    const isSpreadsheet = SPREADSHEET_RE.test(fileName);
    return { endpoint: isSpreadsheet ? "/ingest/bulk" : "/ingest" };
  }

  return { endpoint: "/ingest", dealId: createdDealId ?? undefined };
}

export interface IngestResponseShape {
  deal?: { id: string; name: string };
  summary?: { deals?: Array<{ dealId: string; companyName: string }> };
}

export interface ResolvedDealResult {
  dealId: string | null;
  dealName: string | null;
  /** True when a bulk import response created MORE THAN ONE deal — the
   *  caller should not guess which one to attach further files to. */
  multipleDeals: boolean;
}

/**
 * Figure out which single deal (if any) a server response resolved to.
 * Handles both the single-document ingest shape ({ deal }) and the bulk
 * deal-list import shape ({ summary: { deals: [...] } }).
 */
export function resolveDealFromResponse(data: IngestResponseShape): ResolvedDealResult {
  if (data.deal?.id) {
    return { dealId: data.deal.id, dealName: data.deal.name ?? null, multipleDeals: false };
  }

  const deals = data.summary?.deals ?? [];
  if (deals.length === 1) {
    return { dealId: deals[0].dealId, dealName: deals[0].companyName ?? null, multipleDeals: false };
  }
  if (deals.length > 1) {
    return { dealId: null, dealName: null, multipleDeals: true };
  }

  return { dealId: null, dealName: null, multipleDeals: false };
}
