import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.OAUTH_STATE_SECRET = 'test-secret-do-not-use-in-prod-padding-to-32-chars';
  vi.resetModules();
});

describe('oauth state signing', () => {
  it('signs and verifies state with embedded user/provider/nonce', async () => {
    const { signState, verifyState } = await import(
      '../../src/integrations/_platform/oauth.js'
    );
    const state = signState({
      userId: 'user-1',
      organizationId: 'org-1',
      provider: 'granola',
    });
    expect(typeof state).toBe('string');
    const decoded = verifyState(state);
    expect(decoded.userId).toBe('user-1');
    expect(decoded.organizationId).toBe('org-1');
    expect(decoded.provider).toBe('granola');
  });

  it('rejects tampered state', async () => {
    const { signState, verifyState } = await import(
      '../../src/integrations/_platform/oauth.js'
    );
    const state = signState({
      userId: 'user-1',
      organizationId: 'org-1',
      provider: 'granola',
    });
    const tampered = state.slice(0, -3) + 'XXX';
    expect(() => verifyState(tampered)).toThrow();
  });

  it('rejects expired state (>10 minutes)', async () => {
    vi.useFakeTimers();
    const { signState, verifyState } = await import(
      '../../src/integrations/_platform/oauth.js'
    );
    const state = signState({
      userId: 'user-1',
      organizationId: 'org-1',
      provider: 'granola',
    });
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(() => verifyState(state)).toThrow(/expired/i);
    vi.useRealTimers();
  });
});
