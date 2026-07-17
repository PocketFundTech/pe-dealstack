/**
 * AI role → model map tests (Phase 1 AI core swap).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['AI_EXTRACTION_MODEL', 'AI_CHAT_MODEL', 'AI_FAST_MODEL'] as const;
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
});
