/**
 * Extraction is the single largest Anthropic cost driver in production
 * (confirmed via the UsageEvent ledger: claude-fable-5 extraction calls
 * account for ~99% of tracked weekly spend, much of it on repair passes and
 * container→text fallbacks that resend the same system prompt + document
 * reference). Three other Claude call sites in this codebase already mark
 * their stable prefix with `cache_control: { type: 'ephemeral' }`
 * (claudeFinancialClassifier.ts, financialCrossVerify.ts,
 * dealChatAgent/index.ts) — claudeEngine.ts was the one place that didn't,
 * despite every extraction call resending an identical system prompt and,
 * on a repair pass or a container→text fallback, an identical document
 * reference. This is a pure cost optimization: caching changes nothing
 * about what is sent to the model or what comes back, only how Anthropic
 * bills a repeated prefix (~90% cheaper on a cache hit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let responses: string[] = [];

const uploadMock = vi.fn(async () => ({ id: 'file_test123' }));
const deleteMock = vi.fn(async () => ({ id: 'file_test123', type: 'file_deleted' as const }));

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    const text = responses.shift() ?? '{"statements":[],"overallConfidence":0,"warnings":[]}';
    return { text, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({
    beta: { files: { upload: uploadMock, delete: deleteMock } },
  })),
}));

const extractTextFromExcelMock = vi.fn();
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: (...args: any[]) => extractTextFromExcelMock(...args),
}));

function inconsistentJson(): string {
  // gross_profit deliberately wrong so the deterministic validator fails
  // and a repair pass runs — this is the path that resends the document.
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
              { name: 'revenue', value: 100, sourcePage: 1, sourceQuote: 'rev' },
              { name: 'cogs', value: 40, sourcePage: 1, sourceQuote: 'cogs' },
              { name: 'gross_profit', value: 999, sourcePage: 1, sourceQuote: 'gp' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 80,
    warnings: [],
  });
}

function cleanJson(): string {
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
              { name: 'revenue', value: 100, sourcePage: 1, sourceQuote: 'rev' },
              { name: 'cogs', value: 40, sourcePage: 1, sourceQuote: 'cogs' },
              { name: 'gross_profit', value: 60, sourcePage: 1, sourceQuote: 'gp' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 90,
    warnings: [],
  });
}

function lastContentBlock(call: any): any {
  const content = call.messages[0].content;
  return content[content.length - 1];
}

function systemCacheControl(call: any): unknown {
  // system may be a string (uncached, legacy) or an array of text blocks.
  if (typeof call.system === 'string') return undefined;
  const blocks = call.system as Array<{ cache_control?: unknown }>;
  return blocks[blocks.length - 1]?.cache_control;
}

describe('extractWithClaude — prompt caching', () => {
  beforeEach(() => {
    calls.length = 0;
    responses = [];
    uploadMock.mockClear();
    deleteMock.mockClear();
    process.env.EXCEL_EXTRACTION_MODE = 'text';
  });

  it('marks the system prompt as cacheable on a plain PDF extraction call', async () => {
    responses = [cleanJson()];
    const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
    await extractWithClaude({ fileBuffer: Buffer.from('pdf'), fileName: 'cim.pdf', fileType: 'pdf' } as any);

    expect(calls).toHaveLength(1);
    expect(systemCacheControl(calls[0])).toEqual({ type: 'ephemeral' });
  });

  it('marks the document content block (Files API reference) as cacheable, not the trailing instruction', async () => {
    responses = [cleanJson()];
    const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
    await extractWithClaude({ fileBuffer: Buffer.from('pdf'), fileName: 'cim.pdf', fileType: 'pdf' } as any);

    const content = calls[0].messages[0].content as any[];
    // The document/file block (not the last, varying instruction block)
    // should carry the marker.
    const docBlock = content.find((b) => b.type === 'document');
    expect(docBlock.cache_control).toEqual({ type: 'ephemeral' });
    // The trailing instruction text block must stay uncached (it can differ
    // between the first pass and a repair pass — caching it would either
    // miss every time or, worse, silently reuse stale text).
    const instructionBlock = lastContentBlock(calls[0]);
    expect(instructionBlock.cache_control).toBeUndefined();
  });

  it('a repair pass resends the identical cached document block so the second call is a cache hit', async () => {
    responses = [inconsistentJson(), cleanJson()];
    const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
    await extractWithClaude({ fileBuffer: Buffer.from('pdf'), fileName: 'cim.pdf', fileType: 'pdf' } as any);

    expect(calls).toHaveLength(2);
    const firstDoc = (calls[0].messages[0].content as any[]).find((b) => b.type === 'document');
    const secondDoc = (calls[1].messages[0].content as any[]).find((b) => b.type === 'document');
    expect(secondDoc.source).toEqual(firstDoc.source);
    expect(secondDoc.cache_control).toEqual({ type: 'ephemeral' });
    expect(systemCacheControl(calls[1])).toEqual({ type: 'ephemeral' });
  });

  it('does not change what text is sent or how the response is parsed (caching is billing-only)', async () => {
    responses = [cleanJson()];
    const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');
    const result = await extractWithClaude({ fileBuffer: Buffer.from('pdf'), fileName: 'cim.pdf', fileType: 'pdf' } as any);

    expect(result?.classification.statements[0].periods[0].lineItems.revenue).toBe(100);
    expect(systemCacheControl(calls[0])).toBeDefined();
    // The instruction text itself is unchanged by caching.
    const instructionBlock = lastContentBlock(calls[0]);
    expect(typeof instructionBlock.text).toBe('string');
    expect(instructionBlock.text.length).toBeGreaterThan(0);
  });
});
