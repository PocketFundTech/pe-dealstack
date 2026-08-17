/**
 * Deal Chat Agent bounds tests — recursion limit + timeout guards.
 *
 * Verifies Task 4.2 fixes:
 *   1. agent.invoke() is called with recursionLimit: 25
 *   2. agent.invoke() is called with a signal (AbortSignal)
 *   3. When the agent never resolves, runDealChatAgent rejects/returns
 *      a timeout error within the configured window.
 *
 * The timeout is shortened via DEAL_CHAT_AGENT_TIMEOUT_MS env var so the
 * test runs in ~100ms instead of 30s.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use a tiny timeout so tests are fast.
process.env.DEAL_CHAT_AGENT_TIMEOUT_MS = '150';

// Capture the config passed to invoke() so we can assert on it.
const invokeSpy = vi.fn();

vi.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: vi.fn(() => ({
    invoke: invokeSpy,
  })),
}));

// LLM module: pretend the LLM is available, return a dummy model.
vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
  getChatModel: () => ({ _llmType: () => 'mock' }),
}));

// Tools module — return an empty toolset.
vi.mock('../src/services/agents/dealChatAgent/tools.js', () => ({
  getDealChatToolsLegacy: () => [],
}));

// Logger — silence.
vi.mock('../src/utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import AFTER mocks so the SUT picks up the mocked modules.
import { runDealChatAgent } from '../src/services/agents/dealChatAgent/index.js';

const baseInput = {
  dealId: 'deal-1',
  orgId: 'org-1',
  message: 'What is EBITDA?',
  dealContext: 'Test deal context',
};

describe('runDealChatAgent — bounds', () => {
  beforeEach(() => {
    invokeSpy.mockReset();
  });

  it('passes recursionLimit: 25 as config to agent.invoke()', async () => {
    invokeSpy.mockResolvedValueOnce({
      messages: [
        // Minimal AI message so the result extractor finds something.
        { _getType: () => 'ai', content: 'Hello world' },
      ],
    });

    await runDealChatAgent(baseInput);

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const [, config] = invokeSpy.mock.calls[0];
    expect(config).toBeDefined();
    expect(config.recursionLimit).toBe(25);
  });

  it('passes an AbortSignal as config to agent.invoke()', async () => {
    invokeSpy.mockResolvedValueOnce({
      messages: [{ _getType: () => 'ai', content: 'Hi' }],
    });

    await runDealChatAgent(baseInput);

    const [, config] = invokeSpy.mock.calls[0];
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('completes a fast (resolved) invoke without timing out', async () => {
    invokeSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                messages: [{ _getType: () => 'ai', content: 'fast reply' }],
              }),
            50
          )
        )
    );

    const result = await runDealChatAgent(baseInput);
    expect(result.response).toBe('fast reply');
    expect(result.model).not.toBe('error');
  });

  it('returns a timeout error when agent.invoke() never resolves', async () => {
    // Honor abort: if the SUT aborts the signal, reject with an AbortError so
    // the timeout-shaped error message is preserved by the catch block. Otherwise
    // never resolve and let the Promise.race timer trip the rejection.
    invokeSpy.mockImplementationOnce(
      (_input: unknown, config: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (config?.signal) {
            config.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              (err as any).name = 'AbortError';
              reject(err);
            });
          }
          // Otherwise — never resolve.
        })
    );

    const start = Date.now();
    const result = await runDealChatAgent(baseInput);
    const elapsed = Date.now() - start;

    // The agent's catch block converts the timeout to a user message.
    // We don't care about the exact wording — only that it's recognizable
    // as a timeout/abort and that the model is 'error'.
    expect(result.model).toBe('error');
    expect(result.response).toMatch(/timed out|timeout|aborted|abort/i);

    // Should resolve close to the configured 150ms window, not the 30s default.
    expect(elapsed).toBeLessThan(2_000);
  });
});
