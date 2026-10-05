/**
 * Two prod-log-driven fixes to the financial agent's bounds:
 *  1. FINANCIAL_AGENT_TIMEOUT_MS default raised from 120_000 to 240_000 to
 *     match the route's PER_DOC_BUDGET_MS (financials-extraction.ts) — the
 *     agent was losing the race against its own per-doc budget, so every
 *     large CIM/XLSX pair failed with "Financial agent timed out after
 *     120000ms" well before the 240s budget the route allows it.
 *  2. The AbortSignal runWithAgentBounds() constructs on timeout was never
 *     threaded into extractNode → claudeEngine → trackedClaudeMessage, so
 *     an aborted run kept calling the paid Anthropic API in the background
 *     after the route had already given up on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runWithAgentBoundsMock = vi.fn(async (invoker: any, opts: any) => {
  // Capture what index.ts asked for without actually racing a timer.
  return invoker({ recursionLimit: opts.recursionLimit ?? 10, signal: new AbortController().signal });
});

vi.mock('../src/services/agents/agentBounds.js', () => ({
  runWithAgentBounds: (...args: any[]) => runWithAgentBoundsMock(...(args as [any, any])),
}));

const graphInvoke = vi.fn(async () => ({
  status: 'completed',
  statementIds: [],
  periodsStored: 0,
  hasConflicts: false,
  overallConfidence: 0,
  extractionSource: 'gpt4o',
  validationResult: null,
  retryCount: 0,
  warnings: [],
  error: null,
  steps: [],
  crossVerifyResult: null,
}));

vi.mock('../src/services/agents/financialAgent/graph.js', () => ({
  getFinancialAgentGraph: () => ({ invoke: graphInvoke }),
}));

describe('runFinancialAgent — timeout default', () => {
  beforeEach(() => {
    runWithAgentBoundsMock.mockClear();
    graphInvoke.mockClear();
    delete process.env.FINANCIAL_AGENT_TIMEOUT_MS;
  });

  it('defaults FINANCIAL_AGENT_TIMEOUT_MS to 240_000 (matches route PER_DOC_BUDGET_MS), not 120_000', async () => {
    const { runFinancialAgent } = await import('../src/services/agents/financialAgent/index.js');
    await runFinancialAgent({
      dealId: 'deal-1',
      fileBuffer: Buffer.from('x'),
      fileName: 'CIM.pdf',
      fileType: 'pdf' as const,
    });

    expect(runWithAgentBoundsMock).toHaveBeenCalledTimes(1);
    const opts = runWithAgentBoundsMock.mock.calls[0][1];
    expect(opts.timeoutMs).toBe(240_000);
    expect(opts.envVar).toBe('FINANCIAL_AGENT_TIMEOUT_MS');
  });
});

describe('extractNode — AbortSignal plumbing to claudeEngine', () => {
  it('passes the LangGraph node config.signal through to extractWithClaude', async () => {
    vi.resetModules();
    const engineCalls: any[] = [];
    vi.doMock('../src/services/extraction/claudeEngine.js', () => ({
      extractWithClaude: vi.fn(async (input: any, signal: any) => {
        engineCalls.push({ input, signal });
        return {
          classification: { statements: [], overallConfidence: 0, warnings: [] },
          rawText: '[claude-native-pdf] test.pdf',
          repairUsed: false,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    }));
    vi.doMock('../src/services/agents/financialAgent/extractionCache.js', () => ({
      hashContent: vi.fn(() => 'hash'),
      getCachedExtraction: vi.fn(async () => null),
      putCachedExtraction: vi.fn(async () => undefined),
    }));
    process.env.EXTRACTION_ENGINE = 'claude';

    const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
    const controller = new AbortController();
    await extractNode(
      { fileBuffer: Buffer.from('%PDF-fake'), fileName: 'test.pdf', fileType: 'pdf', forceExtraction: true } as any,
      { signal: controller.signal } as any,
    );

    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].signal).toBe(controller.signal);

    delete process.env.EXTRACTION_ENGINE;
    vi.doUnmock('../src/services/extraction/claudeEngine.js');
    vi.doUnmock('../src/services/agents/financialAgent/extractionCache.js');
  });
});
