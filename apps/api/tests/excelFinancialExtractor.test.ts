/**
 * Excel Financial Extractor — Structured Row/Column Ingestion Tests
 * =================================================================
 *
 * Validates the merge-aware, structured-text representation that the
 * extractor ships to the LLM classifier. The previous flat
 * `sheet_to_csv` path lost merged-cell content (year banners, quarter
 * bands rendered as ",,,FY 2024,,,,,,,,") and only scanned the top
 * 8 × 10 cells for unit declarations, missing footnote-row declarations
 * which produced 1000× over-/under-stated EBITDA values.
 *
 * Coverage:
 *   - expandMerges spreads merged values across the entire merge range.
 *   - extractTextFromExcel emits aligned, tab-separated rows.
 *   - Year banners survive merge expansion (fixes "what year is this
 *     month under?" bug).
 *   - detectUnitScale finds declarations in row 14 / column N (beyond
 *     the 8 × 10 cap of the previous implementation).
 *   - detectUnitScale finds declarations in the sheet name.
 */

import { describe, it, expect, vi } from 'vitest';
import XLSX from 'xlsx';
import {
  expandMerges,
  detectUnitScale,
  extractTextFromExcel,
  extractStructuredExcel,
  extractSheetsFromExcel,
} from '../src/services/excelFinancialExtractor.js';
import { MAX_TEXT_LENGTH } from '../src/services/agents/financialAgent/config.js';
import {
  classifyPeriodLabel,
  detectPeriodRow,
  classifyLineItem,
  detectLineItems,
  normaliseLabel,
  isHeaderBand,
  detectSheetStructure,
  formatPeriodHintBlock,
  formatLineItemHintBlock,
} from '../src/services/excelStructureHints.js';

/** Build an in-memory worksheet from a 2-D string array. Merge ranges
 *  passed via `merges` follow xlsx's {s:{r,c}, e:{r,c}} convention. */
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

describe('expandMerges', () => {
  it('spreads a year banner across every column it visually spans', () => {
    // Row 0: blank | "FY 2024" merged across B-D | "FY 2025" across E-G
    // Row 1: month labels under each year
    const sheet = makeSheet(
      [
        ['', 'FY 2024', '', '', 'FY 2025', '', ''],
        ['', 'Jan-24', 'Feb-24', 'Mar-24', 'Jan-25', 'Feb-25', 'Mar-25'],
        ['Revenue', 100, 110, 120, 130, 140, 150],
      ],
      [
        { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }, // FY 2024 across B-D
        { s: { r: 0, c: 4 }, e: { r: 0, c: 6 } }, // FY 2025 across E-G
      ],
    );

    expandMerges(sheet);

    // Every cell in the FY 2024 merge range should now carry the value.
    expect(sheet['B1']?.v).toBe('FY 2024');
    expect(sheet['C1']?.v).toBe('FY 2024');
    expect(sheet['D1']?.v).toBe('FY 2024');
    // FY 2025 likewise.
    expect(sheet['E1']?.v).toBe('FY 2025');
    expect(sheet['F1']?.v).toBe('FY 2025');
    expect(sheet['G1']?.v).toBe('FY 2025');
    // Pre-existing non-merge cells are untouched.
    expect(sheet['B2']?.v).toBe('Jan-24');
    expect(sheet['A3']?.v).toBe('Revenue');
  });

  it('is a no-op when the sheet has no merges', () => {
    const sheet = makeSheet([
      ['', 'Jan-24', 'Feb-24'],
      ['Revenue', 100, 110],
    ]);
    expandMerges(sheet);
    expect(sheet['A1']?.v).toBe('');
    expect(sheet['B1']?.v).toBe('Jan-24');
    expect(sheet['A2']?.v).toBe('Revenue');
    expect(sheet['B2']?.v).toBe(100);
  });

  it('does not overwrite already-populated cells inside a merge range', () => {
    // This is defensive — xlsx's own writer never produces cells inside
    // a merge range, but pathological files in the wild sometimes do.
    const sheet = makeSheet(
      [['Banner', 'should-stay', 'also-stay']],
      [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
    );
    expandMerges(sheet);
    expect(sheet['A1']?.v).toBe('Banner');
    expect(sheet['B1']?.v).toBe('should-stay');
    expect(sheet['C1']?.v).toBe('also-stay');
  });
});

describe('detectUnitScale', () => {
  it('finds a $M declaration in row 1 (top-left zone)', () => {
    const sheet = makeSheet([
      ['Income Statement (in $M)'],
      ['Revenue', 50],
    ]);
    expect(detectUnitScale(sheet)).toContain('MILLIONS');
  });

  it('finds a $000s declaration in row 14 (beyond the legacy 8-row cap)', () => {
    // Old implementation would have missed this — 1000× under/over-stated
    // EBITDA depending on which way the LLM's magnitude guess went.
    const rows: (string | number | null)[][] = [];
    for (let i = 0; i < 13; i++) rows.push(['Revenue', i * 100]);
    rows.push(['Note: All figures in $000s']);
    const sheet = makeSheet(rows);
    expect(detectUnitScale(sheet)).toContain('THOUSANDS');
  });

  it('finds a $B declaration in a far-right column (beyond the legacy 10-col cap)', () => {
    const row: (string | number | null)[] = ['Revenue'];
    for (let c = 1; c <= 14; c++) row.push(0);
    row.push('(in $B)'); // column index 15 → spreadsheet col P
    const sheet = makeSheet([row]);
    expect(detectUnitScale(sheet)).toContain('BILLIONS');
  });

  it('falls back to the sheet name when grid-cell scan finds nothing', () => {
    const sheet = makeSheet([
      ['Revenue', 50, 100],
      ['EBITDA', 10, 22],
    ]);
    expect(detectUnitScale(sheet, 'P&L (in $M)')).toContain('MILLIONS');
  });

  it('returns null when no unit declaration is present anywhere', () => {
    const sheet = makeSheet([
      ['Revenue', 50, 100],
      ['EBITDA', 10, 22],
    ]);
    expect(detectUnitScale(sheet, 'Income Statement')).toBeNull();
  });
});

describe('extractTextFromExcel — structured row/column ingestion', () => {
  it('preserves column alignment via tab separators', () => {
    const sheet = makeSheet([
      ['', 'Jan-24', 'Feb-24', 'Mar-24'],
      ['Revenue', 100, 110, 120],
      ['EBITDA', 10, 12, 14],
    ]);
    const buffer = makeWorkbook([{ name: 'Income Statement', sheet }]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    // Tab-separated grid (commas inside numbers don't conflict).
    expect(text).toContain('\tJan-24\tFeb-24\tMar-24');
    expect(text).toContain('Revenue\t100\t110\t120');
    expect(text).toContain('EBITDA\t10\t12\t14');
    // Column-letter header anchors row references.
    expect(text).toContain('COL\tA\tB\tC\tD');
    // Per-sheet metadata block.
    expect(text).toMatch(/\[Grid: \d+ non-empty rows × \d+ cols\]/);
    expect(text).toContain('[Sheet: Income Statement] (financial statement detected)');
  });

  it('expands a merged year banner so months under FY 2024 show "FY 2024" in every column', () => {
    // The pre-fix bug: this row would render as ",FY 2024,,,FY 2025,,," and
    // the LLM had to guess which months belonged to which year — failing
    // on wide grids and producing absurd-magnitude EBITDA values.
    const sheet = makeSheet(
      [
        ['', 'FY 2024', '', '', 'FY 2025', '', ''],
        ['', 'Jan-24', 'Feb-24', 'Mar-24', 'Jan-25', 'Feb-25', 'Mar-25'],
        ['Revenue', 100, 110, 120, 130, 140, 150],
        ['EBITDA', 10, 12, 14, 16, 18, 20],
      ],
      [
        { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } },
        { s: { r: 0, c: 4 }, e: { r: 0, c: 6 } },
      ],
    );
    const buffer = makeWorkbook([{ name: 'P&L', sheet }]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    // Every month column under FY 2024 carries the year banner explicitly.
    expect(text).toContain('FY 2024\tFY 2024\tFY 2024\tFY 2025\tFY 2025\tFY 2025');
    // Month row sits directly below the now-aligned year banner.
    expect(text).toContain('Jan-24\tFeb-24\tMar-24\tJan-25\tFeb-25\tMar-25');
  });

  it('emits the unit-scale hint when a footnote row declares $000s (row 14)', () => {
    const rows: (string | number | null)[][] = [
      ['', 'Jan-24', 'Feb-24'],
      ['Revenue', 1000, 1100],
    ];
    // Pad so the footnote sits at row 14, beyond the legacy 8-row cap.
    while (rows.length < 13) rows.push(['', '', '']);
    rows.push(['Note: All figures in $000s', '', '']);
    const sheet = makeSheet(rows);
    const buffer = makeWorkbook([{ name: 'Financials', sheet }]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    expect(text).toContain('THOUSANDS');
  });

  it('renders multiple sheets in score order, separated by blank line', () => {
    const ifs = makeSheet([
      ['', 'Jan-24'],
      ['Revenue', 100],
    ]);
    const bs = makeSheet([
      ['', 'Jan-24'],
      ['Total Assets', 500],
    ]);
    const buffer = makeWorkbook([
      { name: 'Cover', sheet: makeSheet([['Just a cover page']]) },
      { name: 'Income Statement', sheet: ifs },
      { name: 'Balance Sheet', sheet: bs },
    ]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    // Cover sheet is in SKIP_PATTERNS → must not appear.
    expect(text).not.toContain('Just a cover page');
    // Both real statements appear.
    expect(text).toContain('[Sheet: Income Statement]');
    expect(text).toContain('[Sheet: Balance Sheet]');
    // Sheets are separated by a blank line.
    const sections = text!.split(/\n\n\[Sheet:/);
    expect(sections.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves empty cells so column indices stay aligned across rows', () => {
    // Real spreadsheets often have rows with values only in some columns.
    // The structured walk pads short rows so column N always means the
    // same period across every line item.
    const sheet = makeSheet([
      ['', 'Jan-24', 'Feb-24', 'Mar-24'],
      ['Revenue', 100, 110, 120],
      ['EBITDA', null, 12, 14], // null/empty Jan-24 cell
    ]);
    const buffer = makeWorkbook([{ name: 'P&L', sheet }]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    // EBITDA row has empty first value cell, then 12, then 14 — column
    // alignment preserved (the empty cell is a tab between two tabs).
    expect(text).toContain('EBITDA\t\t12\t14');
  });

  it('skips formatting separator rows (------ / ======) but keeps real content', () => {
    const sheet = makeSheet([
      ['', 'Jan-24', 'Feb-24'],
      ['------', '------', '------'],
      ['Revenue', 100, 110],
      ['======', '======', '======'],
      ['EBITDA', 10, 12],
    ]);
    const buffer = makeWorkbook([{ name: 'Income Statement', sheet }]);
    const text = extractTextFromExcel(buffer);

    expect(text).not.toBeNull();
    expect(text).toContain('Revenue\t100\t110');
    expect(text).toContain('EBITDA\t10\t12');
    // Separator rows are dropped — they carry no data and just bloat the
    // payload.
    expect(text).not.toContain('------');
    expect(text).not.toContain('======');
  });
});

// ─── Phase 3 P1: Per-Sheet Chunking Coverage ─────────────────
//
// The single-blob extractTextFromExcel concatenates every sheet, then
// classifyFinancials silently truncates past MAX_TEXT_LENGTH (120K).
// On real CIM-attached financial models this drops the 2nd/3rd sheet
// (Cash Flow, Balance Sheet) entirely — the agent reports one
// statement type instead of three. The fix is to expose a per-sheet
// array (`extractSheetsFromExcel`) the orchestrator can fan out to
// classifyFinancials with bounded concurrency.
//
// Tests below construct multi-sheet workbooks and verify:
//   1. Per-sheet text lengths are individually well below
//      MAX_TEXT_LENGTH while the combined text exceeds it (so the
//      old single-blob path WOULD have truncated).
//   2. Each sheet's text carries its own unit hint (so per-sheet
//      classifier calls don't lose unit context).
//   3. Cover/skip-pattern sheets are filtered out.
//   4. The orchestrator (extractNode) calls classifyFinancials once
//      per sheet — not once on a truncated blob — and merges the
//      per-sheet results.

/**
 * Build a wide monthly-grid sheet that produces ~`approxCharsPerSheet`
 * characters of structured text. Each row has ~36 columns of monthly
 * data (3 years × 12 months) so a few hundred line-item rows easily
 * pushes a single sheet over a target byte budget without resorting
 * to absurd row counts.
 */
function makeWideMonthlySheet(
  lineItemPrefix: string,
  rowCount: number,
): XLSX.WorkSheet {
  const months: string[] = [];
  for (const yr of ['23', '24', '25']) {
    for (const m of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']) {
      months.push(`${m}-${yr}`);
    }
  }
  const rows: (string | number)[][] = [['', ...months]];
  for (let i = 0; i < rowCount; i++) {
    // Long verbose label so each row contributes a healthy number of
    // chars even when most cells are short integers.
    const label = `${lineItemPrefix} sub-line item detail ${String(i).padStart(3, '0')}`;
    const row: (string | number)[] = [label];
    for (let m = 0; m < months.length; m++) {
      // Mix of small and 6-digit values so the rendered grid carries
      // realistic byte weight per cell.
      row.push((i + 1) * 1000 + m * 17);
    }
    rows.push(row);
  }
  return XLSX.utils.aoa_to_sheet(rows);
}

describe('extractSheetsFromExcel — per-sheet chunking (Phase 3 P1)', () => {
  it('returns a per-sheet array with every sheet ≤ MAX_TEXT_LENGTH while combined exceeds it', () => {
    // Three financial sheets, each large enough that the combined
    // single-blob output blows past MAX_TEXT_LENGTH (120K). Per-sheet
    // we expect each entry to fit comfortably below the cap so the
    // classifier never has to truncate.
    //
    // Row counts tuned so each sheet renders ~50–55K chars; combined
    // > 120K, individual < 120K.
    const incomeStatement = makeWideMonthlySheet('Revenue', 220);
    const balanceSheet = makeWideMonthlySheet('Asset', 220);
    const cashFlow = makeWideMonthlySheet('CF', 220);

    const buffer = makeWorkbook([
      { name: 'Income Statement', sheet: incomeStatement },
      { name: 'Balance Sheet', sheet: balanceSheet },
      { name: 'Cash Flow', sheet: cashFlow },
    ]);

    const sheets = extractSheetsFromExcel(buffer);

    // All three financial sheets are present — no silent truncation.
    expect(sheets).toHaveLength(3);
    const names = sheets.map(s => s.name).sort();
    expect(names).toEqual(['Balance Sheet', 'Cash Flow', 'Income Statement']);

    // Each sheet's text fits inside the per-call budget.
    for (const s of sheets) {
      expect(s.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      expect(s.text.length).toBeGreaterThan(20); // not empty
      // Self-contained: sheet header always present so the classifier
      // can correlate with the [Sheet:] anchor in its prompt.
      expect(s.text).toContain(`[Sheet: ${s.name}]`);
    }

    // The combined text would exceed the cap — i.e. the single-blob
    // path would have silently dropped the tail sheet. This is the
    // bug the chunking layer fixes.
    const combinedLength = sheets.reduce((sum, s) => sum + s.text.length, 0);
    expect(combinedLength).toBeGreaterThan(MAX_TEXT_LENGTH);
  });

  it('filters out skip-pattern sheets (Cover, Disclaimer) just like extractTextFromExcel', () => {
    const buffer = makeWorkbook([
      { name: 'Cover', sheet: makeSheet([['Just a cover page']]) },
      { name: 'Income Statement', sheet: makeSheet([
        ['', 'Jan-24', 'Feb-24'],
        ['Revenue', 100, 110],
      ]) },
      { name: 'Disclaimer', sheet: makeSheet([['Confidential — do not redistribute']]) },
    ]);

    const sheets = extractSheetsFromExcel(buffer);

    expect(sheets.map(s => s.name)).toEqual(['Income Statement']);
  });

  it('inlines the unit-scale hint into each sheet, so per-sheet calls preserve unit context', () => {
    // Two sheets, each with its OWN unit declaration. Per-sheet
    // classification must carry each declaration with its own sheet
    // — losing the hint on either sheet would tip the classifier's
    // unit-scale guess and produce 1000× over-/under-stated values.
    const incomeStatement = makeSheet([
      ['Income Statement (in $M)'],
      ['', 'Jan-24', 'Feb-24'],
      ['Revenue', 50, 55],
    ]);
    const balanceSheet = makeSheet([
      ['Balance Sheet ($000s)'],
      ['', 'Jan-24'],
      ['Total Assets', 5_000_000],
    ]);

    const buffer = makeWorkbook([
      { name: 'Income Statement', sheet: incomeStatement },
      { name: 'Balance Sheet', sheet: balanceSheet },
    ]);

    const sheets = extractSheetsFromExcel(buffer);
    expect(sheets).toHaveLength(2);

    const ifs = sheets.find(s => s.name === 'Income Statement')!;
    const bs = sheets.find(s => s.name === 'Balance Sheet')!;
    expect(ifs.text).toContain('MILLIONS');
    expect(bs.text).toContain('THOUSANDS');
  });

  it('returns an empty array (not null) when no sheets are usable — matches extractTextFromExcel null-return contract', () => {
    const buffer = makeWorkbook([
      { name: 'Cover', sheet: makeSheet([['Just a cover page']]) },
      { name: 'Disclaimer', sheet: makeSheet([['Confidential']]) },
    ]);

    const sheets = extractSheetsFromExcel(buffer);
    expect(sheets).toEqual([]);
  });
});

// ─── extractNode orchestrator: per-sheet fan-out ─────────────
//
// The orchestrator (apps/api/src/services/agents/financialAgent/nodes/
// extractNode.ts) is the layer that turns the per-sheet array into N
// classifyFinancials() calls. We mock classifyFinancials at module
// boundary so we can:
//   - record per-call inputs (verifying each sheet was sent
//     independently, not as one truncated blob)
//   - return distinct stub results per sheet (verifying merge
//     semantics line up with mergeExtractionResults)
//   - confirm no sheet's text gets cut at MAX_TEXT_LENGTH
//
// Mocks live INSIDE the describe block so they don't leak into the
// per-sheet tests above (which exercise the pure helper directly).
vi.mock('../src/services/financialClassifier.js', () => ({
  classifyFinancials: vi.fn(),
}));
vi.mock('../src/services/visionExtractor.js', () => ({
  classifyFinancialsVision: vi.fn(),
}));
vi.mock('../src/services/llamaParse.js', () => ({
  parseWithLlama: vi.fn(),
  isLlamaParseEnabled: () => false,
}));
vi.mock('../src/openai.js', () => ({
  openai: null,
  isAIEnabled: () => false,
  trackedChatCompletion: vi.fn(),
}));

describe('extractNode (Excel branch) — per-sheet fan-out (Phase 3 P1)', () => {
  it('calls classifyFinancials once per sheet, not once on a truncated blob, and merges results', async () => {
    const { classifyFinancials } = await import('../src/services/financialClassifier.js');
    const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
    const classifyMock = vi.mocked(classifyFinancials);
    classifyMock.mockReset();

    // Multi-sheet workbook engineered so the combined-blob path would
    // truncate (combined > MAX_TEXT_LENGTH) but each sheet fits.
    const incomeStatement = makeWideMonthlySheet('Revenue', 220);
    const balanceSheet = makeWideMonthlySheet('Asset', 220);
    const cashFlow = makeWideMonthlySheet('CF', 220);
    const buffer = makeWorkbook([
      { name: 'Income Statement', sheet: incomeStatement },
      { name: 'Balance Sheet', sheet: balanceSheet },
      { name: 'Cash Flow', sheet: cashFlow },
    ]);

    // Stub each call to return a distinct ClassifiedStatement so the
    // post-merge classification carries one of each statement type —
    // this is the exact bug we fix (old code only ever surfaced 1).
    classifyMock.mockImplementation(async (text: string) => {
      // Return statement keyed off which sheet's text we got. The
      // [Sheet: <name>] anchor is the cheapest signal.
      if (text.includes('[Sheet: Income Statement]')) {
        return {
          statements: [{
            statementType: 'INCOME_STATEMENT',
            unitScale: 'ACTUALS',
            currency: 'USD',
            periods: [{
              period: '2024',
              periodType: 'HISTORICAL',
              lineItems: { revenue: 100, ebitda: 20 },
              confidence: 90,
            }],
          }],
          overallConfidence: 90,
          warnings: [],
        };
      }
      if (text.includes('[Sheet: Balance Sheet]')) {
        return {
          statements: [{
            statementType: 'BALANCE_SHEET',
            unitScale: 'ACTUALS',
            currency: 'USD',
            periods: [{
              period: '2024',
              periodType: 'HISTORICAL',
              lineItems: { totalAssets: 500 },
              confidence: 85,
            }],
          }],
          overallConfidence: 85,
          warnings: [],
        };
      }
      if (text.includes('[Sheet: Cash Flow]')) {
        return {
          statements: [{
            statementType: 'CASH_FLOW',
            unitScale: 'ACTUALS',
            currency: 'USD',
            periods: [{
              period: '2024',
              periodType: 'HISTORICAL',
              lineItems: { freeCashFlow: 30 },
              confidence: 80,
            }],
          }],
          overallConfidence: 80,
          warnings: [],
        };
      }
      return null;
    });

    const result = await extractNode({
      fileBuffer: buffer,
      fileName: 'multi-sheet-model.xlsx',
      fileType: 'excel',
    } as any);

    // 1. classifyFinancials called once per sheet — not once on a
    //    blob that would have truncated past MAX_TEXT_LENGTH.
    expect(classifyMock).toHaveBeenCalledTimes(3);

    // 2. Each call's input was the SHEET'S text (carries the
    //    [Sheet: <name>] anchor), and stayed below MAX_TEXT_LENGTH.
    const callTexts: string[] = classifyMock.mock.calls.map((c: any[]) => c[0] as string);
    for (const t of callTexts) {
      expect(t.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      // Each call carries exactly ONE sheet's content — there are
      // never two [Sheet:] markers in a single classifier input.
      const sheetMarkers = (t.match(/\[Sheet: /g) || []).length;
      expect(sheetMarkers).toBe(1);
    }

    // No sheet was dropped — each financial sheet's content reached
    // the classifier.
    const allInputs = callTexts.join('\n');
    expect(allInputs).toContain('[Sheet: Income Statement]');
    expect(allInputs).toContain('[Sheet: Balance Sheet]');
    expect(allInputs).toContain('[Sheet: Cash Flow]');

    // 3. Per-sheet results are merged into the final classification —
    //    one statement per type, all three present (vs the bug where
    //    only INCOME_STATEMENT survived because the rest was
    //    truncated).
    expect(result.statements).toBeDefined();
    const types = (result.statements ?? []).map(s => s.statementType).sort();
    expect(types).toEqual(['BALANCE_SHEET', 'CASH_FLOW', 'INCOME_STATEMENT']);
    expect(result.status).toBe('validating');
  });
});

// ─── Phase 3 P3 — Period Detection ───────────────────────────────
//
// Walks the structured grid and finds the row(s) carrying period labels
// (Apr-23, Q1 2024, FY 2025, 2024E, etc.). Produces a column→period map
// the prompt builder serialises into a "[Period headers detected]" block.
// Without this hint the LLM was inferring spatial structure from the raw
// grid and silently dropping months on wide tables (36-month time series
// would emit only 4 annual periods).

describe('classifyPeriodLabel — period regex bank', () => {
  it.each([
    ['Apr-23', 'HISTORICAL_OR_PROJECTED'],
    ['Apr 23', 'HISTORICAL_OR_PROJECTED'],
    ['Apr-2023', 'HISTORICAL_OR_PROJECTED'],
    ['April 2024', 'HISTORICAL_OR_PROJECTED'],
    ['2024-04', 'HISTORICAL_OR_PROJECTED'],
    ['04-2024', 'HISTORICAL_OR_PROJECTED'],
    ['Q1 2024', 'HISTORICAL_OR_PROJECTED'],
    ['Q1-26', 'HISTORICAL_OR_PROJECTED'],
    ['1Q24', 'HISTORICAL_OR_PROJECTED'],
    ['H1 2024', 'HISTORICAL_OR_PROJECTED'],
    ['H2-26', 'HISTORICAL_OR_PROJECTED'],
    ['1H26', 'HISTORICAL_OR_PROJECTED'],
    ['2024', 'HISTORICAL_OR_PROJECTED'],
    ['FY2024', 'HISTORICAL_OR_PROJECTED'],
    ['FY 2025', 'HISTORICAL_OR_PROJECTED'],
    ['2024A', 'HISTORICAL_OR_PROJECTED'],
  ])('classifies %j as historical-or-projected', (input, expected) => {
    expect(classifyPeriodLabel(input)).toBe(expected);
  });

  it.each([
    ['2025E', 'PROJECTED_LIKELY'],
    ['2026E', 'PROJECTED_LIKELY'],
    ['FY26E', 'PROJECTED_LIKELY'],
    ['FY 2027 Est', 'PROJECTED_LIKELY'],
    ['FY26 Forecast', 'PROJECTED_LIKELY'],
    ['FY26 Budget', 'PROJECTED_LIKELY'],
  ])('classifies projected-suffix label %j as PROJECTED_LIKELY', (input, expected) => {
    expect(classifyPeriodLabel(input)).toBe(expected);
  });

  it.each([
    'LTM Mar-26',
    'Apr-26 LTM',
    'TTM 2024',
  ])('classifies LTM/TTM label %j as LTM', (input) => {
    expect(classifyPeriodLabel(input)).toBe('LTM');
  });

  it.each([
    'Revenue', 'COGS', '', 'random', 'Total', 'EBITDA Build',
  ])('returns null for non-period label %j', (input) => {
    expect(classifyPeriodLabel(input)).toBeNull();
  });

  it('strips surrounding parens from "(Q1 2024)" and still matches', () => {
    expect(classifyPeriodLabel('(Q1 2024)')).toBe('HISTORICAL_OR_PROJECTED');
  });
});

describe('detectPeriodRow — period band finder', () => {
  it('finds a single-row monthly band starting at row 0', () => {
    // Single header row; 36 months would be common in real CIMs but 4
    // columns is enough to exercise the contiguous-run threshold.
    const grid: unknown[][] = [
      ['', 'Apr-23', 'May-23', 'Jun-23', 'Jul-23'],
      ['Revenue', 100, 110, 120, 130],
    ];
    const detected = detectPeriodRow(grid);
    expect(detected).not.toBeNull();
    expect(detected!.row).toBe(0);
    expect(detected!.periods).toHaveLength(4);
    expect(detected!.periods[0].colLetter).toBe('B');
    expect(detected!.periods[0].label).toBe('Apr-23');
  });

  it('prefers the month band over the year banner in a two-row header', () => {
    // After merge expansion, row 0 has "FY 2024 / FY 2024 / FY 2024 /
    // FY 2025 / …". Row 1 has the actual month band. We want the month
    // row (more distinct labels = real period axis).
    const grid: unknown[][] = [
      ['', 'FY 2024', 'FY 2024', 'FY 2024', 'FY 2025', 'FY 2025', 'FY 2025'],
      ['', 'Jan-24', 'Feb-24', 'Mar-24', 'Jan-25', 'Feb-25', 'Mar-25'],
      ['Revenue', 100, 110, 120, 130, 140, 150],
    ];
    const detected = detectPeriodRow(grid);
    expect(detected).not.toBeNull();
    expect(detected!.row).toBe(1);
    expect(detected!.periods.map((p) => p.label)).toEqual([
      'Jan-24', 'Feb-24', 'Mar-24', 'Jan-25', 'Feb-25', 'Mar-25',
    ]);
  });

  it('finds quarter bands "Q1 2024 | Q2 2024 | Q3 2024 | Q4 2024"', () => {
    const grid: unknown[][] = [
      ['', 'Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2024', 'FY 2024'],
      ['Revenue', 25, 26, 27, 28, 106],
    ];
    const detected = detectPeriodRow(grid);
    expect(detected).not.toBeNull();
    expect(detected!.row).toBe(0);
    expect(detected!.periods.map((p) => p.label)).toEqual([
      'Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2024', 'FY 2024',
    ]);
  });

  it('finds year-only bands with mixed actual / projected suffixes', () => {
    const grid: unknown[][] = [
      ['', '2023A', '2024A', '2025E', '2026E'],
      ['Revenue', 100, 110, 120, 130],
    ];
    const detected = detectPeriodRow(grid);
    expect(detected).not.toBeNull();
    expect(detected!.periods.map((p) => p.classification)).toEqual([
      'HISTORICAL_OR_PROJECTED', // 2023A
      'HISTORICAL_OR_PROJECTED', // 2024A
      'PROJECTED_LIKELY',        // 2025E
      'PROJECTED_LIKELY',        // 2026E
    ]);
  });

  it('handles a mixed band: LTM Mar-26 | FY 2024 | FY 2025 | FY 2026E', () => {
    const grid: unknown[][] = [
      ['', 'LTM Mar-26', 'FY 2024', 'FY 2025', 'FY 2026E'],
      ['Revenue', 200, 100, 150, 250],
    ];
    const detected = detectPeriodRow(grid);
    expect(detected).not.toBeNull();
    expect(detected!.periods).toHaveLength(4);
    expect(detected!.periods[0].classification).toBe('LTM');
    expect(detected!.periods[3].classification).toBe('PROJECTED_LIKELY');
  });

  it('returns null when the grid has no period band (only labels in column A)', () => {
    const grid: unknown[][] = [
      ['Income Statement'],
      ['Revenue', 100],
      ['EBITDA', 30],
    ];
    expect(detectPeriodRow(grid)).toBeNull();
  });

  it('rejects a single stray date cell as the period band (needs ≥ 3 contiguous)', () => {
    // A single "Apr-24" floating in a row of titles should NOT be picked
    // up as the period axis — that would mean we'd emit a single period
    // for a sheet that's really a key-value summary.
    const grid: unknown[][] = [
      ['Title', '', 'Apr-24', '', 'Notes'],
      ['Revenue', 100, 110, 120, 130],
    ];
    expect(detectPeriodRow(grid)).toBeNull();
  });
});

// ─── Phase 3 P4 — Line-Item Label Classification ─────────────────
//
// Walks column A and matches each label against the canonical
// LINE_ITEM_KEYS bank. Order in the regex bank matters: percentage
// rows ("EBITDA Margin") are tested BEFORE their dollar counterparts
// so the LLM doesn't store a margin row as the dollar key.

describe('normaliseLabel — column-A label normalisation', () => {
  it('lower-cases and trims', () => {
    expect(normaliseLabel('  Revenue  ')).toBe('revenue');
    expect(normaliseLabel('REVENUE')).toBe('revenue');
  });

  it('strips leading enumeration ("1.", "1)", "•", " - ")', () => {
    expect(normaliseLabel('1. Revenue')).toBe('revenue');
    expect(normaliseLabel('1) COGS')).toBe('cogs');
    expect(normaliseLabel('• EBITDA')).toBe('ebitda');
    expect(normaliseLabel('- Net Income')).toBe('net income');
  });

  it('strips trailing footnote markers and punctuation', () => {
    expect(normaliseLabel('Revenue (1)')).toBe('revenue');
    expect(normaliseLabel('Revenue*')).toBe('revenue');
    expect(normaliseLabel('Revenue:')).toBe('revenue');
  });

  it('collapses internal whitespace runs', () => {
    expect(normaliseLabel('Total   Revenue')).toBe('total revenue');
  });
});

describe('isHeaderBand — section-header detection', () => {
  it.each([
    'income statement',
    'balance sheet',
    'cash flow',
    'cash flow statement',
    'profit and loss',
    'p & l',
    'assets',
    'liabilities',
    'current assets',
    'operating activities',
    'historical',
    'projected',
    'ebitda build',
  ])('flags %j as a header band', (label) => {
    expect(isHeaderBand(label)).toBe(true);
  });

  it.each([
    'revenue',
    'cogs',
    'ebitda',
    'total assets',
    'gross profit',
  ])('does NOT flag canonical line item %j as a header band', (label) => {
    expect(isHeaderBand(label)).toBe(false);
  });
});

describe('classifyLineItem — canonical-key mapping', () => {
  // Cases covering INCOME_STATEMENT / BALANCE_SHEET / CASH_FLOW
  // including the disambiguation edges (Operating Income → ebit,
  // EBITDA Margin → ebitda_margin_pct, Gross Margin → pct).
  const cases: Array<[string, string, string]> = [
    ['Revenue', 'revenue', 'INCOME_STATEMENT'],
    ['Total Revenue', 'revenue', 'INCOME_STATEMENT'],
    ['Net Sales', 'revenue', 'INCOME_STATEMENT'],
    ['Turnover', 'revenue', 'INCOME_STATEMENT'],
    ['COGS', 'cogs', 'INCOME_STATEMENT'],
    ['Cost of Goods Sold', 'cogs', 'INCOME_STATEMENT'],
    ['Cost of Sales', 'cogs', 'INCOME_STATEMENT'],
    ['Gross Profit', 'gross_profit', 'INCOME_STATEMENT'],
    ['Gross Margin', 'gross_margin_pct', 'INCOME_STATEMENT'],
    ['Gross Margin %', 'gross_margin_pct', 'INCOME_STATEMENT'],
    ['SG&A', 'sga', 'INCOME_STATEMENT'],
    ['R&D', 'rd', 'INCOME_STATEMENT'],
    ['EBITDA', 'ebitda', 'INCOME_STATEMENT'],
    ['Adjusted EBITDA', 'ebitda', 'INCOME_STATEMENT'],
    ['EBITDA Margin', 'ebitda_margin_pct', 'INCOME_STATEMENT'],
    ['EBITDA Margin %', 'ebitda_margin_pct', 'INCOME_STATEMENT'],
    ['Operating Income', 'ebit', 'INCOME_STATEMENT'],
    ['Operating Profit', 'ebit', 'INCOME_STATEMENT'],
    ['EBIT', 'ebit', 'INCOME_STATEMENT'],
    ['D&A', 'da', 'INCOME_STATEMENT'],
    ['Depreciation and Amortization', 'da', 'INCOME_STATEMENT'],
    ['Interest Expense', 'interest_expense', 'INCOME_STATEMENT'],
    ['Tax', 'tax', 'INCOME_STATEMENT'],
    ['Net Income', 'net_income', 'INCOME_STATEMENT'],
    // Balance sheet
    ['Cash', 'cash', 'BALANCE_SHEET'],
    ['Cash and Equivalents', 'cash', 'BALANCE_SHEET'],
    ['Accounts Receivable', 'accounts_receivable', 'BALANCE_SHEET'],
    ['Inventory', 'inventory', 'BALANCE_SHEET'],
    ['Total Current Assets', 'total_current_assets', 'BALANCE_SHEET'],
    ['Goodwill', 'goodwill', 'BALANCE_SHEET'],
    ['Total Assets', 'total_assets', 'BALANCE_SHEET'],
    ['Accounts Payable', 'accounts_payable', 'BALANCE_SHEET'],
    ['Long-term Debt', 'long_term_debt', 'BALANCE_SHEET'],
    ['Total Liabilities', 'total_liabilities', 'BALANCE_SHEET'],
    ['Total Equity', 'total_equity', 'BALANCE_SHEET'],
    // Cash flow
    ['Operating Cash Flow', 'operating_cf', 'CASH_FLOW'],
    ['Cash from Operations', 'operating_cf', 'CASH_FLOW'],
    ['CapEx', 'capex', 'CASH_FLOW'],
    ['Capital Expenditures', 'capex', 'CASH_FLOW'],
    ['Free Cash Flow', 'fcf', 'CASH_FLOW'],
    ['FCF', 'fcf', 'CASH_FLOW'],
    ['Dividends', 'dividends', 'CASH_FLOW'],
    ['Net Change in Cash', 'net_change_cash', 'CASH_FLOW'],
  ];

  it.each(cases)('maps "%s" → %s (%s)', (label, expectedKey, expectedStmt) => {
    const matched = classifyLineItem(label);
    expect(matched).not.toBeNull();
    expect(matched!.key).toBe(expectedKey);
    expect(matched!.statement).toBe(expectedStmt);
  });

  it('attaches a disambiguation note for "Operating Income" → ebit', () => {
    const matched = classifyLineItem('Operating Income');
    expect(matched).not.toBeNull();
    expect(matched!.note).toMatch(/NOT ebitda/i);
  });

  it('attaches a disambiguation note for "EBITDA Margin" → ebitda_margin_pct', () => {
    const matched = classifyLineItem('EBITDA Margin');
    expect(matched).not.toBeNull();
    expect(matched!.note).toMatch(/percentage/i);
  });

  it('returns null for header bands like "INCOME STATEMENT"', () => {
    expect(classifyLineItem('INCOME STATEMENT')).toBeNull();
    expect(classifyLineItem('Balance Sheet')).toBeNull();
    expect(classifyLineItem('EBITDA Build')).toBeNull();
  });

  it('returns null for empty / unknown labels', () => {
    expect(classifyLineItem('')).toBeNull();
    expect(classifyLineItem('Random Label')).toBeNull();
    expect(classifyLineItem(null)).toBeNull();
  });
});

describe('detectLineItems — column-A walk over a grid', () => {
  it('emits one hint per matched row plus an unmatched list', () => {
    const grid: unknown[][] = [
      ['', 'Apr-23', 'May-23'],            // row 0 — period band, not labelled
      ['INCOME STATEMENT'],                  // row 1 — header band, dropped
      ['Revenue', 100, 110],                 // row 2 — line item
      ['COGS', 30, 33],                      // row 3
      ['Gross Profit', 70, 77],              // row 4
      ['EBITDA', 25, 28],                    // row 5
      ['EBITDA Margin', 25, 25.5],           // row 6 — must map to ebitda_margin_pct
      ['Some Random Note', null, null],      // row 7 — unmatched
    ];
    const result = detectLineItems(grid);
    expect(result.lineItems.map((li) => li.canonicalKey)).toEqual([
      'revenue', 'cogs', 'gross_profit', 'ebitda', 'ebitda_margin_pct',
    ]);
    expect(result.lineItems.find((li) => li.row === 6)!.canonicalKey)
      .toBe('ebitda_margin_pct');
    expect(result.unmatchedLabels.map((u) => u.label)).toEqual([
      'Some Random Note',
    ]);
  });

  it('skips rows where column A is empty', () => {
    const grid: unknown[][] = [
      ['Revenue', 100],
      ['', 110],         // empty column A — skipped
      ['COGS', 30],
    ];
    const result = detectLineItems(grid);
    expect(result.lineItems.map((li) => li.canonicalKey)).toEqual([
      'revenue', 'cogs',
    ]);
  });
});

// ─── Phase 3 P3+P4 — Sheet-level integration & prompt formatters ─

describe('detectSheetStructure — entry-point wrapper', () => {
  it('returns both period and line-item hints for a typical P&L grid', () => {
    const grid: unknown[][] = [
      ['', 'Apr-23', 'May-23', 'Jun-23'],
      ['Revenue', 100, 110, 120],
      ['EBITDA', 25, 28, 32],
      ['EBITDA Margin', 25, 25.5, 26.7],
    ];
    const hints = detectSheetStructure(grid);
    expect(hints.periodRow).toBe(0);
    expect(hints.periods).toHaveLength(3);
    expect(hints.lineItems.map((li) => li.canonicalKey)).toEqual([
      'revenue', 'ebitda', 'ebitda_margin_pct',
    ]);
    expect(hints.unmatchedLabels).toHaveLength(0);
  });
});

describe('formatPeriodHintBlock — prompt-ready period block', () => {
  it('renders one line per period plus an EXPECTED OUTPUT footer', () => {
    const periods = [
      { col: 1, colLetter: 'B', label: 'Apr-23', classification: 'HISTORICAL_OR_PROJECTED' as const },
      { col: 2, colLetter: 'C', label: 'May-23', classification: 'HISTORICAL_OR_PROJECTED' as const },
      { col: 3, colLetter: 'D', label: '2025E', classification: 'PROJECTED_LIKELY' as const },
    ];
    const block = formatPeriodHintBlock(periods);
    expect(block).toContain('[Period headers detected]');
    expect(block).toContain('Column B: Apr-23');
    expect(block).toContain('Column C: May-23');
    expect(block).toContain('Column D: 2025E (PROJECTED — explicit suffix)');
    expect(block).toContain('EXPECTED OUTPUT: emit one period per detected column above (3 periods)');
  });

  it('returns an empty string when no periods are passed', () => {
    expect(formatPeriodHintBlock([])).toBe('');
  });
});

describe('formatLineItemHintBlock — prompt-ready line-item block', () => {
  it('renders matched rows with notes, then unmatched rows', () => {
    const lineItems = [
      { row: 3, label: 'Revenue', canonicalKey: 'revenue', statement: 'INCOME_STATEMENT' as const },
      // Row 11 emits the disambiguation note we surface to the prompt.
      { row: 11, label: 'Operating Income', canonicalKey: 'ebit', statement: 'INCOME_STATEMENT' as const, note: 'NOT ebitda — operating_income maps to ebit' },
      { row: 17, label: 'EBITDA Margin', canonicalKey: 'ebitda_margin_pct', statement: 'INCOME_STATEMENT' as const, note: 'percentage row, store as ebitda_margin_pct' },
    ];
    const unmatched = [
      { row: 25, label: 'Some random text' },
    ];
    const block = formatLineItemHintBlock(lineItems, unmatched);
    expect(block).toContain('[Line item rows detected]');
    // Row numbers are 1-based in the prompt to match how spreadsheet
    // users see them — internal hints are 0-based.
    expect(block).toContain('Row 4: Revenue → revenue');
    expect(block).toContain('Row 12: Operating Income → ebit  (NOT ebitda — operating_income maps to ebit)');
    expect(block).toContain('Row 18: EBITDA Margin → ebitda_margin_pct  (percentage row, store as ebitda_margin_pct)');
    expect(block).toContain('[Unmatched column-A labels');
    expect(block).toContain('Row 26: Some random text');
  });

  it('caps the unmatched list at 30 entries with a "more" note', () => {
    const unmatched = Array.from({ length: 50 }, (_, i) => ({
      row: 100 + i,
      label: `Stray ${i}`,
    }));
    const block = formatLineItemHintBlock([], unmatched);
    expect(block).toContain('Stray 0');
    expect(block).toContain('Stray 29');
    expect(block).not.toContain('Stray 30');
    expect(block).toContain('… (20 more unmatched labels)');
  });
});

// ─── End-to-end: extractStructuredExcel returns hints + text ─────

describe('extractStructuredExcel — workbook → structured result', () => {
  it('attaches period + line-item hint blocks to a P&L sheet', () => {
    // Mini 36-month-style sheet (3 months, same shape) so the test
    // exercises both detection paths end-to-end without producing a
    // 200-line snapshot.
    const sheet = makeSheet([
      ['', 'Apr-23', 'May-23', 'Jun-23'],
      ['Revenue', 100, 110, 120],
      ['COGS', 30, 33, 36],
      ['EBITDA', 25, 28, 32],
      ['EBITDA Margin', 25, 25.5, 26.7],
    ]);
    const buffer = makeWorkbook([{ name: 'Income Statement', sheet }]);
    const result = extractStructuredExcel(buffer);

    expect(result).not.toBeNull();
    expect(result!.text).toContain('Revenue\t100\t110\t120');
    // Period hints block surfaces all three months under the sheet name.
    expect(result!.periodHintsBlock).toContain('Sheet "Income Statement":');
    expect(result!.periodHintsBlock).toContain('[Period headers detected]');
    expect(result!.periodHintsBlock).toContain('Column B: Apr-23');
    expect(result!.periodHintsBlock).toContain('Column D: Jun-23');
    expect(result!.periodHintsBlock).toContain('emit one period per detected column above (3 periods)');
    // Line-item hints surface the canonical-key map plus the EBITDA
    // Margin disambiguation note.
    expect(result!.lineItemHintsBlock).toContain('[Line item rows detected]');
    expect(result!.lineItemHintsBlock).toMatch(/Row \d+: Revenue → revenue/);
    expect(result!.lineItemHintsBlock).toMatch(/Row \d+: EBITDA Margin → ebitda_margin_pct/);
    // perSheetHints contains the structured data for diagnostics.
    expect(result!.perSheetHints).toHaveLength(1);
    expect(result!.perSheetHints[0].sheetName).toBe('Income Statement');
    expect(result!.perSheetHints[0].hints.periods).toHaveLength(3);
    expect(result!.perSheetHints[0].hints.lineItems).toHaveLength(4);
  });

  it('preserves backwards compatibility: extractTextFromExcel returns same text', () => {
    const sheet = makeSheet([
      ['', 'Apr-23', 'May-23'],
      ['Revenue', 100, 110],
    ]);
    const buffer = makeWorkbook([{ name: 'Income Statement', sheet }]);
    const text = extractTextFromExcel(buffer);
    const structured = extractStructuredExcel(buffer);
    expect(text).toBe(structured!.text);
  });
});
