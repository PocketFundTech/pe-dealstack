/**
 * AI cost item E1 — sheets with no financial content are left out of what
 * the Claude extraction engine (Fable 5) reads, and statement tabs are never
 * dropped, whatever they're called.
 *
 * Workbooks are built in-test with xlsx. The filter is content-based
 * (excelSheetFilter.ts): a sheet is dropped only with fewer than
 * MIN_NUMERIC_CELLS numbers AND no financial / unit / fiscal-year wording.
 */
import { describe, it, expect, vi } from 'vitest';
import XLSX from 'xlsx';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  findNoFinancialContentSheets,
  profileSheetContent,
  isNoFinancialContent,
  looksLikeStatement,
} from '../src/services/excelSheetFilter.js';
import { extractTextFromExcel } from '../src/services/excelFinancialExtractor.js';

type Rows = (string | number | null)[][];

function workbook(sheets: [string, Rows][]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const PNL: Rows = [
  ['Income Statement', 'FY2022', 'FY2023', 'FY2024'],
  ['Revenue', 100, 120, 140],
  ['Cost of goods sold', 40, 48, 56],
  ['Gross profit', 60, 72, 84],
  ['EBITDA', 20, 25, 30],
  ['Net income', 10, 12, 15],
];
const BALANCE: Rows = [
  ['', 'FY2023', 'FY2024'],
  ['Cash', 10, 12],
  ['Total assets', 200, 220],
  ['Total liabilities', 120, 130],
  ["Shareholders' equity", 80, 90],
];
const CASH_FLOW: Rows = [
  ['', 'FY2023', 'FY2024'],
  ['Net income', 12, 15],
  ['Cash from operating activities', 18, 22],
  ['Capital expenditure', -6, -7],
  ['Free cash flow', 12, 15],
];
const COVER: Rows = [['Project Falcon'], ['Confidential'], ['Prepared October 2026']];
const NOTES: Rows = [['Read me'], ['This workbook was prepared by the sell-side advisor.'], ['Do not distribute.']];
const CHARTS: Rows = []; // chart-only tab: no cells

describe('excelSheetFilter — what counts as "no financial content"', () => {
  it('drops cover, notes and chart-only tabs; keeps the P&L', () => {
    const buf = workbook([['Cover', COVER], ['Notes', NOTES], ['Charts', CHARTS], ['P&L', PNL]]);
    expect(findNoFinancialContentSheets(buf)).toEqual(['Cover', 'Notes', 'Charts']);
  });

  it('keeps a notes / cover tab that declares units or fiscal year — the model needs it for scale and periods', () => {
    const buf = workbook([
      ['Notes', [['All figures in $000s unless stated']]],
      ['Cover', [['Project Falcon'], ['Fiscal year ends 31 March']]],
      ['P&L', PNL],
    ]);
    expect(findNoFinancialContentSheets(buf)).toEqual([]);
  });

  it('keeps an assumptions tab that has numbers, drops one that is an empty shell', () => {
    const buf = workbook([
      ['Assumptions', [['Growth', 0.05], ['Inflation', 0.02], ['Headcount', 40], ['Price', 12]]],
      ['Inputs', [['Scenario switches — fill in later']]],
      ['P&L', PNL],
    ]);
    expect(findNoFinancialContentSheets(buf)).toEqual(['Inputs']);
  });

  it('never drops oddly-named statement tabs', () => {
    const buf = workbook([
      ['Cover', COVER],
      ['Sheet1', PNL],
      ['Tab 7', BALANCE],
      ['Output', CASH_FLOW],
    ]);
    expect(findNoFinancialContentSheets(buf)).toEqual(['Cover']);
  });

  it('keeps every sheet when every sheet has content', () => {
    const buf = workbook([['IS', PNL], ['BS', BALANCE], ['CF', CASH_FLOW]]);
    expect(findNoFinancialContentSheets(buf)).toEqual([]);
  });

  it('drops nothing when every sheet looks empty (send the workbook as before)', () => {
    const buf = workbook([['Cover', COVER], ['Notes', NOTES]]);
    expect(findNoFinancialContentSheets(buf)).toEqual([]);
  });

  it('never drops the only sheet (CSV) and never throws on garbage', () => {
    expect(findNoFinancialContentSheets(Buffer.from('a,b\nhello,world\n'))).toEqual([]);
    expect(findNoFinancialContentSheets(Buffer.from([0, 1, 2, 3]))).toEqual([]);
  });

  it('profiles numbers, formulas and statement rows', () => {
    const sheet = XLSX.utils.aoa_to_sheet(PNL);
    const p = profileSheetContent(sheet, 'Sheet1');
    expect(p.numericCells).toBe(15);
    expect(isNoFinancialContent(p)).toBe(false);
    expect(looksLikeStatement(p)).toBe(true);

    // A formula with no cached value still counts as content.
    const formulas = XLSX.utils.aoa_to_sheet([['x']]);
    for (const addr of ['B1', 'B2', 'B3', 'B4']) formulas[addr] = { t: 'z', f: 'A1*2' } as XLSX.CellObject;
    formulas['!ref'] = 'A1:B4';
    expect(isNoFinancialContent(profileSheetContent(formulas, 'Calc'))).toBe(false);
  });
});

describe('extractTextFromExcel({ contentAware: true }) — the Claude engine text path', () => {
  it('leaves cover / notes / chart tabs out of the text Fable reads', () => {
    const buf = workbook([['Cover Page', COVER], ['Read Me', NOTES], ['Charts', CHARTS], ['P&L', PNL]]);
    const text = extractTextFromExcel(buf, { contentAware: true })!;
    expect(text).toContain('[Sheet: P&L]');
    expect(text).not.toContain('Cover Page');
    expect(text).not.toContain('Read Me');
    expect(text).not.toContain('Project Falcon');

    // The legacy (name-only) mode sends those two tabs today — this is the saving.
    const legacy = extractTextFromExcel(buf)!;
    expect(legacy).toContain('[Sheet: Cover Page]');
    expect(legacy).toContain('[Sheet: Read Me]');
  });

  it('keeps statement tabs whose names the old name filter threw away ("Sheet1", "Dashboard")', () => {
    const buf = workbook([['Cover', COVER], ['Sheet1', PNL], ['Dashboard', BALANCE], ['CF', CASH_FLOW]]);
    const text = extractTextFromExcel(buf, { contentAware: true })!;
    expect(text).toContain('[Sheet: Sheet1]');
    expect(text).toContain('[Sheet: Dashboard]');
    expect(text).toContain('[Sheet: CF]');
    expect(text).not.toContain('[Sheet: Cover]');

    // Legacy name filter dropped both statement tabs.
    const legacy = extractTextFromExcel(buf)!;
    expect(legacy).not.toContain('[Sheet: Sheet1]');
    expect(legacy).not.toContain('[Sheet: Dashboard]');
  });

  it('reads a CSV P&L (parsed as "Sheet1") instead of finding nothing', () => {
    const csv = Buffer.from('Line,2023,2024\nRevenue,100,120\nCOGS,40,50\nGross Profit,60,70\nEBITDA,20,30\nNet Income,10,15\n');
    expect(extractTextFromExcel(csv)).toBeNull(); // name filter skips "Sheet1"
    expect(extractTextFromExcel(csv, { contentAware: true })).toContain('Revenue');
  });

  it('keeps every sheet of an all-financial workbook', () => {
    const buf = workbook([['Income Statement', PNL], ['Balance Sheet', BALANCE], ['Cash Flow', CASH_FLOW]]);
    const text = extractTextFromExcel(buf, { contentAware: true })!;
    for (const name of ['Income Statement', 'Balance Sheet', 'Cash Flow']) expect(text).toContain(`[Sheet: ${name}]`);
  });
});
