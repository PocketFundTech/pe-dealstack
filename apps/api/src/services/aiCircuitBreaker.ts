// ─── AI Provider Circuit Breaker ────────────────────────────────────
// In-memory per-provider circuit breaker for LLM SDK calls. Trips after
// 5 consecutive provider-side errors (HTTP 5xx, 529 "overloaded",
// network errors) inside a 60s rolling window, fail-fasts for 30s, then
// allows one half-open probe.
//
// State is per-process (per Vercel function instance). That's fine —
// even a partial trip across instances dramatically cuts the blast
// radius vs. hammering OpenAI with thousands of failing requests during
// a provider outage.
//
// What does NOT count as a breaker failure:
//   - 4xx client errors (401 bad key, 429 rate limit, 400 bad request)
//     Those are config / quota issues, not provider downtime.
//   - The breaker's own AIProviderUnavailableError (no double-counting).

import { AIProviderUnavailableError } from '../utils/aiErrors.js';
import { log } from '../utils/logger.js';

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 30_000;

type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  provider: string;
  state: BreakerState;
  failureCount: number;
  lastTrippedAt: number | null;
  openUntil: number | null;
}

interface BreakerInternal {
  state: BreakerState;
  failures: number[]; // timestamps within rolling window
  lastTrippedAt: number | null;
  openUntil: number | null;
}

// Module-level state. Per-process, in-memory.
const breakers = new Map<string, BreakerInternal>();

// Injectable clock for tests. Defaults to Date.now.
let clock: () => number = () => Date.now();

/** Test-only: override the clock used for window / open-state timing. */
export function __setClockForTests(fn: () => number): void {
  clock = fn;
}

/** Test-only: reset every breaker to closed state. */
export function __resetAllBreakersForTests(): void {
  breakers.clear();
}

function getOrCreate(providerKey: string): BreakerInternal {
  let b = breakers.get(providerKey);
  if (!b) {
    b = { state: 'closed', failures: [], lastTrippedAt: null, openUntil: null };
    breakers.set(providerKey, b);
  }
  return b;
}

/**
 * Decide whether an error from an LLM SDK call is a "provider-down"
 * signal. Returns true for HTTP 5xx, 529 (Anthropic overloaded),
 * network errors. Returns false for 4xx (client/config issues).
 */
export function isProviderDownError(err: unknown): boolean {
  if (err instanceof AIProviderUnavailableError) return false; // already counted
  const e = err as { status?: number; statusCode?: number; code?: string; message?: string; name?: string };
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number') {
    if (status === 529) return true; // Anthropic overloaded
    if (status >= 500 && status < 600) return true;
    return false; // any other status (incl. 4xx) is not provider-down
  }
  const code = e?.code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
    return true;
  }
  const msg = (e?.message ?? '').toLowerCase();
  if (msg.includes('overloaded')) return true;
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('socket hang up')) {
    return true;
  }
  return false;
}

function pruneOldFailures(b: BreakerInternal, now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS;
  // Failures array stays small (< 10 typically); filter is fine.
  if (b.failures.length === 0) return;
  if (b.failures[0]! >= cutoff) return;
  b.failures = b.failures.filter(t => t >= cutoff);
}

function tripOpen(b: BreakerInternal, providerKey: string, now: number): void {
  b.state = 'open';
  b.lastTrippedAt = now;
  b.openUntil = now + OPEN_DURATION_MS;
  log.warn('ai-circuit-breaker: tripped open', {
    provider: providerKey,
    failureCount: b.failures.length,
    openForMs: OPEN_DURATION_MS,
  });
}

function closeBreaker(b: BreakerInternal, providerKey: string): void {
  if (b.state !== 'closed') {
    log.info('ai-circuit-breaker: closed', { provider: providerKey });
  }
  b.state = 'closed';
  b.failures = [];
  b.openUntil = null;
}

/**
 * Wrap an async LLM SDK call. Throws AIProviderUnavailableError when
 * the breaker is open. Counts provider-side failures (5xx / 529 /
 * network), passes 4xx errors through untouched so the caller still
 * sees the real error for handling.
 */
export async function withCircuitBreaker<T>(
  providerKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const b = getOrCreate(providerKey);
  const now = clock();

  // Transition open → half-open after openUntil has elapsed.
  if (b.state === 'open' && b.openUntil !== null && now >= b.openUntil) {
    b.state = 'half-open';
    log.info('ai-circuit-breaker: half-open probe allowed', { provider: providerKey });
  }

  if (b.state === 'open') {
    throw new AIProviderUnavailableError(providerKey);
  }

  try {
    const result = await fn();
    // Success path
    if (b.state === 'half-open') {
      closeBreaker(b, providerKey);
    } else {
      // Closed: clear stale failures (counter resets on success).
      b.failures = [];
    }
    return result;
  } catch (err) {
    if (!isProviderDownError(err)) {
      // Client / config error — do not count toward breaker.
      throw err;
    }
    const now2 = clock();
    if (b.state === 'half-open') {
      // Failed probe → re-open for another OPEN_DURATION_MS.
      b.failures = []; // counter is informational once we're tripped
      tripOpen(b, providerKey, now2);
      throw err;
    }
    // Closed state: record and possibly trip.
    b.failures.push(now2);
    pruneOldFailures(b, now2);
    if (b.failures.length >= FAILURE_THRESHOLD) {
      tripOpen(b, providerKey, now2);
    }
    throw err;
  }
}

/** Read-only snapshot for observability / health endpoints. */
export function getBreakerState(providerKey: string): BreakerSnapshot {
  const b = breakers.get(providerKey);
  if (!b) {
    return { provider: providerKey, state: 'closed', failureCount: 0, lastTrippedAt: null, openUntil: null };
  }
  // Lazy transition for observability calls too.
  const now = clock();
  if (b.state === 'open' && b.openUntil !== null && now >= b.openUntil) {
    b.state = 'half-open';
  }
  return {
    provider: providerKey,
    state: b.state,
    failureCount: b.failures.length,
    lastTrippedAt: b.lastTrippedAt,
    openUntil: b.openUntil,
  };
}
