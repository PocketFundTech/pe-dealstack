/**
 * Composed-graph integration test: invokes the ACTUAL compiled LangGraph
 * financial agent graph (not individual nodes in isolation) with
 * EXTRACTION_ENGINE=claude and a genuinely failing extraction, to prove the
 * cross-node interaction actually works: verify/crossVerify skip, validate
 * routes claude state to store (never self_correct), and store persists
 * with the claude-aware confidence path — the exact composition that unit
 * tests of each node individually cannot catch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/extraction/claudeEngine.js', () => ({
  // storeNode.ts imports CLAUDE_NATIVE_PDF_MARKER from this module (Fix 1:
  // single-source-of-truth for the marker) — the mock factory must export it
  // too, or computeSourceMatchAvg's `.startsWith(CLAUDE_NATIVE_PDF_MARKER)`
  // call throws on an undefined import.
  CLAUDE_NATIVE_PDF_MARKER: '[claude-native-pdf]',
  extractWithClaude: vi.fn(async () => ({
    classification: {
      statements: [
        {
          statementType: 'BALANCE_SHEET',
          unitScale: 'MILLIONS',
          currency: 'USD',
          periods: [
            {
              period: '2023',
              periodType: 'HISTORICAL',
              confidence: 85,
              lineItems: {
                cash: 20,
                total_assets: 100,
                total_liabilities: 50,
                total_equity: 30, // 50+30=80≠100 — genuine bs_balances failure
                total_equity_source: 'equity of $30M',
              },
            },
          ],
        },
      ],
      overallConfidence: 85,
      warnings: [],
    },
    rawText: '[claude-native-pdf] cim.pdf — extracted via structured output; no text-layer dump',
    repairUsed: true,
    usage: { inputTokens: 500, outputTokens: 200 },
  })),
}));

vi.mock('../src/services/agents/financialAgent/extractionCache.js', () => ({
  hashContent: vi.fn(() => 'hash'),
  getCachedExtraction: vi.fn(async () => null),
  putCachedExtraction: vi.fn(async () => undefined),
}));

const runDeepPassMock = vi.fn(async (input: any) => ({
  statementsStored: input.classification.statements.length,
  periodsStored: input.classification.statements[0]?.periods.length ?? 0,
  overallConfidence: input.classification.overallConfidence,
  statementIds: ['stmt_1'],
  warnings: input.classification.warnings ?? [],
  hasConflicts: false,
}));
vi.mock('../src/services/financialExtractionOrchestrator.js', () => ({
  runDeepPass: (...args: any[]) => runDeepPassMock(...args),
}));

vi.mock('../src/services/agentMemory.js', () => ({
  recordExtractionLearning: vi.fn(async () => undefined),
}));

const savedEngine = process.env.EXTRACTION_ENGINE;
beforeEach(() => {
  process.env.EXTRACTION_ENGINE = 'claude';
  runDeepPassMock.mockClear();
});
afterEach(() => {
  if (savedEngine === undefined) delete process.env.EXTRACTION_ENGINE;
  else process.env.EXTRACTION_ENGINE = savedEngine;
});

describe('financial agent graph — claude-sourced run with genuine validator failures', () => {
  it('skips verify/crossVerify, never self-corrects, and stores via the claude-aware path', async () => {
    const { getFinancialAgentGraph } = await import('../src/services/agents/financialAgent/graph.js');
    const graph = getFinancialAgentGraph();

    const finalState: any = await graph.invoke({
      dealId: 'deal_test',
      documentId: 'doc_test',
      fileBuffer: Buffer.from('%PDF-fake'),
      fileName: 'cim.pdf',
      fileType: 'pdf',
      organizationId: null,
      maxRetries: 3,
      skipVerify: false,
      forceExtraction: true,
    });

    // Self-correction never ran — retryCount only increments in selfCorrectNode.
    expect(finalState.retryCount).toBe(0);
    expect(finalState.status).toBe('completed');
    expect(finalState.extractionSource).toBe('claude');

    // verify/crossVerify recorded a skip step, not real verification work.
    const verifySteps = finalState.steps.filter((s: any) => s.node === 'verify');
    const crossVerifySteps = finalState.steps.filter((s: any) => s.node === 'crossVerify');
    expect(verifySteps.some((s: any) => s.message.includes('Skipped'))).toBe(true);
    expect(crossVerifySteps.some((s: any) => s.message.includes('Skipped'))).toBe(true);

    // validateNode logged the accurate (non-self-correction) message.
    const validateSteps = finalState.steps.filter((s: any) => s.node === 'validate');
    expect(validateSteps.some((s: any) => s.message.includes('routing to self-correction'))).toBe(false);
    expect(validateSteps.some((s: any) => s.message.includes("repair pass already ran"))).toBe(true);

    // store received the claude extractionSource.
    expect(runDeepPassMock).toHaveBeenCalledTimes(1);
    expect(runDeepPassMock.mock.calls[0][0].extractionSource).toBe('claude');
    expect(finalState.periodsStored).toBe(1);
  });
});
