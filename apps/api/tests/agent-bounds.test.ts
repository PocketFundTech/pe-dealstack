/**
 * Agent bounds tests — recursion limit + timeout guards across every
 * LangGraph agent in apps/api/src/services/agents/.
 *
 * For each agent we verify (Task 4.3):
 *   1. The underlying graph.invoke() / agent.invoke() is called with a
 *      `recursionLimit` config value.
 *   2. That same call gets an `AbortSignal` so the in-flight HTTP request
 *      to OpenAI can be cancelled by the timeout.
 *
 * We don't separately test "timeout actually fires" for every agent —
 * one representative test (dealChatAgent-bounds.test.ts) already covers
 * the end-to-end behavior. The whitebox assertions here are the main
 * coverage and run in ~10ms each.
 *
 * Per-agent timeouts are compressed via env vars so even a malformed
 * mock that never resolves cannot stall this suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Compress all per-agent timeouts so the safety net never blows up the suite.
process.env.FINANCIAL_AGENT_TIMEOUT_MS = '500';
process.env.FIRM_RESEARCH_AGENT_TIMEOUT_MS = '500';
process.env.MEMO_CHAT_AGENT_TIMEOUT_MS = '500';
process.env.CONTACT_ENRICHMENT_TIMEOUT_MS = '500';
process.env.EMAIL_DRAFTER_TIMEOUT_MS = '500';
process.env.SIGNAL_MONITOR_TIMEOUT_MS = '500';

// ─── Shared mocks ────────────────────────────────────────────────────

vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
  getChatModel: () => ({ _llmType: () => 'mock' }),
  invokeStructured: vi.fn(async () => ({})),
}));

vi.mock('../src/utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Reuse one spy per graph so tests can assert what config was passed.
const financialInvoke = vi.fn();
const firmResearchInvoke = vi.fn();
const contactEnrichmentInvoke = vi.fn();
const emailDrafterInvoke = vi.fn();
const signalMonitorInvoke = vi.fn();
const memoChatInvoke = vi.fn();

// ─── Mock per-agent graph factories ──────────────────────────────────

vi.mock('../src/services/agents/financialAgent/graph.js', () => ({
  getFinancialAgentGraph: () => ({ invoke: financialInvoke }),
}));

vi.mock('../src/services/agents/firmResearchAgent/graph.js', () => ({
  getFirmResearchGraph: () => ({ invoke: firmResearchInvoke }),
}));

vi.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: vi.fn(() => ({ invoke: memoChatInvoke })),
}));

// Mock the compiled graphs in contactEnrichment / emailDrafter / signalMonitor.
// They use StateGraph(...).compile() at module top-level, so we mock that.
vi.mock('@langchain/langgraph', async () => {
  // Lazy-import to avoid breaking other consumers; we provide just enough.
  return {
    StateGraph: class MockStateGraph {
      addNode() { return this; }
      addEdge() { return this; }
      addConditionalEdges() { return this; }
      compile() { return { invoke: globalThis.__mockGraphInvoke ?? (() => ({})) }; }
    },
    Annotation: Object.assign(
      function MockAnnotation() {},
      {
        Root: (spec: unknown) => spec,
      },
    ),
    START: '__START__',
    END: '__END__',
  };
});

// Each suite below swaps in its own invoke spy via this global before
// importing the SUT.
declare global {
  var __mockGraphInvoke: ((...args: unknown[]) => unknown) | undefined;
}

// Tools must mock cleanly since memoAgent and contactEnrichment import them.
vi.mock('../src/services/agents/memoAgent/tools.js', () => ({
  getMemoAgentTools: () => [],
}));
vi.mock('../src/services/agents/contactEnrichment/nodes.js', () => ({
  gatherNode: vi.fn(),
  researchNode: vi.fn(),
  validateNode: vi.fn(),
  saveNode: vi.fn(),
  reviewNode: vi.fn(),
  routeAfterValidation: vi.fn(() => 'save'),
}));

// supabase mock — needed by emailDrafter and signalMonitor.
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
          neq: () => ({
            neq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [] }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────

function assertBoundsConfig(call: unknown[], { recursionLimit }: { recursionLimit?: number } = {}) {
  // graph.invoke(input, config) — config is the second arg.
  const config = call[1] as { recursionLimit?: number; signal?: AbortSignal };
  expect(config).toBeDefined();
  expect(typeof config.recursionLimit).toBe('number');
  expect(config.recursionLimit).toBeGreaterThan(0);
  if (recursionLimit !== undefined) {
    expect(config.recursionLimit).toBe(recursionLimit);
  }
  expect(config.signal).toBeInstanceOf(AbortSignal);
}

// ─── financialAgent ──────────────────────────────────────────────────

describe('runFinancialAgent — bounds', () => {
  beforeEach(() => {
    financialInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to graph.invoke()', async () => {
    financialInvoke.mockResolvedValueOnce({
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
    });

    const { runFinancialAgent } = await import('../src/services/agents/financialAgent/index.js');
    await runFinancialAgent({
      dealId: 'deal-1',
      fileBuffer: Buffer.from('x'),
      fileName: 'CIM.pdf',
      fileType: 'pdf' as const,
    });

    expect(financialInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(financialInvoke.mock.calls[0], { recursionLimit: 25 });
  });
});

// ─── firmResearchAgent ───────────────────────────────────────────────

describe('runFirmResearch — bounds', () => {
  beforeEach(() => {
    firmResearchInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to graph.invoke()', async () => {
    firmResearchInvoke.mockResolvedValueOnce({
      status: 'complete',
      firmProfile: null,
      personProfile: null,
      sources: [],
      steps: [],
      error: null,
    });

    const { runFirmResearch } = await import('../src/services/agents/firmResearchAgent/index.js');
    await runFirmResearch({
      websiteUrl: 'https://example.com',
      linkedinUrl: 'https://linkedin.com/in/x',
      firmName: 'Example PE',
      userId: 'user-1',
      organizationId: 'org-bounds-firm', // unique org-id to dodge the runningEnrichments lock
    });

    expect(firmResearchInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(firmResearchInvoke.mock.calls[0], { recursionLimit: 15 });
  });
});

// ─── memoAgent (chat ReAct) ──────────────────────────────────────────

describe('runMemoChatAgent — bounds', () => {
  beforeEach(() => {
    memoChatInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to agent.invoke()', async () => {
    memoChatInvoke.mockResolvedValueOnce({
      messages: [{ _getType: () => 'ai', content: 'ok' }],
    });

    const { runMemoChatAgent } = await import('../src/services/agents/memoAgent/index.js');
    await runMemoChatAgent({
      memoId: 'memo-1',
      dealId: 'deal-1',
      orgId: 'org-1',
      message: 'Summarize the deal',
    });

    expect(memoChatInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(memoChatInvoke.mock.calls[0], { recursionLimit: 10 });
  });
});

// ─── contactEnrichment / emailDrafter / signalMonitor ─────────────────
// These three use StateGraph(...).compile() at module top level. We rely
// on the StateGraph mock above, swapping in a per-test invoke spy.

describe('runContactEnrichment — bounds', () => {
  beforeEach(() => {
    contactEnrichmentInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to compiledGraph.invoke()', async () => {
    contactEnrichmentInvoke.mockResolvedValueOnce({
      status: 'completed',
      enrichedData: {},
      confidence: 0,
      needsReview: false,
      sources: [],
      steps: [],
      error: null,
    });
    globalThis.__mockGraphInvoke = contactEnrichmentInvoke;

    // Reset module so the top-level compile() picks up our spy.
    vi.resetModules();
    const { runContactEnrichment } = await import('../src/services/agents/contactEnrichment/index.js');
    await runContactEnrichment({
      contactId: 'c-1',
      organizationId: 'org-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(contactEnrichmentInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(contactEnrichmentInvoke.mock.calls[0], { recursionLimit: 10 });
  });
});

describe('generateEmailDraft — bounds', () => {
  beforeEach(() => {
    emailDrafterInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to compiledGraph.invoke()', async () => {
    emailDrafterInvoke.mockResolvedValueOnce({
      status: 'ready_for_review',
      subject: 'Hi',
      draft: '',
      finalDraft: '',
      toneScore: 90,
      toneNotes: [],
      complianceIssues: [],
      isCompliant: true,
      suggestions: [],
    });
    globalThis.__mockGraphInvoke = emailDrafterInvoke;

    vi.resetModules();
    const { generateEmailDraft } = await import('../src/services/agents/emailDrafter/index.js');
    await generateEmailDraft({
      organizationId: 'org-1',
      purpose: 'Initial outreach',
    });

    expect(emailDrafterInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(emailDrafterInvoke.mock.calls[0], { recursionLimit: 10 });
  });
});

describe('runSignalMonitor — bounds', () => {
  beforeEach(() => {
    signalMonitorInvoke.mockReset();
  });

  it('passes recursionLimit + AbortSignal to compiledGraph.invoke()', async () => {
    signalMonitorInvoke.mockResolvedValueOnce({
      status: 'completed',
      signals: [],
      processedCount: 0,
      error: null,
    });
    globalThis.__mockGraphInvoke = signalMonitorInvoke;

    vi.resetModules();
    const { runSignalMonitor } = await import('../src/services/agents/signalMonitor/index.js');
    await runSignalMonitor('org-1');

    expect(signalMonitorInvoke).toHaveBeenCalledTimes(1);
    assertBoundsConfig(signalMonitorInvoke.mock.calls[0], { recursionLimit: 10 });
  });
});

// ─── Representative timeout test (one is enough) ─────────────────────

describe('agent bounds — representative timeout', () => {
  beforeEach(() => {
    financialInvoke.mockReset();
  });

  it('rejects within the bounded window when invoke() never resolves', async () => {
    // Honor abort: if the SUT aborts the signal, reject with an AbortError.
    financialInvoke.mockImplementationOnce(
      (_input: unknown, config: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (config?.signal) {
            config.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              (err as any).name = 'AbortError';
              reject(err);
            });
          }
        })
    );

    vi.resetModules();
    const { runFinancialAgent } = await import('../src/services/agents/financialAgent/index.js');

    const start = Date.now();
    const result = await runFinancialAgent({
      dealId: 'deal-timeout',
      fileBuffer: Buffer.from('x'),
      fileName: 'big.pdf',
      fileType: 'pdf' as const,
    });
    const elapsed = Date.now() - start;

    // FINANCIAL_AGENT_TIMEOUT_MS=500 in this suite. Expect resolution well
    // before 5s; our catch block converts the timeout to status: 'failed'.
    expect(elapsed).toBeLessThan(3_000);
    expect(result.status).toBe('failed');
    expect(result.error || '').toMatch(/timed out|timeout|aborted|abort/i);
  });
});
