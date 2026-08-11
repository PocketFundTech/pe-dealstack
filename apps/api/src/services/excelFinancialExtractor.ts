/**
 * excelFinancialExtractor.ts
 *
 * Converts an Excel workbook (.xlsx / .xls / .xlsm) into structured text
 * that can be fed directly into classifyFinancials() (AI classifier).
 *
 * Strategy:
 *   1. Score each sheet by name relevance (financial vs non-financial)
 *   2. Detect unit scale from sheet headers ("$000s", "in millions", etc.)
 *   3. Extract only meaningful rows (skip empty/formatting rows)
 *   4. Prefix each sheet with name + detected unit context
 *   5. Send scored sheets first, skip junk sheets entirely
 */

import XLSX from 'xlsx';
import { log } from '../utils/logger.js';
import {
  expandMerges as sharedExpandMerges,
  readStructuredGrid,
} from './excelGridReader.js';
import {
  detectSheetStructure,
  formatPeriodHintBlock,
  formatLineItemHintBlock,
  type SheetStructureHints,
} from './excelStructureHints.js';

// Re-export the shared merge-expander so existing call sites (tests,
// Phase-3 parallel agents) keep importing from this module without
// churn. The implementation lives in excelGridReader.ts now so that
// excelToMarkdown.ts can consume the SAME merge-aware grid the LLM
// classifier sees.
export const expandMerges = sharedExpandMerges;

// ─── Sheet Scoring ────────────────────────────────────────────

/** High-value sheet names — definitely financial */
const HIGH_SCORE_PATTERNS: [RegExp, number][] = [
  [/income\s*statement/i, 100],
  [/profit\s*(&|and)\s*loss/i, 100],
  [/p\s*[&+]\s*l\b/i, 95],
  [/balance\s*sheet/i, 100],
  [/cash\s*flow/i, 100],
  [/consolidated/i, 80],
  [/\bfinancial\s*(summary|statements?|model|data)\b/i, 90],
  [/\bebitda\b/i, 85],
  [/\brevenue\b/i, 80],
  [/\blbo\b/i, 75],
  [/\bprojection/i, 75],
  [/\bforecast/i, 75],
  [/\bkpi\b/i, 60],
  [/\bsummary\b/i, 50],
  [/\bmodel\b/i, 50],
  [/\bearnings/i, 70],
];

/** Junk sheets to always skip */
export const SKIP_PATTERNS = [
  /^(cover|title|toc|table\s*of\s*contents|disclaimer|glossary|appendix|notes\s*to|footnote)$/i,
  /^(assumptions|inputs|drivers|scenarios|sensitivity|instructions|template|blank|sheet\d+)$/i,
  /^(formatting|print|macro|hidden|chart\d*|graph|pivot|dashboard)$/i,
];

export function scoreSheet(name: string): number {
  const trimmed = name.trim();

  // Skip junk
  if (SKIP_PATTERNS.some(re => re.test(trimmed))) return -1;

  // Score by patterns
  let maxScore = 0;
  for (const [pattern, score] of HIGH_SCORE_PATTERNS) {
    if (pattern.test(trimmed)) {
      maxScore = Math.max(maxScore, score);
    }
  }

  // Short generic names like "BS", "CF", "PL", "IS" — moderate score
  if (/^(bs|cf|pl|is|cfs)$/i.test(trimmed)) maxScore = Math.max(maxScore, 70);

  // Fallback: sheets with numbers in content might still be useful (scored low)
  if (maxScore === 0) maxScore = 10;

  return maxScore;
}

// ─── Unit Scale Detection ────────────────────────────────────
// (`expandMerges` re-exported above lives in ./excelGridReader.ts so
// the chat-RAG markdown renderer can use the same merge-aware reader.)

/** Caps for the unit-scale scan — wide enough to catch declarations
 *  buried in a footnote row (row 14, "Note: All figures in $000s") or
 *  a far-right disclaimer column, narrow enough that a 1000-row data
 *  sheet doesn't waste milliseconds on cells that are obviously numeric. */
const UNIT_SCAN_MAX_ROWS = 25;
const UNIT_SCAN_MAX_COLS = 25;

/**
 * Scan the sheet for unit indicators (millions / thousands / billions /
 * actuals). Looks at:
 *   1. Up to UNIT_SCAN_MAX_ROWS × UNIT_SCAN_MAX_COLS cells in the grid
 *      (vs the previous 8×10 cap which missed footnote-row declarations).
 *   2. The sheet name itself ("P&L (in $M)" or "Revenue ($000s)").
 *
 * Returns the strongest signal as a prompt-ready hint string, or null.
 */
export function detectUnitScale(
  sheet: XLSX.WorkSheet,
  sheetName?: string,
): string | null {
  const candidates: string[] = [];
  if (sheetName) candidates.push(sheetName);

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const maxRow = Math.min(range.e.r, range.s.r + UNIT_SCAN_MAX_ROWS - 1);
  const maxCol = Math.min(range.e.c, range.s.c + UNIT_SCAN_MAX_COLS - 1);
  for (let r = range.s.r; r <= maxRow; r++) {
    for (let c = range.s.c; c <= maxCol; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v == null) continue;
      const val = String(cell.v);
      // Cheap pre-filter: only look at strings that mention dollars, a
      // scale word, or a parenthesised marker. Avoids regex-testing every
      // numeric cell in a wide grid.
      if (!/\$|\(|\bin\b|thousand|million|billion|actual/i.test(val)) continue;
      candidates.push(val);
    }
  }

  for (const raw of candidates) {
    const val = raw.toLowerCase();
    if (/\$\s*in\s*millions|\(\$m\)|\$\s*mm|\(millions\)|in\s*millions?\s*usd|\(in\s*\$?m\)/i.test(val)) {
      return 'IMPORTANT: Values in this sheet are in MILLIONS USD ($M). Store values as written; set unitScale to "MILLIONS". Do NOT convert.';
    }
    if (/\$\s*in\s*thousands|\(\$000s?\)|\$\s*000|\(thousands\)|in\s*thousands|\(in\s*\$?k\)/i.test(val)) {
      return 'IMPORTANT: Values in this sheet are in THOUSANDS USD ($000s). Store values as written; set unitScale to "THOUSANDS". Do NOT convert.';
    }
    if (/\$\s*in\s*billions|\(\$b\)|\(billions\)|\(in\s*\$?b\)/i.test(val)) {
      return 'IMPORTANT: Values in this sheet are in BILLIONS USD ($B). Store values as written; set unitScale to "BILLIONS". Do NOT convert.';
    }
    if (/in\s*actual|in\s*dollars|\(\$\)$/i.test(val)) {
      return 'IMPORTANT: Values in this sheet are in ACTUAL DOLLARS. Store values as written; set unitScale to "ACTUALS". Do NOT convert.';
    }
  }
  return null;
}

// ─── Structured Row/Column Ingestion ─────────────────────────

/**
 * Render a sheet as structured row/column text + structure hints for the
 * LLM classifier.
 *
 * Pipeline:
 *   1. `readStructuredGrid` (in excelGridReader) expands merges, pads
 *      short rows, and drops empty / separator rows.
 *   2. `detectSheetStructure` finds the period-header row and column-A
 *      line-item rows. Both become explicit prompt hints — the LLM no
 *      longer has to re-derive the spatial layout.
 *   3. Render as TAB-separated grid prefixed with a [Grid: …] header
 *      and a column-letter row so the LLM can reason against ("col A
 *      row 28 is 'EBITDA'") instead of inferring positions from text.
 *
 * Output format is the same as before this refactor — downstream
 * prompts are calibrated to it, do not change shape lightly.
 */
function sheetToStructuredOutput(sheet: XLSX.WorkSheet): {
  body: string;
  hints: SheetStructureHints;
} {
  const empty: SheetStructureHints = {
    periodRow: null,
    periods: [],
    lineItems: [],
    unmatchedLabels: [],
  };
  const cleanRows = readStructuredGrid(sheet);
  if (cleanRows.length === 0) return { body: '', hints: empty };

  const hints = detectSheetStructure(cleanRows);

  const maxCols = cleanRows[0].length; // grid is rectangular post-readStructuredGrid

  // Lightweight per-sheet metadata. Helps the LLM anchor its reasoning
  // to specific (row, col) coordinates instead of treating the blob as
  // unstructured text. Column letters use spreadsheet convention
  // (A=col 0, B=col 1, …) so the LLM's "column A is the label" prior
  // matches what it sees.
  const colLetters = Array.from({ length: maxCols }, (_, c) =>
    XLSX.utils.encode_col(c),
  ).join('\t');

  const header = `[Grid: ${cleanRows.length} non-empty rows × ${maxCols} cols]\nCOL\t${colLetters}`;
  const body = `${header}\n${cleanRows.map((r) => r.join('\t')).join('\n')}`;
  return { body, hints };
}

// ─── Main Extractor ──────────────────────────────────────────

/**
 * One-shot return from `extractStructuredExcel`. The classifier receives
 * `text` directly; `periodHints` and `lineItemHints` are passed to
 * `buildExtractionPrompt` as explicit anchors so the LLM doesn't have
 * to re-infer the spatial structure from a tab-separated text blob.
 *
 * `lineItemHintsBlock` aggregates BOTH matched canonical keys AND any
 * unmatched column-A labels — keeping them together lets the prompt
 * formatter render one tidy "[Line item rows detected]" block per sheet
 * instead of two parallel ones.
 */
export interface StructuredExcelResult {
  /** Full classifier-ready text blob (per-sheet headers + grids). */
  text: string;
  /** Pre-formatted, prompt-ready period-headers block (across all
   *  detected sheets). Empty string if no periods found. */
  periodHintsBlock: string;
  /** Pre-formatted, prompt-ready line-item-rows block (across all
   *  detected sheets). Empty string if no line items found. */
  lineItemHintsBlock: string;
  /** Raw structured hints per sheet — exposed for tests + diagnostics.
   *  The blocks above are derived from these; downstream code should
   *  prefer the formatted blocks unless it needs the structured data. */
  perSheetHints: { sheetName: string; hints: SheetStructureHints }[];
}

/**
 * Private helper: process one workbook into the per-sheet shape both
 * `extractStructuredExcel` and `extractSheetsFromExcel` need.
 *
 * Lives here (not in excelGridReader.ts) because it owns the score-and-
 * sort step and the unit-scale + structure-hint block emission — those
 * are extractor concerns, not raw-grid concerns.
 *
 * Returns `null` if the workbook is empty / unparseable; otherwise an
 * array of per-sheet records the public functions can format as they
 * like (single concatenated blob vs per-sheet array).
 */
interface ProcessedSheet {
  name: string;
  score: number;
  sheetHeader: string; // [Sheet:…] line, possibly with " (financial …)" suffix
  unitHint: string | null;
  body: string;        // [Grid:…] header + COL row + tab-separated grid
  hints: SheetStructureHints;
  periodBlock: string; // formatPeriodHintBlock output (may be '')
  lineItemBlock: string; // formatLineItemHintBlock output (may be '')
}

function processWorkbookSheets(buffer: Buffer): ProcessedSheet[] | null {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true,
      cellNF: false,
      cellText: true,
    });
  } catch (err) {
    log.error('Excel extractor: failed to parse workbook', err);
    return null;
  }

  if (!workbook.SheetNames.length) {
    log.warn('Excel extractor: workbook has no sheets');
    return null;
  }

  // Score and sort sheets by financial relevance.
  const scoredSheets = workbook.SheetNames
    .map(name => ({ name, score: scoreSheet(name) }))
    .filter(s => s.score > 0) // skip junk (score = -1)
    .sort((a, b) => b.score - a.score); // highest score first

  // If no sheets scored above junk threshold, try all non-junk sheets.
  const sheetsToProcess = scoredSheets.length > 0
    ? scoredSheets
    : workbook.SheetNames
        .filter(name => !SKIP_PATTERNS.some(re => re.test(name.trim())))
        .map(name => ({ name, score: 10 }));

  log.info('Excel extractor: sheet analysis', {
    totalSheets: workbook.SheetNames.length,
    scoredSheets: scoredSheets.map(s => `${s.name} (${s.score})`),
    processing: sheetsToProcess.map(s => s.name),
    skipped: workbook.SheetNames.filter(name => scoreSheet(name) === -1),
  });

  const out: ProcessedSheet[] = [];
  for (const { name, score } of sheetsToProcess) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;

    // sheetToStructuredOutput -> readStructuredGrid handles merge
    // expansion internally, so year banners / quarter bands populate
    // every column they visually span before the LLM ever sees the
    // grid. Don't double-expand here — expandMerges is idempotent
    // but the extra call confuses readers who expect ownership of
    // the merge step to live in one place.
    const { body, hints } = sheetToStructuredOutput(sheet);
    if (body.length < 20) continue; // empty sheet after cleaning

    // Detect unit scale across the whole sheet header zone (and the
    // sheet name) — covers footnote-row declarations the old 8×10
    // window missed.
    const unitHint = detectUnitScale(sheet, name);

    let sheetHeader = `[Sheet: ${name}]`;
    if (score >= 70) sheetHeader += ` (financial statement detected)`;

    out.push({
      name,
      score,
      sheetHeader,
      unitHint,
      body,
      hints,
      periodBlock: formatPeriodHintBlock(hints.periods),
      lineItemBlock: formatLineItemHintBlock(hints.lineItems, hints.unmatchedLabels),
    });
  }
  return out;
}

/**
 * Extract structured text + hints from an Excel workbook buffer.
 *
 * Phase-3 P3+P4 evolution of the extractor: in addition to the
 * tab-separated grid the LLM has always received, this returns explicit
 * period-header and line-item-row hints so the classifier prompt can
 * include them as anchors. Previously the LLM had to re-derive the
 * spatial structure from the grid, which dropped months on wide tables
 * and mis-mapped percentage rows ("EBITDA Margin") to dollar keys.
 *
 * Improvements over v1:
 *   - Scores sheets by financial relevance (not just pattern match)
 *   - Skips junk sheets (Assumptions, Notes, Cover, etc.)
 *   - Detects unit scale from headers and passes to AI classifier
 *   - Filters empty/formatting rows for cleaner input
 *   - Processes sheets in relevance order (highest score first)
 *   - NEW: walks the grid for period rows and line-item labels
 *     (excelStructureHints.ts) and emits prompt-ready hint blocks
 */
export function extractStructuredExcel(buffer: Buffer): StructuredExcelResult | null {
  const processed = processWorkbookSheets(buffer);
  if (!processed || processed.length === 0) {
    if (processed) log.warn('Excel extractor: no meaningful content found');
    return null;
  }

  // Single-blob format: [Sheet:…]\n<unit hint>\n<body> per sheet, blank
  // line between sheets. Hint blocks are aggregated separately and
  // injected by the prompt builder, NOT inlined into the blob (the LLM
  // benefits from seeing all hint blocks together as a top-level
  // STRUCTURED HINTS section, not interleaved with each sheet's grid).
  const textParts: string[] = [];
  const periodBlocks: string[] = [];
  const lineItemBlocks: string[] = [];
  const perSheetHints: { sheetName: string; hints: SheetStructureHints }[] = [];

  for (const p of processed) {
    let header = p.sheetHeader;
    if (p.unitHint) header += `\n${p.unitHint}`;
    textParts.push(`${header}\n${p.body}`);
    perSheetHints.push({ sheetName: p.name, hints: p.hints });

    // Tag each block with the sheet name so the LLM can disambiguate
    // "row 28" between sheets in a multi-sheet workbook.
    if (p.periodBlock) periodBlocks.push(`Sheet "${p.name}":\n${p.periodBlock}`);
    if (p.lineItemBlock) lineItemBlocks.push(`Sheet "${p.name}":\n${p.lineItemBlock}`);
  }

  const combined = textParts.join('\n\n');
  log.info('Excel extractor: text extracted', {
    sheets: textParts.length,
    chars: combined.length,
    periodHintSheets: periodBlocks.length,
    lineItemHintSheets: lineItemBlocks.length,
  });

  return {
    text: combined,
    periodHintsBlock: periodBlocks.join('\n\n'),
    lineItemHintsBlock: lineItemBlocks.join('\n\n'),
    perSheetHints,
  };
}

/**
 * Backwards-compatible wrapper: returns just the text blob. Existing
 * callers that don't care about the structure hints (the markdown chunker
 * pre-Phase-3, smoke tests, anywhere else that already handled "string
 * | null") continue to work unchanged.
 *
 * New code should prefer `extractStructuredExcel` so the structure
 * hints aren't thrown away — `extractNode.ts` does this for the LLM
 * classifier path.
 */
export function extractTextFromExcel(buffer: Buffer): string | null {
  const result = extractStructuredExcel(buffer);
  return result ? result.text : null;
}

/** Returns true if the MIME type or filename looks like an Excel-family file
 *  (XLSX/XLS/XLSM/XLSB or CSV — XLSX.read parses CSV from a buffer too, so we
 *  funnel both through the same extractor). The frontend file picker exposes
 *  .csv to users; without this match the non-bulk ingest path falls into the
 *  "Unsupported file type" branch. */
export function isExcelFile(mimeType?: string | null, filename?: string | null): boolean {
  if (mimeType) {
    if (
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      mimeType.includes('csv') ||
      mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      return true;
    }
  }
  if (filename) {
    return /\.(xlsx|xls|xlsm|xlsb|csv)$/i.test(filename);
  }
  return false;
}

// ─── Per-Sheet Extraction (Phase 3 P1) ───────────────────────
//
// extractTextFromExcel concatenates all sheets into one blob, which the
// downstream classifyFinancials() truncates at MAX_TEXT_LENGTH. On real
// CIM-attached financial models the second/third sheet (Cash Flow,
// Balance Sheet) tips the blob over 120K and gets silently dropped —
// extractions then complete with one statement type instead of three.
//
// extractSheetsFromExcel exposes the per-sheet structured blocks so the
// orchestrator (extractNode) can fan classifyFinancials() out to each
// sheet independently with bounded concurrency. The per-sheet text
// format is identical to what extractStructuredExcel emits per sheet —
// same metadata block, same merge-expanded grid, same unit hint, same
// period / line-item hint blocks (when detected) — so the classifier
// prompt sees the same structure either way.

/**
 * One extracted sheet, ready for an independent classifyFinancials()
 * call. `text` already includes the [Sheet:] header, the unit-scale
 * hint (when detected), any per-sheet structure hints, and the
 * structured grid body. `score` mirrors scoreSheet() so callers can
 * prioritise high-relevance sheets first if they need to cap fan-out
 * below the available sheet count.
 */
export interface ExtractedSheet {
  /** Original sheet name as written in the workbook. */
  name: string;
  /** Score from scoreSheet() — higher = more likely financial. */
  score: number;
  /** Tab-separated grid + COL row + per-sheet metadata block.
   *  Self-contained: each sheet's text carries its own unit hint so
   *  it can be classified in isolation without losing scale context. */
  text: string;
}

/**
 * Like extractTextFromExcel, but returns a per-sheet array instead of
 * concatenating into a single blob. Same scoring / skip rules apply —
 * cover/disclaimer sheets are filtered out, financial sheets sorted
 * highest-score first.
 *
 * Each entry's `text` is a self-contained classifier input: it carries
 * the [Sheet:] header, the unit-scale hint (so per-sheet calls don't
 * lose unit context), any period / line-item structure hints the
 * single-blob path would emit, and the structured grid body.
 *
 * Returns an empty array when the workbook has no usable sheets
 * (matches the null-return contract of extractTextFromExcel — both
 * mean "give up, no signal here").
 */
export function extractSheetsFromExcel(buffer: Buffer): ExtractedSheet[] {
  const processed = processWorkbookSheets(buffer);
  if (!processed) return [];

  const out: ExtractedSheet[] = [];
  for (const p of processed) {
    // Inline per-sheet structure hints so each independent classifier
    // call carries the same spatial anchors the concatenated blob does.
    const headerLines: string[] = [p.sheetHeader];
    if (p.unitHint) headerLines.push(p.unitHint);
    const parts: string[] = [headerLines.join('\n')];
    if (p.periodBlock) parts.push(`Sheet "${p.name}":\n${p.periodBlock}`);
    if (p.lineItemBlock) parts.push(`Sheet "${p.name}":\n${p.lineItemBlock}`);
    parts.push(p.body);

    out.push({ name: p.name, score: p.score, text: parts.join('\n') });
  }

  log.info('Excel extractor (per-sheet): extracted', {
    processed: out.length,
    sheets: out.map(s => `${s.name} (${s.score}, ${s.text.length}c)`),
  });
  return out;
}
