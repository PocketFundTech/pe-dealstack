/**
 * Provider selection is read ONCE at module load, so these tests re-import
 * the module per case with different env.
 *
 * Why this exists: fastProvider was hardcoded to default to 'openai'.
 * Clearing LLM_FAST_PROVIDER therefore routed every tier-3/4 call
 * (classification, sentiment, quick summaries) back to OpenAI — the
 * provider this product is migrating off, whose account sat at zero
 * credits in production on 2026-08-18. chatProvider already had the
 * Anthropic-first cascade; fast now matches it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ENV_KEYS = ['LLM_CHAT_PROVIDER', 'LLM_FAST_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Empty string, not delete: the module calls dotenv.config() on import,
  // and dotenv only fills vars that are UNSET — an empty value stays empty
  // and is falsy for isAnthropicEnabled()'s !! check.
  for (const k of ENV_KEYS) process.env[k] = '';
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function loadConfig() {
  const mod = await import('../src/services/llm.js');
  return mod.getLLMConfig?.() ?? null;
}

describe('LLM provider defaults', () => {
  it('defaults BOTH chat and fast to anthropic when only ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const cfg = await loadConfig();
    expect(cfg?.chatProvider).toBe('anthropic');
    expect(cfg?.fastProvider).toBe('anthropic');
  });

  it('falls back to openai for both when no Anthropic key is present', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const cfg = await loadConfig();
    expect(cfg?.chatProvider).toBe('openai');
    expect(cfg?.fastProvider).toBe('openai');
  });

  it('lets explicit env overrides win over the cascade', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.LLM_CHAT_PROVIDER = 'openai';
    process.env.LLM_FAST_PROVIDER = 'openai';
    const cfg = await loadConfig();
    expect(cfg?.chatProvider).toBe('openai');
    expect(cfg?.fastProvider).toBe('openai');
  });
});
