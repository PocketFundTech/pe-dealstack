/**
 * Token savings (2026-09-29): the repair pass asked claude-fable-5 to
 * regenerate the FULL extraction ($50 / 1M output tokens, every statement
 * with per-line sourceQuotes), but mergeRepairedStatements() only ever keeps
 * the statement types that failed validation — everything else was
 * generated and thrown away. The repair now asks for the failed types only.
 * The full previous extraction is still sent as context (cross-statement
 * checks need it), and the merged result is identical by construction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let responses: string[] = [];

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    const text = responses.shift() ?? '{"statements":[],"overallConfidence":0,"warnings":[]}';
    return { text, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({
    beta: { files: { upload: vi.fn(async () => ({ id: 'file_1' })), delete: vi.fn(async () => ({})) } },
  })),
}));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({ extractTextFromExcel: vi.fn() }));

function stmt(statementType: string, items: Record<string, number>) {
  return {
    statementType,
    unitScale: 'MILLIONS',
    currency: 'USD',
    periods: [{
      period: '2023', periodType: 'HISTORICAL', confidence: 90,
      lineItems: Object.entries(items).map(([name, value]) => ({ name, value, sourcePage: 1, sourceQuote: name })),
    }],
  };
}
const json = (...statements: unknown[]) => JSON.stringify({ statements, overallConfidence: 90, warnings: [] });

// Income statement fails the validator (100 - 40 != 999); balance sheet is clean.
const badIncome = stmt('INCOME_STATEMENT', { revenue: 100, cogs: 40, gross_profit: 999 });
const goodIncome = stmt('INCOME_STATEMENT', { revenue: 100, cogs: 40, gross_profit: 60 });
const cleanBalance = stmt('BALANCE_SHEET', { total_assets: 50, total_liabilities: 20, total_equity: 30 });

beforeEach(() => { calls.length = 0; responses = []; });

async function run() {
  const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
  return extractWithClaude({ fileBuffer: Buffer.from('%PDF'), fileName: 'cim.pdf', fileType: 'pdf' });
}
const lastInstruction = (call: any) => {
  const content = call.messages[0].content as any[];
  return content[content.length - 1].text as string;
};

describe('extraction repair pass — only the failed statements are regenerated', () => {
  it('asks the repair call for the failed statement types only', async () => {
    responses = [json(badIncome, cleanBalance), json(goodIncome)];
    await run();
    expect(calls).toHaveLength(2);
    const instruction = lastInstruction(calls[1]);
    expect(instruction).toContain('INCOME_STATEMENT');
    expect(instruction).toMatch(/return ONLY/i);
    expect(instruction).not.toMatch(/FULL corrected extraction/i);
    // The clean statement is not requested...
    expect(instruction).not.toMatch(/return ONLY[^\n]*BALANCE_SHEET/i);
    // ...but the full previous extraction is still provided as context.
    expect(instruction).toContain('BALANCE_SHEET');
  });

  it('merges a failed-types-only repair into the same result a full repair would have produced', async () => {
    responses = [json(badIncome, cleanBalance), json(goodIncome)];
    const out = await run();
    expect(out!.repairUsed).toBe(true);
    const types = out!.classification.statements.map((s) => s.statementType).sort();
    expect(types).toEqual(['BALANCE_SHEET', 'INCOME_STATEMENT']);
    const income = out!.classification.statements.find((s) => s.statementType === 'INCOME_STATEMENT')!;
    expect(income.periods[0].lineItems.gross_profit).toBe(60);
    const balance = out!.classification.statements.find((s) => s.statementType === 'BALANCE_SHEET')!;
    expect(balance.periods[0].lineItems.total_assets).toBe(50);
  });
});
