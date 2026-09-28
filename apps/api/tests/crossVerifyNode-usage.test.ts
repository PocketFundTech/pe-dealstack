/**
 * crossVerifyNode usage-recording (usage-cost-accuracy): LangChain's
 * ChatAnthropic usage_metadata.input_tokens INCLUDES cache tokens, unlike
 * the raw Anthropic SDK. recordUsageEvent's promptTokens must stay
 * UNCACHED-only (see trackedLLM.ts / llm.ts makeUsageHandler for the same
 * split) or a cached cross-verify call over-bills its cached tokens at full
 * input price.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifiedStatement } from '../src/services/financialClassifier.js';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/services/usage/enforcement.js', () => ({ enforceUserGate: vi.fn(async () => {}) }));
vi.mock('../src/services/aiCircuitBreaker.js', () => ({
  withCircuitBreaker: (_p: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../src/services/anthropic.js', () => ({
  isClaudeEnabled: () => true,
  getChatAnthropicAuthFields: () => ({ apiKey: 'sk-ant-test' }),
}));

const recordUsageEvent = vi.fn(async () => {});
vi.mock('../src/services/usage/trackedLLM.js', () => ({ recordUsageEvent }));

let nextInvokeResult: any;
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class ChatAnthropic {
    constructor(_cfg: any) {}
    async invoke() { return nextInvokeResult; }
  },
}));

function statement(field: string, value: number): ClassifiedStatement {
  return {
    statementType: 'INCOME_STATEMENT',
    unitScale: 'MILLIONS',
    currency: 'USD',
    periods: [{ period: 'FY2025', lineItems: { [field]: value } }],
  } as unknown as ClassifiedStatement;
}

beforeEach(() => {
  recordUsageEvent.mockClear();
});

describe('crossVerifyNode — cache-token split on usage recording', () => {
  it('subtracts cache_read + cache_creation from input_tokens and forwards them separately', async () => {
    nextInvokeResult = {
      text: JSON.stringify([
        { field: 'revenue', primary_value: 100, verified: true, your_value: 100, issue: null, confidence: 95 },
      ]),
      usage_metadata: {
        input_tokens: 5000, // LangChain: INCLUDES cache tokens
        output_tokens: 150,
        input_token_details: { cache_read: 4000, cache_creation: 500 },
      },
      response_metadata: { model: 'claude-haiku-4-5-20251001' },
    };
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    await crossVerifyNode({
      statements: [statement('revenue', 100)],
      rawText: 'Revenue was $100M in FY2025.',
    } as any);

    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    const call = recordUsageEvent.mock.calls[0][0] as any;
    expect(call.promptTokens).toBe(500); // 5000 - 4000 - 500
    expect(call.completionTokens).toBe(150);
    expect(call.cacheReadTokens).toBe(4000);
    expect(call.cacheWrite5mTokens).toBe(500);
    expect(call.status).toBe('success');
  });

  it('records the served model from response_metadata when present', async () => {
    nextInvokeResult = {
      text: '[]',
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
      response_metadata: { model: 'claude-haiku-4-5-20251015' },
    };
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    await crossVerifyNode({
      statements: [statement('revenue', 100)],
      rawText: 'Revenue was $100M in FY2025.',
    } as any);

    expect(recordUsageEvent.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251015');
  });

  it('falls back to the hardcoded model label when response_metadata has none', async () => {
    nextInvokeResult = {
      text: '[]',
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
    };
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    await crossVerifyNode({
      statements: [statement('revenue', 100)],
      rawText: 'Revenue was $100M in FY2025.',
    } as any);

    expect(recordUsageEvent.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('never produces a negative promptTokens', async () => {
    nextInvokeResult = {
      text: '[]',
      usage_metadata: { input_tokens: 20, output_tokens: 5, input_token_details: { cache_read: 15, cache_creation: 15 } },
    };
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    await crossVerifyNode({
      statements: [statement('revenue', 100)],
      rawText: 'Revenue was $100M in FY2025.',
    } as any);

    expect(recordUsageEvent.mock.calls[0][0].promptTokens).toBe(0);
  });
});
