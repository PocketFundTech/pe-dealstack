/**
 * excelGridReader.ts
 *
 * Shared low-level reader for Excel sheets. Both the financial extractor
 * (`excelFinancialExtractor.ts`) and the chat/RAG markdown renderer
 * (`excelToMarkdown.ts`) consume the SAME structured grid produced here,
 * so the two paths can no longer disagree about a workbook's contents
 * (year banners, merge expansion, padding, formatting-row filtering).
 *
 * Two public helpers:
 *   - expandMerges(sheet)         : mutate sheet so every cell of a merge
 *                                   range carries the top-left value.
 *   - readStructuredGrid(sheet)   : return a rectangular 2-D string array
 *                                   with merges expanded, short rows
 *                                   right-padded, and purely-empty /
 *                                   formatting-separator rows dropped.
 *
 * Why this module exists at all: the chat-RAG path used to render Excel
 * via its own `sheet_to_json` walk that did NOT call `expandMerges`. So
 * extraction saw "Revenue 100 110 120 under FY 2024" while chat saw
 * "Revenue 100 110 120 under (blank)" and the user could ask "what was
 * FY 2024 Q3 revenue?" and get a stale answer. Unifying both consumers
 * on one reader closes that gap.
 *
 * Hard rule: anything that changes the rectangle's *shape* (rows, cols,
 * cell values) belongs here. Anything that *renders* the rectangle
 * (tab-separated grid for the LLM, Markdown table for embeddings) stays
 * in the consumer.
 */

import XLSX from 'xlsx';

/**
 * Spread merged-cell values into every cell of each merge range.
 *
 * Why: the xlsx library only stores the merge value in the top-left cell
 * of a merge range. The other cells are absent from the sheet object,
 * so `sheet_to_csv` / `sheet_to_json` renders them as empties. A year
 * banner row "FY 2024" merged across columns B–M becomes ",,,,FY 2024,,,,"
 * — the LLM has to guess that the empty cells belong to "FY 2024", which
 * fails on wide grids and produces the absurd-magnitude / missing-line-
 * item bugs we shipped pre-Phase-3.
 *
 * After this pass: every cell in a merge range carries the same value as
 * the top-left, so column alignment is preserved and the LLM can read
 * the year banner and the month label below it as a coherent (year,
 * month) pair.
 *
 * Mutates the sheet in place. Safe because each call site
 * (`extractTextFromExcel`, `excelToMarkdown`) owns its own `XLSX.read`
 * of the buffer — the workbook isn't shared.
 */
export function expandMerges(sheet: XLSX.WorkSheet): void {
  const merges = sheet['!merges'];
  if (!merges || merges.length === 0) return;

  for (const m of merges) {
    const srcAddr = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c });
    const srcCell = sheet[srcAddr];
    if (!srcCell || srcCell.v == null || srcCell.v === '') continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        // After XLSX round-trip, cells inside a merge range come back
        // as empty-string placeholders ({t:'s', v:''}) rather than
        // `undefined`. Treat any cell with a null/empty value as
        // overwritable so the merge value broadcasts correctly.
        const existing = sheet[addr];
        if (existing && existing.v != null && existing.v !== '') continue;
        sheet[addr] = { ...srcCell };
      }
    }
  }
}

/**
 * Read a sheet as a rectangular 2-D string array, post-merge-expansion
 * and post-cleanup.
 *
 * Steps:
 *   1. expandMerges so banners populate every column they span.
 *   2. sheet_to_json({ header: 1 }) returns a ragged grid (rows trail
 *      off when later columns are empty); pad short rows to maxCols
 *      with '' so column N means the same period across every row.
 *   3. Drop purely-empty rows (filtered out so the rendered table
 *      doesn't carry blank lines that bloat token count for no signal).
 *   4. Drop pure formatting separators (------ / ====== rows that
 *      Excel users add for visual spacing).
 *   5. Stringify each cell (formatted text via cell.w when available,
 *      raw value otherwise) and squash internal tabs/newlines so the
 *      rectangle shape survives downstream tab-separated rendering.
 *
 * Returns an empty array if the sheet has no usable rows.
 *
 * MUTATES THE SHEET (via expandMerges). Callers that want a non-mutating
 * read should pass a freshly-parsed sheet.
 */
export function readStructuredGrid(sheet: XLSX.WorkSheet): string[][] {
  expandMerges(sheet);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false, // formatted text (cell.w) so dates render as "Apr-23"
  });

  if (grid.length === 0) return [];

  // Pad short rows so the grid is a true rectangle. xlsx returns ragged
  // rows when later columns are empty; pad with '' to keep column
  // indices stable across rows.
  const maxCols = grid.reduce((m, r) => Math.max(m, r.length), 0);

  const cleanRows: string[][] = [];
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const padded: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      const v = row[c];
      // Render every cell as its string form. Tabs and newlines inside
      // cells get squashed so they don't break grid layout downstream.
      const s = v == null ? '' : String(v).replace(/[\t\n\r]+/g, ' ').trim();
      padded.push(s);
    }

    // Skip purely-empty rows (all cells empty after merge expansion).
    if (padded.every((cell) => cell === '')) continue;
    // Skip pure formatting separators (------ or ====== rows).
    const joined = padded.join('\t');
    if (/^[-_=\s\t]+$/.test(joined)) continue;

    cleanRows.push(padded);
  }

  return cleanRows;
}
