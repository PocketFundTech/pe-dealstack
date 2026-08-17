# Native CIM→Deal Ingest — Design

**Date:** 2026-08-14
**Status:** Approved (founder directive 2026-08-14: "native CIM → deal ingest and deal chat streaming unlock both! one after another!")
**Branch:** `feat/native-cim-ingest` off `main` (12c11ea)

## Problem

`POST /api/ingest` (the "+ New Deal" upload modal, Google Drive ingest, and the
onboarding CIM step all funnel through `runIngestFromBuffer`) is shallow:

1. **Truncation.** The PDF is parsed to text (LlamaParse → pdf-parse) and
   `extractDealDataFromText` truncates to **20,000 chars** (`aiExtractor.ts`).
   A 100-page CIM loses ~90% of its content before the model sees it.
2. **Scanned PDFs 422.** Image-only PDFs produce <100 chars of text and the
   route returns 422 ("please upload a text-based PDF").
3. **Empty deal.** Ingest never creates `FinancialStatement` rows, never runs
   red-flag analysis, never scores. A freshly-ingested CIM deal looks empty
   until someone manually hits Re-extract on the deal page.

## Goals

- Fable-5 reads the **whole document natively** (Files API, same pattern as
  `claudeEngine.ts`) for the deal-level overview extraction — behind a flag.
- A freshly-ingested deal arrives **fully populated**: overview fields, then
  financial statements, red flags, and scorecard fill in automatically —
  unflagged, works with legacy engines too.
- Zero regression risk: any Claude failure falls back to the exact legacy path;
  deal creation is never blocked by the new engine.

## Non-goals (YAGNI)

- No UI changes — the modal, deal page, and review queue already render
  everything this produces.
- `/ingest/url`, `/ingest/email`, `/ingest/bulk` stay legacy.
- No shared Files-API upload between deal-reader and financial extraction
  (two uploads cost pennies; revisit if volume justifies).
- No OCR fallback work beyond what native PDF reading gives us for free.

## Design

### Change 1 — `claudeDealReader` (new service, flagged)

`apps/api/src/services/extraction/claudeDealReader.ts`

```ts
interface ClaudeDealReaderInput {
  fileBuffer?: Buffer;        // PDF path — native Files API read
  fileName: string;
  fullText?: string;          // non-PDF path — full text, capped at 200k chars
  sourceLength: number;       // real text length for confidence calibration (0 if unknown/scanned)
}
async function readDealDocument(input: ClaudeDealReaderInput): Promise<ExtractedDealData | null>
```

- Returns the **exact existing `ExtractedDealData` shape** (per-field
  `{value, confidence, source}` + risks/highlights/summary/overallConfidence/
  needsReview/reviewReasons) so all downstream consumers — confidence floor,
  review queue, `dealMerger`, Document.extractedData — work unchanged.
- PDF: upload via `client.beta.files.upload` + reference by `file_id`,
  delete in `finally` (mirror `claudeEngine.ts` including the
  no-empty-`betas` gotcha). Non-PDF: full text in a text block (200k cap vs
  legacy 20k).
- One call via `trackedClaudeMessage({ operation: 'deal_ingest',
  role: 'extraction', outputSchema })` — lands in the usage ledger + audit
  automatically. Hand-written JSON schema mirroring `ExtractionOutputSchema`
  (codebase convention: `extractionSchema.ts`, `dealScorecard`).
- System prompt: reuse `buildExtractionSystemPrompt(getTodayIso())` from
  `aiExtractor.ts` (export it) — keeps the date-injection fix and all the
  unit-conversion/anti-target rules.
- Post-processing: extract `finalizeExtractedDealData(raw, sourceLength)` out
  of `extractDealDataFromText` (normalize fields, short-doc confidence cap,
  overall confidence + review reasons) and call it from **both** paths — no
  duplicated scoring logic.
- Short-doc calibration edge: the cap keys off *text* length. For the native
  PDF path with no text layer (scanned doc, `sourceLength < 100`), skip the
  short-doc cap and use the standard-length prompt hint — the model sees the
  full document natively, so a near-zero text-layer length says nothing
  about document substance.
- On any error (upload failure, refusal, schema mismatch): log + return
  `null`; caller falls back to legacy.

### Change 2 — flag wiring (`INGEST_ENGINE=claude`, default legacy)

In `runIngestFromBuffer` Step 2 (and the same swap in `ingest-text.ts`):

- Flag off → exact current behavior (deepExtract / extractDealDataFromText).
- Flag on, PDF → `readDealDocument({ fileBuffer, fileName, sourceLength: extractedText.length })`.
- Flag on, Word/Excel/text → `readDealDocument({ fullText: extractedText, ... })`.
- Claude returns null → **silent fallback** to the legacy extractor chain.
- Scanned-PDF change (flag on only): when text extraction is sparse (<100
  chars — today's 422), still attempt the native read; only 422 if Claude
  also fails. Text extraction still runs first regardless of flag —
  `extractedText` feeds Document.extractedText, RAG embedding, and length
  calibration; the truncation only ever applied to the LLM call.

### Change 3 — background deep pass (unflagged, engine-agnostic)

New service `apps/api/src/services/ingestDeepPass.ts`:

```ts
runIngestDeepPass({ dealId, orgId, documentId, fileBuffer, fileName, mimeType }): Promise<void>
```

- Slot-guarded (`acquireExtractionSlot` / `release`, skip + log when org at
  cap — same as `processOneDoc` in `financials-extraction.ts`).
- Runs `runFinancialAgent` with the in-memory buffer (no storage re-fetch)
  → writes `FinancialStatement` rows, deal-cache writeback. Respects
  `EXTRACTION_ENGINE` internally — works today with legacy engines.
- Then `void maybeScoreAfterExtraction(dealId, orgId)` — auto-scorecard,
  already a silent no-op without criteria.
- Fired from `runIngestFromBuffer` for PDF + Excel docs (both new-deal and
  merge paths, not for duplicate-skips) **after** the response is built, via
  a new `runInBackground(promise)` helper: `waitUntil` from
  `@vercel/functions` (new apps/api dependency) so the work survives
  Vercel's post-response freeze; plain promise locally. Response gains
  `backgroundExtraction: 'started' | 'skipped'` (additive, no UI change).
- Failures are logged and never affect the ingest response — identical to
  today's behavior where financials simply don't exist yet.

### Rollout

- Ship with `INGEST_ENGINE` unset → deal-level extraction unchanged; the
  background deep pass activates immediately (legacy engines).
- Flip `INGEST_ENGINE=claude` in Vercel together with
  `EXTRACTION_ENGINE=claude` after the bake-off. Rollback = delete env var.

### Error handling summary

| Failure | Behavior |
| --- | --- |
| Claude deal-read fails/refuses | Fall back to legacy extractor, warn log |
| Both engines fail | Existing 422 path (unchanged) |
| Deep pass fails / no slot | Log; deal keeps overview; manual Re-extract still works |
| Scorecard fails | Already swallowed by `maybeScoreAfterExtraction` |

## Testing

- **Unit — claudeDealReader** (mocked `trackedClaudeMessage` + Files API):
  shape mapping, PDF vs text mode, file cleanup on error, null on refusal,
  short-doc confidence cap applied via shared finalizer.
- **Unit — aiExtractor refactor**: `finalizeExtractedDealData` extracted with
  behavior pinned (existing tests keep passing).
- **Route — ingest**: flag off = legacy call sites hit (no Claude); flag on =
  claude path hit, fallback on null; deep pass invoked with correct args
  after deal creation; duplicate-skip does not fire deep pass.
- **Manual E2E** (local, real `ANTHROPIC_API_KEY`): one real CIM PDF through
  `POST /api/ingest` with `INGEST_ENGINE=claude` — verify deal fields,
  FinancialStatement rows, scorecard populated.

## Baseline (worktree, 2026-08-14)

`apps/api`: 143 files passed, 1 skipped — 1500 tests passed, 50 skipped, 0
failures. Any new failure is ours.
