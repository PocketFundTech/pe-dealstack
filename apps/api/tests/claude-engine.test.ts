/**
 * Claude extraction engine tests. ai/client is mocked; validateStatements is
 * real (deterministic), so the repair path is exercised with genuinely
 * inconsistent numbers.
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
    beta: { files: { upload: vi.fn(async () => ({ id: 'file_test123' })) } },
  })),
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

beforeEach(() => {
  calls.length = 0;
  responses = [];
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
});
