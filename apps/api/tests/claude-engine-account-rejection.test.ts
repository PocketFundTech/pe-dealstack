/**
 * AI cost item E2 at the Claude extraction engine (Fable 5): an
 * out-of-credit / bad-key rejection surfaces as AIProviderUnavailableError
 * and no second (text-mode) Fable call runs; other failures (timeouts, bad
 * output) keep the container → text fallback.
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

import { AIProviderUnavailableError } from '../src/utils/aiErrors.js';

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

/** What the Anthropic SDK throws when the account has no credit. */
const outOfCredit = () => Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 });
const badKey = () => Object.assign(new Error('401 invalid x-api-key'), { status: 401, error: { type: 'authentication_error' } });
const timeout = () => Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });

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

describe('E2 — no backup Fable call after a credit / auth rejection', () => {
  it('container: out of credit → AIProviderUnavailableError, text mode never runs', async () => {
    delete process.env.EXCEL_EXTRACTION_MODE;
    responses = [outOfCredit()];
    const err = await extract(BOOK()).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderUnavailableError);
    expect(err.reason).toBe('quota');
    expect(err.message).toContain('credits are exhausted');
    expect(calls).toHaveLength(1);
  });

  it('container: bad key → AIProviderUnavailableError (auth), text mode never runs', async () => {
    delete process.env.EXCEL_EXTRACTION_MODE;
    responses = [badKey()];
    const err = await extract(BOOK()).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderUnavailableError);
    expect(err.reason).toBe('auth');
    expect(calls).toHaveLength(1);
  });

  it('container: a timeout still falls back to text mode', async () => {
    delete process.env.EXCEL_EXTRACTION_MODE;
    responses = [timeout(), CLEAN];
    const out = await extract(BOOK());
    expect(out?.classification.statements).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(documentTextOf(calls[1])).toContain('[Sheet: Sheet1]');
  });

  it('text mode / PDF: out of credit surfaces as AIProviderUnavailableError, not a raw 400', async () => {
    process.env.EXCEL_EXTRACTION_MODE = 'text';
    responses = [outOfCredit()];
    await expect(extract(BOOK())).rejects.toBeInstanceOf(AIProviderUnavailableError);

    responses = [badKey()];
    const err = await extract(Buffer.from('%PDF-1.4'), 'cim.pdf', 'pdf').catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderUnavailableError);
    expect(err.reason).toBe('auth');
  });

  it('text mode: a non-provider error is rethrown unchanged', async () => {
    process.env.EXCEL_EXTRACTION_MODE = 'text';
    responses = [timeout()];
    const err = await extract(BOOK()).catch((e) => e);
    expect(err).not.toBeInstanceOf(AIProviderUnavailableError);
    expect(err.message).toBe('Request timed out.');
  });
});
