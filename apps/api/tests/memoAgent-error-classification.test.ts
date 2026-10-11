/**
 * QA 2026-10-11 (AI Reports deep test, finding B): sending a chat message
 * in the "AI Analyst" panel while Anthropic was out of credit showed
 * "AI API key is invalid or missing. Please check your configuration." —
 * confirmed live on app.avise.io. The real cause is credit exhaustion, not
 * an invalid key: runMemoChatAgent's catch block classified the error with
 * the legacy classifyAIError(message), which has no awareness of
 * Anthropic's "credit balance is too low" wording (see aiErrors.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

const invokeSpy = vi.fn();

vi.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: vi.fn(() => ({ invoke: invokeSpy })),
}));

vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
  getChatModel: () => ({ _llmType: () => 'mock' }),
}));

vi.mock('../src/services/agents/memoAgent/tools.js', () => ({
  getMemoAgentTools: () => [],
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: vi.fn(),
}));

const ANTHROPIC_CREDIT_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

describe('runMemoChatAgent — error classification (AI Analyst chat)', () => {
  it('reports Anthropic credit exhaustion as exhausted credits, never as an invalid/missing API key', async () => {
    invokeSpy.mockRejectedValue({
      status: 400,
      error: { type: 'invalid_request_error', message: ANTHROPIC_CREDIT_MESSAGE },
      message: `400 ${ANTHROPIC_CREDIT_MESSAGE}`,
    });

    const { runMemoChatAgent } = await import('../src/services/agents/memoAgent/index.js');
    const result = await runMemoChatAgent({
      memoId: 'memo-1', dealId: 'deal-1', orgId: 'org-1', message: 'Add an EBITDA bridge analysis',
    });

    expect(result.message).not.toMatch(/api key/i);
    expect(result.message).toMatch(/credit/i);
  });
});
