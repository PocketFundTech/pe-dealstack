/**
 * AI cost item E1 at the Claude extraction engine (Fable 5): tabs with no
 * financial content are left out of what Fable reads.
 *   - text path: they are not flattened into the document block;
 *   - container path: the workbook is uploaded UNCHANGED (sheet indexes are
 *     the sourcePage contract and rewriting loses number formats); the
 *     instruction only names the tabs the model needn't print.
 *
 * ai/client is mocked; the Excel flattener and sheet filter are REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import XLSX from 'xlsx';

const calls: any[] = [];
let responses: Array<string | Error> = [];
const uploadMock = vi.fn(async (_args: any) => ({ id: 'file_wb_1' }));
const deleteMock = vi.fn(async () => ({ id: 'file_wb_1', type: 'file_deleted' as const }));

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    const next = responses.shift() ?? '{"statements":[],"overallConfidence":0,"warnings":[]}';
    if (next instanceof Error) throw next;
    return { text: next, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({ beta: { files: { upload: uploadMock, delete: deleteMock } } })),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function workbook(sheets: [string, (string | number)[][]][]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const PNL = [
  ['Income Statement', 'FY2023', 'FY2024'],
  ['Revenue', 100, 140],
  ['Cost of goods sold', 40, 56],
  ['Gross profit', 60, 84],
  ['EBITDA', 20, 30],
  ['Net income', 10, 15],
];
const BOOK = () => workbook([
  ['Cover', [['Project Falcon'], ['Confidential']]],
  ['Notes', [['Read me'], ['Prepared by the advisor.']]],
  ['Sheet1', PNL], // statement under an odd name — must survive
]);

const CLEAN = JSON.stringify({
  statements: [{
    statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD',
    periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: [
      { name: 'revenue', value: 140, sourcePage: 3, sourceQuote: 'Sheet1!C2: 140' },
      { name: 'cogs', value: 56, sourcePage: 3, sourceQuote: 'Sheet1!C3: 56' },
      { name: 'gross_profit', value: 84, sourcePage: 3, sourceQuote: 'Sheet1!C4: 84' },
    ] }],
  }],
  overallConfidence: 90,
  warnings: [],
});

const instructionOf = (call: any): string => call.messages[0].content.at(-1).text;
const documentTextOf = (call: any): string => call.messages[0].content[0].text ?? '';

const savedMode = process.env.EXCEL_EXTRACTION_MODE;
beforeEach(() => {
  calls.length = 0;
  responses = [];
  uploadMock.mockClear();
  deleteMock.mockClear();
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.EXCEL_EXTRACTION_MODE;
  else process.env.EXCEL_EXTRACTION_MODE = savedMode;
});

async function extract(fileBuffer: Buffer, fileName = 'model.xlsx', fileType: 'excel' | 'pdf' = 'excel') {
  const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
  return extractWithClaude({ fileBuffer, fileName, fileType });
}

describe('E1 — Fable reads no cover / notes tabs', () => {
  it('text path: cover and notes are not in the document; the "Sheet1" P&L is', async () => {
    process.env.EXCEL_EXTRACTION_MODE = 'text';
    responses = [CLEAN];
    const out = await extract(BOOK());
    expect(out).not.toBeNull();
    const doc = documentTextOf(calls[0]);
    expect(doc).toContain('[Sheet: Sheet1]');
    expect(doc).toContain('Revenue');
    expect(doc).not.toContain('Project Falcon');
    expect(doc).not.toContain('[Sheet: Notes]');
  });

  it('container path: uploads the workbook unchanged and names the skippable tabs in the instruction', async () => {
    delete process.env.EXCEL_EXTRACTION_MODE; // container is the default
    responses = [CLEAN];
    const buf = BOOK();
    await extract(buf);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const uploaded = uploadMock.mock.calls[0][0].file as File;
    const bytes = Buffer.from(await uploaded.arrayBuffer());
    expect(bytes.equals(buf)).toBe(true);

    const instruction = instructionOf(calls[0]);
    expect(instruction).toContain('PRE-SCAN');
    expect(instruction).toContain('"Cover", "Notes"');
    expect(instruction).not.toMatch(/PRE-SCAN[^\n]*Sheet1/);
  });

  it('container path: no pre-scan note when every tab has content', async () => {
    delete process.env.EXCEL_EXTRACTION_MODE;
    responses = [CLEAN];
    await extract(workbook([['IS', PNL], ['Sheet2', PNL]]));
    expect(instructionOf(calls[0])).not.toContain('PRE-SCAN');
  });
});
