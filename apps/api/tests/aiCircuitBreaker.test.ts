/**
 * AI Circuit Breaker tests — verifies that:
 *
 *  - 5 consecutive provider-side failures within a 60s window trip the
 *    breaker open.
 *  - Once open, calls fail-fast with AIProviderUnavailableError without
 *    invoking the underlying fn.
 *  - After 30s in open, the next call becomes a half-open probe.
 *  - A successful probe closes the breaker.
 *  - A failed probe re-opens the breaker for another 30s.
 *  - Any success resets the failure counter while closed.
 *  - Failures spaced beyond the 60s window do not accumulate to 5.
 *  - 4xx client errors are not counted toward the breaker — they pass
 *    through untouched so callers handle them normally.
 *
 * Uses an injected fake clock to avoid sleeping the test process.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Logger mock — silence the breaker's info/warn during tests.
import { vi } from 'vitest';
vi.mock('../src/utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  withCircuitBreaker,
  getBreakerState,
  isProviderDownError,
  __setClockForTests,
  __resetAllBreakersForTests,
} from '../src/services/aiCircuitBreaker.js';
import { AIProviderUnavailableError } from '../src/utils/aiErrors.js';

// ─── Helpers ────────────────────────────────────────────────────────

let now = 1_000_000;
const setNow = (t: number) => {
  now = t;
};
const advance = (ms: number) => {
  now += ms;
};

function provider5xx(status = 503): () => Promise<never> {
  return async () => {
    const err: any = new Error('Upstream error');
    err.status = status;
    throw err;
  };
}

function provider4xx(status = 429): () => Promise<never> {
  return async () => {
    const err: any = new Error('Rate limited');
    err.status = status;
    throw err;
  };
}

function providerNetwork(code = 'ECONNRESET'): () => Promise<never> {
  return async () => {
    const err: any = new Error(`network ${code}`);
    err.code = code;
    throw err;
  };
}

function providerOK<T>(value: T): () => Promise<T> {
  return async () => value;
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  setNow(1_000_000);
  __setClockForTests(() => now);
  __resetAllBreakersForTests();
});

describe('isProviderDownError', () => {
  it('counts HTTP 5xx as provider-down', () => {
    expect(isProviderDownError({ status: 500, message: 'boom' })).toBe(true);
    expect(isProviderDownError({ status: 502 })).toBe(true);
    expect(isProviderDownError({ status: 503 })).toBe(true);
  });

  it('counts 529 (Anthropic overloaded) as provider-down', () => {
    expect(isProviderDownError({ status: 529 })).toBe(true);
  });

  it('counts network error codes as provider-down', () => {
    expect(isProviderDownError({ code: 'ECONNRESET' })).toBe(true);
    expect(isProviderDownError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isProviderDownError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isProviderDownError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isProviderDownError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('counts "overloaded" message as provider-down', () => {
    expect(isProviderDownError(new Error('Provider is overloaded'))).toBe(true);
  });

  it('does NOT count 4xx as provider-down', () => {
    expect(isProviderDownError({ status: 400 })).toBe(false);
    expect(isProviderDownError({ status: 401 })).toBe(false);
    expect(isProviderDownError({ status: 403 })).toBe(false);
    expect(isProviderDownError({ status: 404 })).toBe(false);
    expect(isProviderDownError({ status: 429 })).toBe(false);
  });

  it('does NOT count breaker errors as provider-down (avoid double-count)', () => {
    expect(isProviderDownError(new AIProviderUnavailableError('openai'))).toBe(false);
  });
});

describe('withCircuitBreaker — closed state', () => {
  it('passes through successful calls', async () => {
    const result = await withCircuitBreaker('openai', providerOK('ok'));
    expect(result).toBe('ok');
    expect(getBreakerState('openai').state).toBe('closed');
  });

  it('passes through 4xx errors without counting them', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(withCircuitBreaker('openai', provider4xx(429))).rejects.toMatchObject({ status: 429 });
    }
    expect(getBreakerState('openai').state).toBe('closed');
    expect(getBreakerState('openai').failureCount).toBe(0);
  });

  it('successes reset the failure counter', async () => {
    // 4 provider-down failures, then a success → counter resets
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
    }
    expect(getBreakerState('openai').failureCount).toBe(4);
    await withCircuitBreaker('openai', providerOK('ok'));
    expect(getBreakerState('openai').failureCount).toBe(0);
    expect(getBreakerState('openai').state).toBe('closed');
  });
});

describe('withCircuitBreaker — tripping open', () => {
  it('trips open after 5 consecutive provider-down failures', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
      expect(getBreakerState('openai').state).toBe('closed');
    }
    // 5th failure → trips
    await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
    expect(getBreakerState('openai').state).toBe('open');
  });

  it('failures spaced beyond 60s do not accumulate', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
      advance(61_000); // each failure is > 60s apart
    }
    // Each new failure prunes the prior ones, so we never hit 5 in window
    expect(getBreakerState('openai').state).toBe('closed');
    expect(getBreakerState('openai').failureCount).toBe(1);
  });

  it('counts network errors toward the trip threshold', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('openai', providerNetwork())).rejects.toBeDefined();
    }
    expect(getBreakerState('openai').state).toBe('open');
  });
});

describe('withCircuitBreaker — open state', () => {
  async function tripBreaker(provider = 'openai') {
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(provider, provider5xx())).rejects.toBeDefined();
    }
    expect(getBreakerState(provider).state).toBe('open');
  }

  it('fast-fails with AIProviderUnavailableError without calling fn', async () => {
    await tripBreaker();
    let called = false;
    const fn = async () => {
      called = true;
      return 'should not run';
    };
    await expect(withCircuitBreaker('openai', fn)).rejects.toBeInstanceOf(AIProviderUnavailableError);
    expect(called).toBe(false);
  });

  it('AIProviderUnavailableError carries provider name', async () => {
    await tripBreaker('anthropic');
    try {
      await withCircuitBreaker('anthropic', providerOK('x'));
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AIProviderUnavailableError);
      expect(err.provider).toBe('anthropic');
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('AI_PROVIDER_UNAVAILABLE');
    }
  });

  it('per-provider isolation — openai open does not affect gemini', async () => {
    await tripBreaker('openai');
    expect(getBreakerState('openai').state).toBe('open');
    // Gemini should still pass calls through
    const result = await withCircuitBreaker('gemini', providerOK('ok'));
    expect(result).toBe('ok');
    expect(getBreakerState('gemini').state).toBe('closed');
  });
});

describe('withCircuitBreaker — half-open probe', () => {
  async function tripBreaker(provider = 'openai') {
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(provider, provider5xx())).rejects.toBeDefined();
    }
  }

  it('after 30s in open, next call becomes the probe', async () => {
    await tripBreaker();
    // Just before 30s — still open
    advance(29_999);
    await expect(withCircuitBreaker('openai', providerOK('ok'))).rejects.toBeInstanceOf(AIProviderUnavailableError);
    // Cross the threshold
    advance(2);
    // Probe call actually runs
    let called = false;
    const result = await withCircuitBreaker('openai', async () => {
      called = true;
      return 'probe-ok';
    });
    expect(called).toBe(true);
    expect(result).toBe('probe-ok');
  });

  it('successful probe closes the breaker', async () => {
    await tripBreaker();
    advance(30_001);
    await withCircuitBreaker('openai', providerOK('ok'));
    expect(getBreakerState('openai').state).toBe('closed');
    expect(getBreakerState('openai').failureCount).toBe(0);
  });

  it('failed probe re-opens for another 30s', async () => {
    await tripBreaker();
    advance(30_001);
    await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
    expect(getBreakerState('openai').state).toBe('open');
    // Still open immediately after
    let called = false;
    await expect(
      withCircuitBreaker('openai', async () => {
        called = true;
        return 'x';
      }),
    ).rejects.toBeInstanceOf(AIProviderUnavailableError);
    expect(called).toBe(false);
    // After another 30s, half-open again
    advance(30_001);
    const result = await withCircuitBreaker('openai', providerOK('recovered'));
    expect(result).toBe('recovered');
    expect(getBreakerState('openai').state).toBe('closed');
  });

  it('half-open allows one probe — 4xx during probe does not re-open', async () => {
    await tripBreaker();
    advance(30_001);
    // 4xx is not a provider-down signal, so it should propagate but NOT re-open
    await expect(withCircuitBreaker('openai', provider4xx(400))).rejects.toMatchObject({ status: 400 });
    // The probe call ran (state was half-open). Since the error didn't count
    // as provider-down, the breaker stays in half-open. Subsequent success
    // closes it.
    const result = await withCircuitBreaker('openai', providerOK('ok'));
    expect(result).toBe('ok');
    expect(getBreakerState('openai').state).toBe('closed');
  });
});

describe('getBreakerState', () => {
  it('returns closed snapshot for unknown provider', () => {
    const snap = getBreakerState('never-seen');
    expect(snap.state).toBe('closed');
    expect(snap.failureCount).toBe(0);
    expect(snap.lastTrippedAt).toBeNull();
    expect(snap.openUntil).toBeNull();
  });

  it('reflects open state with timestamps', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('openai', provider5xx())).rejects.toBeDefined();
    }
    const snap = getBreakerState('openai');
    expect(snap.state).toBe('open');
    expect(snap.lastTrippedAt).toBe(now);
    expect(snap.openUntil).toBe(now + 30_000);
  });
});
