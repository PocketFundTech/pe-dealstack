/**
 * Legacy LangChain path model tiering (AI cost plan B1/B2):
 *  - chat / extraction default to claude-sonnet-5 (env overrides still win)
 *  - tier 'simple' resolves to Haiku 4.5 on an Anthropic primary
 *  - Sonnet 5 never receives temperature (400 / local throw) and gets
 *    thinking explicitly disabled (forced tool_choice + small max_tokens)
 *  - the ANTHROPIC_API_KEY_FALLBACK entry uses the same model as the primary
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

const creditError = Object.assign(new Error('Your credit balance is too low'), {
  status: 400,
  error: { type: 'invalid_request_error', error: { message: 'Your credit balance is too low' } },
});

const anthropicCtorArgs: any[] = [];
let primaryShouldFail = false;
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class ChatOpenAI {
    constructor(_cfg: any) {}
    async invoke() { return 'FROM_OPENAI'; }
  },
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class ChatAnthropic {
    cfg: any;
    constructor(cfg: any) { this.cfg = cfg; anthropicCtorArgs.push(cfg); }
    async invoke() {
      if (primaryShouldFail && this.cfg.apiKey !== 'sk-ant-fallback') throw creditError;
      return `FROM_${this.cfg.model}`;
    }
    withStructuredOutput() {
      return { invoke: async () => ({ model: this.cfg.model }) };
    }
  },
}));
vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class ChatGoogleGenerativeAI { constructor(_cfg: any) {} },
}));

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY_FALLBACK', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'LLM_CHAT_PROVIDER', 'LLM_FAST_PROVIDER', 'LLM_CHAT_MODEL', 'LLM_EXTRACTION_MODEL', 'AI_FAST_MODEL',
];

async function loadLLM(env: Record<string, string | undefined>) {
  vi.resetModules();
  anthropicCtorArgs.length = 0;
  primaryShouldFail = false;
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import('../src/services/llm.js');
}

describe('legacy LangChain path — model tiering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getChatModel / getExtractionModel default to claude-sonnet-5', async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
    llm.getChatModel(0.7, 1500, 'deal_chat');
    llm.getExtractionModel(3000, 'deal_extraction');
    expect(anthropicCtorArgs.map((a) => a.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5']);
    expect(llm.getChatModelName()).toBe('claude-sonnet-5');
  });

  it('Sonnet 5 gets no temperature and thinking explicitly disabled', async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
    llm.getChatModel(0.7, 1500, 'deal_chat');
    const cfg = anthropicCtorArgs[0];
    expect('temperature' in cfg).toBe(false);
    expect(cfg.thinking).toEqual({ type: 'disabled' });
    expect(cfg.maxTokens).toBe(1500);
  });

  it('env overrides still win (LLM_CHAT_MODEL, LLM_EXTRACTION_MODEL) and keep temperature on 4.6', async () => {
    const llm = await loadLLM({
      ANTHROPIC_API_KEY: 'sk-ant',
      LLM_CHAT_MODEL: 'claude-sonnet-4-6',
      LLM_EXTRACTION_MODEL: 'claude-sonnet-4-6',
    });
    llm.getChatModel(0.5, 1500, 'deal_chat');
    llm.getExtractionModel(3000, 'deal_extraction');
    expect(anthropicCtorArgs[0]).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0.5 });
    expect(anthropicCtorArgs[0].thinking).toBeUndefined();
    expect(anthropicCtorArgs[1]).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0.1 });
  });

  it("tier 'simple' resolves to claude-haiku-4-5 and keeps temperature", async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
    const model = llm.getChatModel(0.3, 700, 'deal_analysis', { tier: 'simple' });
    expect(anthropicCtorArgs[0]).toMatchObject({ model: 'claude-haiku-4-5', temperature: 0.3, maxTokens: 700 });
    expect(anthropicCtorArgs[0].thinking).toBeUndefined();
    await expect(model.invoke('hi' as any)).resolves.toBe('FROM_claude-haiku-4-5');
  });

  it("tier 'simple' honours AI_FAST_MODEL", async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant', AI_FAST_MODEL: 'claude-sonnet-4-6' });
    llm.getChatModel(0.3, 700, 'deal_analysis', { tier: 'simple' });
    expect(anthropicCtorArgs[0].model).toBe('claude-sonnet-4-6');
  });

  it("invokeStructured tier 'simple' uses Haiku; default uses Sonnet 5", async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
    const { z } = await import('zod');
    const schema = z.object({ model: z.string() });
    await expect(llm.invokeStructured(schema, [], { label: 'emailDrafter.tone', tier: 'simple' }))
      .resolves.toEqual({ model: 'claude-haiku-4-5' });
    await expect(llm.invokeStructured(schema, [], { label: 'emailDrafter.draft' }))
      .resolves.toEqual({ model: 'claude-sonnet-5' });
  });

  it('ANTHROPIC_API_KEY_FALLBACK uses the same model as the primary (Sonnet 5 and Haiku)', async () => {
    const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_API_KEY_FALLBACK: 'sk-ant-fallback' });
    primaryShouldFail = true;
    await expect(llm.getChatModel(0.7, 1500, 'deal_chat').invoke('hi' as any))
      .resolves.toBe('FROM_claude-sonnet-5');
    const fb = anthropicCtorArgs.find((a) => a.apiKey === 'sk-ant-fallback');
    expect(fb.model).toBe('claude-sonnet-5');
    expect('temperature' in fb).toBe(false);

    anthropicCtorArgs.length = 0;
    await expect(llm.getChatModel(0.3, 220, 'contactFollowUpSuggester', { tier: 'simple' }).invoke('hi' as any))
      .resolves.toBe('FROM_claude-haiku-4-5');
    expect(anthropicCtorArgs.find((a) => a.apiKey === 'sk-ant-fallback').model).toBe('claude-haiku-4-5');
  });

  it("tier 'simple' is a no-op on a non-Anthropic primary", async () => {
    const llm = await loadLLM({ OPENAI_API_KEY: 'sk-openai' });
    expect(llm.getChatModelName('simple')).toBe(llm.getChatModelName('chat'));
  });
});

describe('anthropicRequestShape', () => {
  it('drops sampling params for adaptive-only models; disables thinking only where accepted', async () => {
    const { anthropicRequestShape } = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(anthropicRequestShape('claude-sonnet-5', 0.7)).toEqual({ thinking: { type: 'disabled' } });
    expect(anthropicRequestShape('claude-sonnet-4-6', 0.7)).toEqual({ temperature: 0.7 });
    expect(anthropicRequestShape('claude-haiku-4-5', 0.2)).toEqual({ temperature: 0.2 });
    // Fable rejects an explicit disable → send neither.
    expect(anthropicRequestShape('claude-fable-5', 0.7)).toEqual({});
  });

  describe('fast provider default', () => {
    it('is anthropic when only Anthropic keys exist (getFastModel must not throw)', async () => {
      const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant' });
      expect(() => llm.getFastModel(0.2, 300, 'test')).not.toThrow();
      expect(anthropicCtorArgs.length).toBe(1);
    });

    it('stays openai when an OpenAI key is present', async () => {
      const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' });
      llm.getFastModel(0.2, 300, 'test');
      expect(anthropicCtorArgs.length).toBe(0);
    });

    it('LLM_FAST_PROVIDER env override wins', async () => {
      const llm = await loadLLM({ ANTHROPIC_API_KEY: 'sk-ant', LLM_FAST_PROVIDER: 'openai' });
      llm.getFastModel(0.2, 300, 'test');
      expect(anthropicCtorArgs.length).toBe(0);
    });
  });
});
