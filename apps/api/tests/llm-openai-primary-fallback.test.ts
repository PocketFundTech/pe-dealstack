/**
 * When ANTHROPIC_API_KEY is absent the primary provider is OpenAI. If the
 * operator has ANTHROPIC_API_KEY_FALLBACK configured, a quota / auth /
 * rate-limit rejection from OpenAI must fall through to that key instead
 * of failing the request. (Prod 2026-09-19: new Vercel project had only
 * OPENAI_API_KEY + ANTHROPIC_API_KEY_FALLBACK; OpenAI was out of credit;
 * the fallback key was never consulted because the chain was only built
 * for an Anthropic primary.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: () => ({}) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/usage/enforcement.js', () => ({
  enforceUserGate: async () => {},
  UserBlockedError: class UserBlockedError extends Error {},
}));
vi.mock('../src/services/usage/trackedLLM.js', () => ({ recordUsageEvent: async () => {} }));
vi.mock('../src/services/aiCircuitBreaker.js', () => ({
  withCircuitBreaker: (_p: string, fn: () => Promise<unknown>) => fn(),
}));

const quotaError = Object.assign(new Error('429 You have no credits remaining.'), {
  status: 429,
  code: 'credit_balance_exhausted',
  error: { type: 'insufficient_quota' },
});

const anthropicCtorArgs: any[] = [];
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class ChatOpenAI {
    constructor(_cfg: any) {}
    async invoke() { throw quotaError; }
  },
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class ChatAnthropic {
    constructor(cfg: any) { anthropicCtorArgs.push(cfg); }
    async invoke() { return 'FROM_ANTHROPIC_FALLBACK'; }
  },
}));
vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class ChatGoogleGenerativeAI { constructor(_cfg: any) {} },
}));

async function loadLLM(env: Record<string, string | undefined>) {
  vi.resetModules();
  anthropicCtorArgs.length = 0;
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FALLBACK', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'LLM_CHAT_PROVIDER', 'LLM_CHAT_MODEL']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import('../src/services/llm.js');
}

describe('OpenAI-primary → Anthropic fallback key', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getExtractionModel falls through to ANTHROPIC_API_KEY_FALLBACK when OpenAI rejects for quota', async () => {
    const llm = await loadLLM({ OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY_FALLBACK: 'sk-ant-fallback' });
    const model = llm.getExtractionModel(3000, 'financial_extraction');
    await expect(model.invoke('hi' as any)).resolves.toBe('FROM_ANTHROPIC_FALLBACK');
    expect(anthropicCtorArgs[0]?.apiKey).toBe('sk-ant-fallback');
  });

  it('getChatModel does the same', async () => {
    const llm = await loadLLM({ OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY_FALLBACK: 'sk-ant-fallback' });
    const model = llm.getChatModel(0.7, 1500, 'deal_chat');
    await expect(model.invoke('hi' as any)).resolves.toBe('FROM_ANTHROPIC_FALLBACK');
  });

  it('without a fallback key the OpenAI rejection is surfaced unchanged', async () => {
    const llm = await loadLLM({ OPENAI_API_KEY: 'sk-openai' });
    const model = llm.getExtractionModel(3000, 'financial_extraction');
    await expect(model.invoke('hi' as any)).rejects.toBe(quotaError);
    expect(anthropicCtorArgs).toHaveLength(0);
  });
});
