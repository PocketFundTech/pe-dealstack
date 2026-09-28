/**
 * The founder can only add env vars to Vercel with an arbitrary name (secret
 * writes are blocked for automation — see gotcha_vercel_project_move_env_and_lockfile
 * memory). On 2026-09-28 a new Anthropic key was added as `Antropic_api_avise`
 * (a name no code reads) instead of `ANTHROPIC_API_KEY`. Rather than requiring
 * a rename every time this happens, this module aliases known "wrong name"
 * env vars onto the name the app actually reads, as a side effect of import —
 * it must run before any module that captures process.env.ANTHROPIC_API_KEY
 * into a top-level const (anthropic.ts, ai/client.ts's Anthropic() call,
 * which defaults to reading it internally, etc).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('anthropicKeyAlias', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.Antropic_api_avise;
    // The module runs its aliasing as an import side effect, once per module
    // instance — force a fresh evaluation for every test.
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('copies Antropic_api_avise onto ANTHROPIC_API_KEY when the real name is unset', async () => {
    process.env.Antropic_api_avise = 'sk-ant-fresh-key-value';
    await import('../src/utils/anthropicKeyAlias.js');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-fresh-key-value');
  });

  it('prefers Antropic_api_avise over an existing (possibly drained) ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-old-drained-key';
    process.env.Antropic_api_avise = 'sk-ant-fresh-key-value';
    await import('../src/utils/anthropicKeyAlias.js');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-fresh-key-value');
  });

  it('leaves ANTHROPIC_API_KEY untouched when Antropic_api_avise is not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-old-drained-key';
    await import('../src/utils/anthropicKeyAlias.js');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-old-drained-key');
  });

  it('does nothing when neither var is set', async () => {
    await import('../src/utils/anthropicKeyAlias.js');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
