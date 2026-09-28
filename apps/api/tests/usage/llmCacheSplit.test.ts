/**
 * makeUsageHandler() cache-token split (usage-cost-accuracy).
 *
 * LangChain's ChatAnthropic `usage_metadata.input_tokens` INCLUDES cache
 * tokens (buildUsageMetadata in @langchain/anthropic adds
 * cache_creation_input_tokens + cache_read_input_tokens onto the raw
 * input_tokens), unlike the raw Anthropic SDK where `usage.input_tokens`
 * EXCLUDES them. recordUsageEvent's `promptTokens` must be UNCACHED-only
 * (see trackedLLM.ts docblock) or a cached call double-bills its cached
 * tokens at full price. This test captures the callback handler
 * getChatModel() constructs and drives it directly with a LangChain-shaped
 * usage_metadata payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: () => ({}) } }));
vi.mock('../../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/usage/enforcement.js', () => ({
  enforceUserGate: async () => {},
  UserBlockedError: class UserBlockedError extends Error {},
}));
const recordUsageEvent = vi.fn(async () => {});
vi.mock('../../src/services/usage/trackedLLM.js', () => ({ recordUsageEvent }));
vi.mock('../../src/services/aiCircuitBreaker.js', () => ({
  withCircuitBreaker: (_p: string, fn: () => Promise<unknown>) => fn(),
}));

const anthropicCtorArgs: any[] = [];
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class ChatAnthropic {
    constructor(cfg: any) { anthropicCtorArgs.push(cfg); }
    invoke = vi.fn();
    bindTools = undefined;
  },
}));
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class ChatOpenAI { constructor(_cfg: any) {} },
}));
vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class ChatGoogleGenerativeAI { constructor(_cfg: any) {} },
}));

async function loadLLM() {
  vi.resetModules();
  anthropicCtorArgs.length = 0;
  recordUsageEvent.mockClear();
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FALLBACK', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'LLM_CHAT_PROVIDER', 'LLM_CHAT_MODEL']) {
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  return import('../../src/services/llm.js');
}

beforeEach(async () => {
  await loadLLM();
});

function getUsageHandler() {
  const cfg = anthropicCtorArgs.at(-1);
  const handler = cfg?.callbacks?.[0];
  expect(handler).toBeTruthy();
  return handler;
}

describe('makeUsageHandler — Anthropic cache-token split', () => {
  it('subtracts cache_read + cache_creation from input_tokens for promptTokens, and forwards them separately', async () => {
    const llm = await loadLLM();
    llm.getChatModel(0.7, 1500, 'deal_chat');
    const handler = getUsageHandler();

    await handler.handleLLMEnd({
      generations: [[{
        message: {
          usage_metadata: {
            input_tokens: 1000, // LangChain: INCLUDES cache tokens
            output_tokens: 200,
            input_token_details: { cache_read: 700, cache_creation: 100 },
          },
          response_metadata: { model: 'claude-sonnet-4-6', model_provider: 'anthropic' },
        },
      }]],
    });

    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    const call = recordUsageEvent.mock.calls[0][0];
    expect(call.promptTokens).toBe(200); // 1000 - 700 - 100
    expect(call.cacheReadTokens).toBe(700);
    expect(call.cacheWrite5mTokens).toBe(100);
    expect(call.completionTokens).toBe(200);
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('never produces a negative promptTokens', async () => {
    const llm = await loadLLM();
    llm.getChatModel(0.7, 1500, 'deal_chat');
    const handler = getUsageHandler();

    await handler.handleLLMEnd({
      generations: [[{
        message: {
          // Malformed/unexpected shape where cache counts exceed input_tokens
          usage_metadata: {
            input_tokens: 50,
            output_tokens: 10,
            input_token_details: { cache_read: 40, cache_creation: 40 },
          },
        },
      }]],
    });

    expect(recordUsageEvent.mock.calls[0][0].promptTokens).toBe(0);
  });

  it('falls back to the configured model name when no served model is present', async () => {
    const llm = await loadLLM();
    llm.getChatModel(0.7, 1500, 'deal_chat');
    const handler = getUsageHandler();

    await handler.handleLLMEnd({
      generations: [[{ message: { usage_metadata: { input_tokens: 10, output_tokens: 5 } } }]],
    });

    expect(recordUsageEvent.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(recordUsageEvent.mock.calls[0][0].cacheReadTokens).toBe(0);
    expect(recordUsageEvent.mock.calls[0][0].cacheWrite5mTokens).toBe(0);
  });

  it('handles a call with no cache usage at all (plain, uncached request)', async () => {
    const llm = await loadLLM();
    llm.getChatModel(0.7, 1500, 'deal_chat');
    const handler = getUsageHandler();

    await handler.handleLLMEnd({
      generations: [[{
        message: { usage_metadata: { input_tokens: 300, output_tokens: 80 } },
      }]],
    });

    expect(recordUsageEvent.mock.calls[0][0]).toMatchObject({
      promptTokens: 300,
      completionTokens: 80,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
    });
  });
});
