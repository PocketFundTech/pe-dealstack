/**
 * Claude extraction engine tests. ai/client is mocked; validateStatements is
 * real (deterministic), so the repair path is exercised with genuinely
 * inconsistent numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let responses: string[] = [];
// Records the order LLM calls and the file-delete call happen in, so tests
// can prove cleanup fires strictly after both possible LLM calls complete.
const eventOrder: string[] = [];
// Stable (not recreated per getAnthropicClient() call) so upload/delete share
// call history across the two separate getAnthropicClient() call sites in
// claudeEngine.ts (the upload branch and the finally-block cleanup).
const uploadMock = vi.fn(async () => ({ id: 'file_test123' }));
const deleteMock = vi.fn(async () => {
  eventOrder.push('delete');
  return { id: 'file_test123', type: 'file_deleted' as const };
});

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    eventOrder.push('llm');
    const text = responses.shift() ?? '{"statements":[],"overallConfidence":0,"warnings":[]}';
    return { text, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({
    beta: { files: { upload: uploadMock, delete: deleteMock } },
  })),
}));

// Excel path in claudeEngine.ts calls this directly — mocked the same way
// financial-extraction-cache.test.ts mocks it, so we can assert the Files
// API is never touched for excel input.
const extractTextFromExcelMock = vi.fn();
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: (...args: any[]) => extractTextFromExcelMock(...args),
}));

function isJson(revenue: number, cogs: number, grossProfit: number): string {
  return JSON.stringify({
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 90,
            lineItems: [
              { name: 'revenue', value: revenue, sourcePage: 1, sourceQuote: 'rev' },
              { name: 'cogs', value: cogs, sourcePage: 1, sourceQuote: 'cogs' },
              { name: 'gross_profit', value: grossProfit, sourcePage: 1, sourceQuote: 'gp' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 90,
    warnings: [],
  });
}

// ─── Fixture helpers for the statement-type-merge regression test ──────
// Raw (pre-normalize) shape: lineItems is an ARRAY of {name, value,
// sourcePage, sourceQuote}, matching extractionSchema.ts's rawStatement/
// rawPeriod/rawLineItem zod shapes — same convention as isJson() above.
function rawStatement(
  statementType: 'INCOME_STATEMENT' | 'BALANCE_SHEET' | 'CASH_FLOW',
  lineItems: Record<string, number>,
) {
  return {
    statementType,
    unitScale: 'MILLIONS',
    currency: 'USD',
    periods: [
      {
        period: '2023',
        periodType: 'HISTORICAL',
        confidence: 90,
        lineItems: Object.entries(lineItems).map(([name, value]) => ({
          name,
          value,
          sourcePage: 1,
          sourceQuote: name,
        })),
      },
    ],
  };
}

/**
 * Builds a 3-statement-type extraction response:
 *  - INCOME_STATEMENT: always internally consistent (revenue - cogs =
 *    gross_profit), so it never fails validateStatements on its own.
 *  - BALANCE_SHEET: assets(100) vs liabilities(50) + equity — pass
 *    `totalEquity: 30` for a genuine `bs_balances` error-severity failure
 *    (80 vs 100 is a 20% gap, way past TOLERANCE_LARGE = 0.01 from
 *    agents/financialAgent/config.ts), or `totalEquity: 50` for an exact,
 *    passing balance.
 *  - CASH_FLOW: operating_cf(50) - |capex(-10)| = fcf(40), always clean
 *    (cf_fcf_math is a warning check anyway, but kept passing so it never
 *    contributes noise), included only when `includeCashFlow`.
 */
function threeStatementJson(opts: {
  incomeRevenue: number;
  totalEquity: number;
  includeCashFlow: boolean;
}): string {
  const statements = [
    rawStatement('INCOME_STATEMENT', {
      revenue: opts.incomeRevenue,
      cogs: 40,
      gross_profit: opts.incomeRevenue - 40,
    }),
    rawStatement('BALANCE_SHEET', {
      cash: 20,
      total_assets: 100,
      total_liabilities: 50,
      total_equity: opts.totalEquity,
    }),
  ];
  if (opts.includeCashFlow) {
    statements.push(rawStatement('CASH_FLOW', { operating_cf: 50, capex: -10, fcf: 40 }));
  }
  return JSON.stringify({ statements, overallConfidence: 90, warnings: [] });
}

function findStatement(classification: any, statementType: string) {
  return classification.statements.find((s: any) => s.statementType === statementType);
}

beforeEach(() => {
  calls.length = 0;
  responses = [];
  eventOrder.length = 0;
  uploadMock.mockClear();
  deleteMock.mockClear();
  extractTextFromExcelMock.mockReset();
  // Default: plenty of readable text so an excel-path test runs all the way through.
  extractTextFromExcelMock.mockReturnValue('Income Statement\nRevenue 2023 100\n' + 'x'.repeat(200));
});

async function getEngine() {
  const mod = await import('../src/services/extraction/claudeEngine.js');
  return mod.extractWithClaude;
}

describe('extractWithClaude', () => {
  it('extracts a consistent PDF in one call (no repair)', async () => {
    responses = [isJson(100, 40, 60)]; // 100 - 40 = 60 ✓
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).not.toBeNull();
    expect(out!.repairUsed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(out!.classification.statements[0].periods[0].lineItems.revenue).toBe(100);
    // PDF path attaches the uploaded file, not raw text
    const content = calls[0].messages[0].content;
    expect(content.some((b: any) => b.type === 'document' && b.source?.file_id === 'file_test123')).toBe(true);
    expect(calls[0].extraBetas).toContain('files-api-2025-04-14');
  });

  it('runs exactly one repair pass when the validator fails, keeping the better result', async () => {
    responses = [isJson(100, 40, 90), isJson(100, 40, 60)]; // bad GP then fixed
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out!.repairUsed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[0].content.some((b: any) => typeof b.text === 'string' && b.text.includes('deterministic validator'))).toBe(true);
    expect(out!.classification.statements[0].periods[0].lineItems.gross_profit).toBe(60);
  });

  it('keeps the original when repair is worse, and never runs a second repair', async () => {
    responses = [isJson(100, 40, 90), isJson(100, 400, 90)]; // repair is worse
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(calls).toHaveLength(2); // exactly one repair, no loop
    expect(out!.classification.statements[0].periods[0].lineItems.cogs).toBe(40); // original kept
  });

  // ── Task 6 review findings: statement-type merge guard + file cleanup ──

  it('regression: a repair pass that silently drops a clean statement type does not lose it', async () => {
    // first: INCOME_STATEMENT clean, BALANCE_SHEET fails (liab 50 + equity 30 = 80 ≠ assets 100), CASH_FLOW clean.
    // repair: BALANCE_SHEET fixed (equity 50 → balances to 100), CASH_FLOW omitted entirely (the exact
    // failure mode the reviewer's scratch repro found), and INCOME_STATEMENT present but drifted (revenue
    // 999) to also prove a clean type is never adopted from the repair pass even when it IS present there.
    responses = [
      threeStatementJson({ incomeRevenue: 100, totalEquity: 30, includeCashFlow: true }),
      threeStatementJson({ incomeRevenue: 999, totalEquity: 50, includeCashFlow: false }),
    ];
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });

    expect(out).not.toBeNull();
    expect(out!.repairUsed).toBe(true);
    expect(calls).toHaveLength(2); // exactly one repair pass

    // All 3 statement types must survive — none silently dropped.
    expect(out!.classification.statements).toHaveLength(3);

    const income = findStatement(out!.classification, 'INCOME_STATEMENT');
    const balanceSheet = findStatement(out!.classification, 'BALANCE_SHEET');
    const cashFlow = findStatement(out!.classification, 'CASH_FLOW');

    // Was clean in `first` — kept as-is, NOT overwritten by the repair's drifted 999.
    expect(income.periods[0].lineItems.revenue).toBe(100);
    // Was the one genuine failure — repaired (fixed) value adopted.
    expect(balanceSheet.periods[0].lineItems.total_equity).toBe(50);
    // Was clean in `first` and omitted by the repair pass — must survive intact, unaltered.
    expect(cashFlow).toBeDefined();
    expect(cashFlow.periods[0].lineItems.operating_cf).toBe(50);
    expect(cashFlow.periods[0].lineItems.capex).toBe(-10);
    expect(cashFlow.periods[0].lineItems.fcf).toBe(40);
  });

  it('regression: a repair pass that silently drops a clean PERIOD within a failing statement type does not lose it', async () => {
    // BALANCE_SHEET has two periods: 2022 balances correctly (clean), 2023
    // does not (the genuine failure driving repair). The repair response
    // returns BALANCE_SHEET with ONLY the fixed 2023 period — silently
    // dropping 2022 — the same count-based-acceptance blind spot as the
    // statement-type bug, one level deeper (period, not type).
    const first = {
      statements: [
        {
          statementType: 'BALANCE_SHEET',
          unitScale: 'MILLIONS',
          currency: 'USD',
          periods: [
            {
              period: '2022',
              periodType: 'HISTORICAL',
              confidence: 90,
              lineItems: [
                { name: 'cash', value: 20, sourcePage: 1, sourceQuote: 'cash' },
                { name: 'total_assets', value: 100, sourcePage: 1, sourceQuote: 'assets' },
                { name: 'total_liabilities', value: 50, sourcePage: 1, sourceQuote: 'liab' },
                { name: 'total_equity', value: 50, sourcePage: 1, sourceQuote: 'equity' }, // 50+50=100 ✓
              ],
            },
            {
              period: '2023',
              periodType: 'HISTORICAL',
              confidence: 90,
              lineItems: [
                { name: 'cash', value: 20, sourcePage: 1, sourceQuote: 'cash' },
                { name: 'total_assets', value: 100, sourcePage: 1, sourceQuote: 'assets' },
                { name: 'total_liabilities', value: 50, sourcePage: 1, sourceQuote: 'liab' },
                { name: 'total_equity', value: 30, sourcePage: 1, sourceQuote: 'equity' }, // 50+30=80 ✗ fails bs_balances
              ],
            },
          ],
        },
      ],
      overallConfidence: 90,
      warnings: [],
    };
    const repairedOnly2023 = {
      statements: [
        {
          statementType: 'BALANCE_SHEET',
          unitScale: 'MILLIONS',
          currency: 'USD',
          periods: [
            {
              period: '2023',
              periodType: 'HISTORICAL',
              confidence: 90,
              lineItems: [
                { name: 'cash', value: 20, sourcePage: 1, sourceQuote: 'cash' },
                { name: 'total_assets', value: 100, sourcePage: 1, sourceQuote: 'assets' },
                { name: 'total_liabilities', value: 50, sourcePage: 1, sourceQuote: 'liab' },
                { name: 'total_equity', value: 50, sourcePage: 1, sourceQuote: 'equity' }, // fixed: 50+50=100 ✓
              ],
            },
            // 2022 omitted entirely — the exact silent-deletion failure mode.
          ],
        },
      ],
      overallConfidence: 90,
      warnings: [],
    };
    responses = [JSON.stringify(first), JSON.stringify(repairedOnly2023)];
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });

    expect(out).not.toBeNull();
    expect(out!.repairUsed).toBe(true);
    expect(calls).toHaveLength(2); // exactly one repair pass

    const balanceSheet = findStatement(out!.classification, 'BALANCE_SHEET');
    expect(balanceSheet.periods).toHaveLength(2); // both periods survive — none silently dropped

    const period2022 = balanceSheet.periods.find((p: any) => p.period === '2022');
    const period2023 = balanceSheet.periods.find((p: any) => p.period === '2023');
    // 2022 was clean and omitted by the repair — must survive verbatim from `first`.
    expect(period2022).toBeDefined();
    expect(period2022.lineItems.total_equity).toBe(50);
    // 2023 was the genuine failure — the repaired (fixed) value is adopted.
    expect(period2023).toBeDefined();
    expect(period2023.lineItems.total_equity).toBe(50);
  });

  it('returns null gracefully when the file upload fails, instead of throwing', async () => {
    uploadMock.mockRejectedValueOnce(new Error('upload failed'));
    const extractWithClaude = await getEngine();
    await expect(
      extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(0); // never reached the LLM
    expect(deleteMock).not.toHaveBeenCalled(); // no file id was ever obtained to clean up
  });

  it('deletes the uploaded file after a successful extraction with no repair needed', async () => {
    responses = [isJson(100, 40, 60)];
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });

    expect(out).not.toBeNull();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const uploaded = await uploadMock.mock.results[0]!.value;
    expect(deleteMock.mock.calls[0][0]).toBe(uploaded.id);
    expect(eventOrder).toEqual(['llm', 'delete']);
  });

  it('deletes the uploaded file exactly once even when a repair pass runs (only after both LLM calls)', async () => {
    responses = [isJson(100, 40, 90), isJson(100, 40, 60)]; // bad GP then fixed
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });

    expect(out!.repairUsed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(uploadMock).toHaveBeenCalledTimes(1); // only one upload across both LLM calls
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const uploaded = await uploadMock.mock.results[0]!.value;
    expect(deleteMock.mock.calls[0][0]).toBe(uploaded.id);
    // Cleanup fires strictly after both LLM calls complete, not in between.
    expect(eventOrder).toEqual(['llm', 'llm', 'delete']);
  });

  it('never touches files.upload/files.delete on the excel path', async () => {
    responses = [isJson(100, 40, 60)];
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('xlsx-fake'), fileName: 'model.xlsx', fileType: 'excel' });

    expect(out).not.toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
