/**
 * Excel Grid Reader — Shared Reader Tests (Phase 3 P5)
 * =====================================================
 *
 * Phase 3 P5 hoisted `expandMerges` + a new `readStructuredGrid` helper
 * into `excelGridReader.ts` so BOTH the financial extractor (LLM
 * classifier path) and the chat-RAG markdown renderer consume the same
 * merge-aware rectangular grid. This test pins the contract:
 *
 *   1. The shared reader spreads merged values across every cell of
 *      their merge range, pads short rows so the result is rectangular,
 *      and drops empty/separator rows.
 *   2. The financial extractor's tab-separated grid and the markdown
 *      renderer's table both produce the SAME row count (after header)
 *      and the SAME column count for the same input — proving the two
 *      paths can no longer disagree on a workbook's contents.
 *   3. A merged year banner appears in EVERY column it visually spans
 *      in BOTH representations, fixing the long-standing bug where chat
 *      saw "FY 2024" only in the top-left while extraction saw it
 *      broadcast.
 */

import { describe, it, expect } from 'vitest';
import XLSX from 'xlsx';
import {
  expandMerges,
  readStructuredGrid,
} from '../src/services/excelGridReader.js';
import { extractTextFromExcel } from '../src/services/excelFinancialExtractor.js';
import { excelToMarkdown } from '../src/services/excelToMarkdown.js';

/** Build an in-memory worksheet from a 2-D array. */
function makeSheet(
  rows: (string | number | null)[][],
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [],
): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length > 0) sheet['!merges'] = merges;
  return sheet;
}

function makeWorkbook(sheets: { name: string; sheet: XLSX.WorkSheet }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const { name, sheet } of sheets) {
    XLSX.utils.book_append_sheet(wb, sheet, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('readStructuredGrid', () => {
  it('returns a rectangular 2-D array with merges expanded', () => {
    // Row 0: blank | "FY 2024" merged across B-D
    // Row 1: month labels (no merges)
    // Row 2: revenue values
    const sheet = makeSheet(
      [
        ['', 'FY 2024', '', ''],
        ['', 'Jan-24', 'Feb-24', 'Mar-24'],
        ['Revenue', 100, 110, 120],
      ],
      [{ s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }],
    );

    const grid = readStructuredGrid(sheet);

    expect(grid.length).toBe(3); // year row + month row + revenue row
    // Every row has the same column count (rectangular).
    const cols = grid[0].length;
    for (const row of grid) {
      expect(row.length).toBe(cols);
    }
    // Year banner broadcast to every cell of the merge range.
    expect(grid[0]).toEqual(['', 'FY 2024', 'FY 2024', 'FY 2024']);
    expect(grid[1]).toEqual(['', 'Jan-24', 'Feb-24', 'Mar-24']);
    expect(grid[2]).toEqual(['Revenue', '100', '110', '120']);
  });

  it('drops purely-empty rows and formatting separators', () => {
    const sheet = makeSheet([
      ['', 'Jan-24', 'Feb-24'],
      ['', '', ''], // empty
      ['Revenue', 100, 110],
      ['------', '------', '------'], // separator
      ['EBITDA', 10, 12],
    ]);

    const grid = readStructuredGrid(sheet);

    // Only the 3 real rows survive.
    expect(grid.length).toBe(3);
    expect(grid[0][0]).toBe('');
    expect(grid[1][0]).toBe('Revenue');
    expect(grid[2][0]).toBe('EBITDA');
  });

  it('returns an empty array for a sheet with no usable rows', () => {
    const sheet = makeSheet([
      ['', '', ''],
      ['------', '------', '------'],
    ]);
    expect(readStructuredGrid(sheet)).toEqual([]);
  });

  it('expandMerges is exposed and is a no-op when there are no merges', () => {
    const sheet = makeSheet([
      ['', 'Jan-24'],
      ['Revenue', 100],
    ]);
    expandMerges(sheet);
    expect(sheet['B1']?.v).toBe('Jan-24');
    expect(sheet['A2']?.v).toBe('Revenue');
  });
});

describe('extraction + markdown agree on shape and content', () => {
  // Workbook with merges + multiple sheets + a junk sheet (Cover).
  // Both the financial extractor and the markdown renderer should
  // see the same row count, the same column count, and the same
  // year banner in every column it spans.
  const buildWorkbook = () =>
    makeWorkbook([
      // Cover is in SKIP_PATTERNS — both paths must skip it.
      { name: 'Cover', sheet: makeSheet([['Just a cover page']]) },
      {
        name: 'Income Statement',
        sheet: makeSheet(
          [
            ['', 'FY 2024', '', '', 'FY 2025', '', ''],
            ['', 'Jan-24', 'Feb-24', 'Mar-24', 'Jan-25', 'Feb-25', 'Mar-25'],
            ['Revenue', 100, 110, 120, 130, 140, 150],
            ['EBITDA', 10, 12, 14, 16, 18, 20],
          ],
          [
            { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }, // FY 2024 across B-D
            { s: { r: 0, c: 4 }, e: { r: 0, c: 6 } }, // FY 2025 across E-G
          ],
        ),
      },
      {
        name: 'Balance Sheet',
        sheet: makeSheet([
          ['', 'Jan-24', 'Feb-24'],
          ['Total Assets', 500, 550],
          ['Total Liabilities', 300, 320],
        ]),
      },
    ]);

  it('financial extractor emits one tab-separated row per data line with merges expanded', () => {
    const buffer = buildWorkbook();
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    // Cover is junk — must not leak into either path.
    expect(text).not.toContain('Just a cover page');
    expect(text).toContain('[Sheet: Income Statement]');
    expect(text).toContain('[Sheet: Balance Sheet]');
    // Year banner broadcast to every column it spans, not just the
    // top-left. This is the bug fixed by sharing the reader.
    expect(text).toContain('FY 2024\tFY 2024\tFY 2024\tFY 2025\tFY 2025\tFY 2025');
    expect(text).toContain('Revenue\t100\t110\t120\t130\t140\t150');
    expect(text).toContain('EBITDA\t10\t12\t14\t16\t18\t20');
  });

  it('markdown renderer emits a table with same column count and same data row count', () => {
    const buffer = buildWorkbook();
    const md = excelToMarkdown(buffer);

    expect(md).not.toBeNull();
    expect(md).not.toContain('Just a cover page');
    expect(md).toContain('## Sheet: Income Statement');
    expect(md).toContain('## Sheet: Balance Sheet');

    // The Income Statement section: 7-column table (8 pipes per row),
    // 1 header row, 1 divider, 3 data rows (year banner + month row +
    // Revenue + EBITDA, with one of those rows picked as the header).
    const isStart = md!.indexOf('## Sheet: Income Statement');
    const isEnd = md!.indexOf('## Sheet: Balance Sheet');
    expect(isStart).toBeGreaterThanOrEqual(0);
    expect(isEnd).toBeGreaterThan(isStart);
    const isSection = md!.slice(isStart, isEnd);

    // Year banner survives merge expansion in markdown too.
    expect(isSection).toContain('FY 2024');
    expect(isSection).toContain('FY 2025');
    expect(isSection).toContain('Revenue');
    expect(isSection).toContain('EBITDA');

    // Count column count via pipes on a data row containing "Revenue".
    const tableLines = isSection
      .split('\n')
      .filter((l) => l.startsWith('|') && l.endsWith('|'));
    // header + divider + at least one body row
    expect(tableLines.length).toBeGreaterThanOrEqual(3);
    const headerPipes = (tableLines[0].match(/\|/g) || []).length;
    expect(headerPipes).toBe(8); // 7 columns -> 8 pipes
    const revenueLine = tableLines.find((l) => l.includes('Revenue'));
    expect(revenueLine).toBeTruthy();
    const revenuePipes = (revenueLine!.match(/\|/g) || []).length;
    // Data row column count agrees with header column count — the
    // contract that lets the LLM line up periods to values.
    expect(revenuePipes).toBe(headerPipes);
  });

  it('merged year banner appears in BOTH representations under every spanned column', () => {
    const buffer = buildWorkbook();
    const text = extractTextFromExcel(buffer);
    const md = excelToMarkdown(buffer);

    expect(text).not.toBeNull();
    expect(md).not.toBeNull();

    // Tab-separated grid: three contiguous "FY 2024" cells, then three
    // contiguous "FY 2025" cells. Pre-fix we'd see "FY 2024\t\t\tFY 2025"
    // because xlsx only stores the merge value in the top-left cell.
    expect(text).toMatch(/FY 2024\tFY 2024\tFY 2024/);
    expect(text).toMatch(/FY 2025\tFY 2025\tFY 2025/);

    // Markdown: the same three contiguous "FY 2024" cells separated by
    // pipes. Pre-fix the chat path would have rendered "| FY 2024 | — | — |"
    // and an embedding query for "FY 2024 Q1 revenue" would miss the
    // alignment to Jan/Feb/Mar.
    expect(md).toMatch(/FY 2024\s*\|\s*FY 2024\s*\|\s*FY 2024/);
    expect(md).toMatch(/FY 2025\s*\|\s*FY 2025\s*\|\s*FY 2025/);
  });

  it('row count agreement: extractor data lines == markdown body rows for a single sheet', () => {
    // Single-sheet workbook keeps the comparison clean (no need to
    // partition multi-sheet output). The Income Statement here has:
    //   row 0: year banner -> picked up as a data row by the extractor
    //   row 1: month header -> picked up as a data row by the extractor
    //          AND picked as the markdown HEADER row
    //   row 2: Revenue
    //   row 3: EBITDA
    // Extractor emits all 4 as tab-separated rows. Markdown renders
    // row 0 as a body row (year banner above the header in markdown
    // is unusual — header heuristic picks the month row), row 1 as
    // the header, rows 2-3 as body rows. So markdown body row count
    // (3) + 1 header == extractor data row count (4). That equality is
    // what "agreement" means for this test.
    const sheet = makeSheet(
      [
        ['', 'FY 2024', '', ''],
        ['', 'Jan-24', 'Feb-24', 'Mar-24'],
        ['Revenue', 100, 110, 120],
        ['EBITDA', 10, 12, 14],
      ],
      [{ s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }],
    );
    const buffer = makeWorkbook([{ name: 'Income Statement', sheet }]);

    const text = extractTextFromExcel(buffer);
    const md = excelToMarkdown(buffer);
    expect(text).not.toBeNull();
    expect(md).not.toBeNull();

    // Extractor: count tab-separated data rows under the [Sheet:] header.
    // Drop the metadata block (`[Grid: …]` and `COL\tA\tB\t…`).
    const sheetSection = text!.split('[Sheet:')[1] ?? '';
    const dataLines = sheetSection
      .split('\n')
      .filter((l) => l.includes('\t') && !l.startsWith('COL') && !l.startsWith('[Grid:'));
    expect(dataLines.length).toBe(4);

    // Markdown: count body rows (lines starting with | excluding header
    // and divider).
    const tableLines = md!
      .split('\n')
      .filter((l) => l.startsWith('|') && l.endsWith('|'));
    // header + divider + body rows
    const bodyRows = tableLines.length - 2;
    expect(bodyRows + 1).toBe(dataLines.length); // body + 1 header == extractor row count
  });
});
