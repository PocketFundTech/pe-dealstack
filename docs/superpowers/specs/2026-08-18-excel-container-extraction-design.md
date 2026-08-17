# Excel/CSV Extraction via Code Execution — Design

**Date:** 2026-08-18
**Status:** Approved (founder directive: "Let's do the Excel upgrade then. and let's take the accuracy to the maximum level")
**Branch:** `feat/excel-container-extraction` off `main` (c79e840)

## Problem

Spreadsheet extraction accuracy is ~25% in practice (founder-reported). Root
cause: every spreadsheet path flattens the workbook to text
(`extractTextFromExcel` / `excelToMarkdown`) before any model sees it —
merged cells, "$ in 000s" header rows, pivoted layouts, and multi-table
sheets all lose their structure in the flattening. `EXTRACTION_ENGINE=claude`
(live 2026-08-18) upgraded the model and output contract but kept the
flattened-text input for `fileType: 'excel'`.

Additionally, the deal-page upload path (`documents-upload.ts` Excel branch)
calls `runDeepPass` → `classifyFinancials` directly — bypassing
`EXTRACTION_ENGINE` entirely, so upload-time Excel extraction still runs the
legacy classifier even with the flag on.

## Design

### Change 1 — container mode in `claudeEngine.ts` (excel branch)

When `fileType === 'excel'` and `EXCEL_EXTRACTION_MODE !== 'text'`
(default: container mode ON):

1. Upload the raw workbook buffer via the Files API (existing pattern:
   `client.beta.files.upload` + `toFile`, correct MIME for xlsx/xls/csv,
   delete in `finally` — same leak guard as the PDF path).
2. One `trackedClaudeMessage` call, role `extraction` (Fable 5 → Opus 4.8
   server-side fallback), with:
   - `tools: [{ type: 'code_execution_20250825', name: 'code_execution' }]`
     (GA — no beta header; both extraction models support it)
   - `extraBetas: ['files-api-2025-04-14']` (required for Files API refs)
   - user content: `{ type: 'container_upload', file_id }` + an instruction
     block: read EVERY sheet with pandas/openpyxl, print exact cell grids
     including header/unit rows, identify financial statements, then emit
     the extraction JSON.
   - `outputSchema: EXTRACTION_JSON_SCHEMA` (unchanged contract)
3. Same `parseAndNormalize` → validator → at-most-one repair pass. The
   repair call reuses the same `container_upload` block (the Files-API file
   is only deleted in `finally`, so it remains referenceable).
4. `rawText` for cache/UI parity still comes from `extractTextFromExcel`
   (cheap, local, unchanged).

**Fallback ladder (accuracy can only go up):** container-mode failure of any
kind (upload error, tool/schema rejection, refusal, unparseable output) →
log + fall through to the existing text-mode Claude extraction → which
itself falls back to legacy. `EXCEL_EXTRACTION_MODE=text` is the env
kill-switch back to current behavior.

`client.ts` gains an optional `tools?: unknown[]` passthrough on
`ClaudeCallOptions` (body field, omitted when absent — same idiom as
`betas`/`fallbacks`).

### Change 2 — upload-time Excel routes through the engine flag

In `documents-upload.ts`'s Excel follow-up block: when
`EXTRACTION_ENGINE=claude`, call `runFinancialAgent({ dealId, documentId,
fileBuffer, fileName, fileType: 'excel', organizationId })` (the same
flag-aware unit the Re-extract route uses) instead of `runDeepPass`. Flag
off → `runDeepPass` exactly as today. The existing slot guard and
awaited-not-backgrounded semantics are preserved.

## Out of scope (YAGNI)

- PDF path: untouched (already native).
- `runDeepPass` internals: untouched — it remains the legacy path.
- Programmatic tool calling / REPL persistence (`code_execution_20260120+`):
  not needed for a single-file read.
- Standalone image extraction.

## Cost/latency

Container sessions add per-session cost + ~10–60s latency on Excel
extractions. Acceptable: extraction is an explicit, slot-guarded operation
(Re-extract button / upload follow-up), not an interactive hot path.

## Testing

- **client.ts**: `tools` passthrough present when given, absent otherwise
  (extend ai-client.test.ts).
- **claudeEngine (mocked SDK)**: container request shape (code_execution
  tool + container_upload block + files upload/delete incl. on error);
  fallback to text mode when the container call throws/returns null;
  `EXCEL_EXTRACTION_MODE=text` forces text mode; CSV gets the container
  path too.
- **documents-upload**: flag on → `runFinancialAgent` called with the
  buffer; flag off → `runDeepPass` (existing behavior pinned).
- **Live verification**: local `ANTHROPIC_API_KEY` is stale (401) — cannot
  live-test locally. Post-merge verification = upload one real xlsx to a
  deal in prod (or re-extract), confirm statements + `extractionSource =
  'claude'`. Founder can alternatively provide a fresh key for a local
  live run before merge.

## Rollout

Ships ON by default (founder wants maximum accuracy now), with the
automatic fallback ladder as the safety net and `EXCEL_EXTRACTION_MODE=text`
as instant rollback. No migration.
