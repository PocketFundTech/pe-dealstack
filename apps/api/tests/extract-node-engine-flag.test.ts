/**
 * EXTRACTION_ENGINE flag wiring tests: extractNode routes to the claude
 * engine when flagged; graph routing never sends claude output to the GPT
 * self-correct loop; verify/cross-verify skip for claude.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const engineCalls: any[] = [];
vi.mock('../src/services/extraction/claudeEngine.js', () => ({
  extractWithClaude: vi.fn(async (input: any) => {
    engineCalls.push(input);
    return {
      classification: {
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'MILLIONS',
            currency: 'USD',
            periods: [{ period: '2023', periodType: 'HISTORICAL', confidence: 91, lineItems: { revenue: 100 } }],
          },
        ],
        overallConfidence: 91,
        warnings: [],
      },
      rawText: '[claude-native-pdf] test.pdf',
      repairUsed: false,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }),
}));

// The cache hits Supabase — stub it out so the unit test stays offline.
vi.mock('../src/services/agents/financialAgent/extractionCache.js', () => ({
  hashContent: vi.fn(() => 'hash'),
  getCachedExtraction: vi.fn(async () => null),
  putCachedExtraction: vi.fn(async () => undefined),
}));

const savedEngine = process.env.EXTRACTION_ENGINE;
beforeEach(() => { engineCalls.length = 0; });
afterEach(() => {
  if (savedEngine === undefined) delete process.env.EXTRACTION_ENGINE;
  else process.env.EXTRACTION_ENGINE = savedEngine;
});

describe('extractNode engine flag', () => {
  it('EXTRACTION_ENGINE=claude routes to the claude engine and tags extractionSource', async () => {
    process.env.EXTRACTION_ENGINE = 'claude';
    const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
    const result = await extractNode({
      fileBuffer: Buffer.from('%PDF-fake'),
      fileName: 'test.pdf',
      fileType: 'pdf',
      forceExtraction: true,
    } as any);
    expect(engineCalls).toHaveLength(1);
    expect(result.extractionSource).toBe('claude');
    expect(result.status).toBe('validating');
    expect(result.statements).toHaveLength(1);
  });

  it('legacy path is untouched when the flag is absent', async () => {
    delete process.env.EXTRACTION_ENGINE;
    const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
    // A fake, non-PDF-looking buffer will fail pdf-parse quickly and fall through
    // to Vision, which will fail without an API key — assert the claude engine
    // mock was never invoked, which is the actual thing this test protects.
    await extractNode({
      fileBuffer: Buffer.from('not a real pdf'),
      fileName: 'test.pdf',
      fileType: 'pdf',
      forceExtraction: true,
    } as any).catch(() => {});
    expect(engineCalls).toHaveLength(0);
  });
});

describe('claude-source graph guards', () => {
  it('routeAfterValidate never self-corrects claude output', async () => {
    const { routeAfterValidate } = await import('../src/services/agents/financialAgent/graph.js');
    expect(routeAfterValidate({ status: 'self_correcting', extractionSource: 'claude' } as any)).toBe('store');
    expect(routeAfterValidate({ status: 'self_correcting', extractionSource: 'gpt4o' } as any)).toBe('self_correct');
  });

  it('verifyNode and crossVerifyNode skip claude extractions', async () => {
    const { verifyNode } = await import('../src/services/agents/financialAgent/nodes/verifyNode.js');
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const state = { extractionSource: 'claude', statements: [], rawText: 'x' } as any;
    const v = await verifyNode(state);
    const cv = await crossVerifyNode(state);
    expect(v.steps?.[0]?.message).toContain('Skipped');
    expect(cv.steps?.[0]?.message).toContain('Skipped');
  });
});
