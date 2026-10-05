/**
 * AI role → model map tests (Phase 1 AI core swap).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['AI_EXTRACTION_MODEL', 'AI_CHAT_MODEL', 'AI_FAST_MODEL', 'AI_MEMO_MODEL', 'AI_INGEST_MODEL', 'AI_CHAT_EFFORT', 'AI_MEMO_EFFORT'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function getModels() {
  return await import('../src/services/ai/models.js');
}

describe('getModelConfig', () => {
  it('defaults extraction to claude-fable-5 with refusal fallback to opus 4.8', async () => {
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('extraction');
    expect(cfg.model).toBe('claude-fable-5');
    expect(cfg.betas).toContain('server-side-fallback-2026-06-01');
    expect(cfg.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
  });

  it('defaults chat to sonnet 5 and fast to haiku 4.5, with no fallback plumbing', async () => {
    const { getModelConfig } = await getModels();
    expect(getModelConfig('chat').model).toBe('claude-sonnet-5');
    expect(getModelConfig('fast').model).toBe('claude-haiku-4-5');
    expect(getModelConfig('chat').fallbacks).toBeUndefined();
    expect(getModelConfig('chat').betas).toEqual([]);
  });

  it('honors env overrides and drops fable-only plumbing when downgraded', async () => {
    process.env.AI_EXTRACTION_MODEL = 'claude-opus-4-8';
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('extraction');
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.fallbacks).toBeUndefined();
    expect(cfg.betas).toEqual([]);
  });

  it('honors chat and fast env overrides too', async () => {
    process.env.AI_CHAT_MODEL = 'claude-sonnet-4-6';
    process.env.AI_FAST_MODEL = 'claude-sonnet-5';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('chat').model).toBe('claude-sonnet-4-6');
    expect(getModelConfig('fast').model).toBe('claude-sonnet-5');
  });

  it('treats an empty-string env override as unset', async () => {
    process.env.AI_EXTRACTION_MODEL = '';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('extraction').model).toBe('claude-fable-5');
  });

  it('keys fable plumbing off the resolved model, not the role', async () => {
    process.env.AI_CHAT_MODEL = 'claude-fable-5';
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('chat');
    expect(cfg.betas).toContain('server-side-fallback-2026-06-01');
    expect(cfg.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    expect(cfg.maxTokens).toBe(16000); // maxTokens stays role-specific
  });

  it('defaults memo to sonnet 5 with 4000 max tokens and no fallback plumbing', async () => {
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('memo');
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.maxTokens).toBe(4000);
    expect(cfg.fallbacks).toBeUndefined();
    expect(cfg.betas).toEqual([]);
  });

  it('honors the memo env override', async () => {
    process.env.AI_MEMO_MODEL = 'claude-opus-4-8';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('memo').model).toBe('claude-opus-4-8');
  });

  it('defaults ingest (deal-summary read) to sonnet 5, not fable, with no fallback plumbing', async () => {
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('ingest');
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.maxTokens).toBe(16000);
    expect(cfg.fallbacks).toBeUndefined();
    expect(cfg.betas).toEqual([]);
  });

  it('honors the ingest env override', async () => {
    process.env.AI_INGEST_MODEL = 'claude-fable-5';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('ingest').model).toBe('claude-fable-5');
  });

  it('runs chat and memo drafting at medium effort by default; other roles keep the model default', async () => {
    const { getModelConfig } = await getModels();
    expect(getModelConfig('chat').effort).toBe('medium');
    expect(getModelConfig('memo').effort).toBe('medium');
    process.env.AI_MEMO_EFFORT = 'high';
    expect(getModelConfig('memo').effort).toBe('high');
    expect(getModelConfig('extraction').effort).toBeUndefined();
    expect(getModelConfig('ingest').effort).toBeUndefined();
    expect(getModelConfig('fast').effort).toBeUndefined();
  });

  it('honors AI_CHAT_EFFORT and ignores invalid values', async () => {
    const { getModelConfig } = await getModels();
    process.env.AI_CHAT_EFFORT = 'high';
    expect(getModelConfig('chat').effort).toBe('high');
    process.env.AI_CHAT_EFFORT = 'turbo';
    expect(getModelConfig('chat').effort).toBe('medium');
  });

  it('never sends effort to Haiku 4.5, which rejects it', async () => {
    process.env.AI_CHAT_MODEL = 'claude-haiku-4-5';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('chat').effort).toBeUndefined();
  });
});
