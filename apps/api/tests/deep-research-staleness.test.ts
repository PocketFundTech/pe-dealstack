/**
 * Deep Research Staleness Tests
 *
 * Verifies that background research jobs which were killed mid-flight by the
 * Vercel serverless function timeout are detected and self-heal. The agent
 * writes `status: 'running'` to Organization.settings.deepResearch, but if
 * the function dies before reaching the 'complete' / 'failed' transition,
 * `status` is stuck on 'running' forever and the frontend polls indefinitely.
 *
 * The fix: when a status-read sees status === 'running' AND startedAt is
 * more than 5 minutes ago, treat it as 'failed' and persist the change.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 3 Task 3.7
 * Refs: .planning/codebase/CONCERNS.md §6.5, §8.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a controllable supabase mock so each test can hand-craft the
// Organization row that .single() returns and assert what .update() received.
const supabaseMocks = vi.hoisted(() => {
  const selectSingle = vi.fn();
  const update = vi.fn();
  return { selectSingle, update };
});

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => {
      // Each chain ends in either .single() (read) or .eq() (after update()).
      // We return a chainable object whose terminal points to our mocks.
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: supabaseMocks.selectSingle,
        update: vi.fn((payload: any) => {
          supabaseMocks.update(payload);
          return chain;
        }),
      };
      return chain;
    }),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks are wired up.
import { markStaleDeepResearchAsFailed, STALE_THRESHOLD_MS } from '../src/services/agents/firmResearchAgent/deepResearchProgress.js';

describe('markStaleDeepResearchAsFailed helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a running job older than 5 minutes as failed and persists the change', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const settings = {
      firmProfile: { name: 'Acme PE' },
      deepResearch: {
        status: 'running',
        startedAt: tenMinutesAgo,
        queriesRun: 4,
        insightsFound: 0,
      },
    };

    const result = await markStaleDeepResearchAsFailed('org-1', settings);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/timed out/i);
    expect(result.failedAt).toBeDefined();
    expect(supabaseMocks.update).toHaveBeenCalledTimes(1);

    // The persisted settings must keep firmProfile intact and write back the
    // updated deepResearch object.
    const persisted = supabaseMocks.update.mock.calls[0][0];
    expect(persisted.settings.firmProfile).toEqual({ name: 'Acme PE' });
    expect(persisted.settings.deepResearch.status).toBe('failed');
  });

  it('leaves a fresh running job alone (startedAt 1 minute ago)', async () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const settings = {
      deepResearch: {
        status: 'running',
        startedAt: oneMinuteAgo,
        queriesRun: 2,
        insightsFound: 0,
      },
    };

    const result = await markStaleDeepResearchAsFailed('org-1', settings);

    expect(result.status).toBe('running');
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('leaves completed jobs alone', async () => {
    const settings = {
      deepResearch: {
        status: 'complete',
        startedAt: new Date(Date.now() - 99 * 60 * 1000).toISOString(),
        completedAt: new Date().toISOString(),
        queriesRun: 12,
        insightsFound: 7,
      },
    };

    const result = await markStaleDeepResearchAsFailed('org-1', settings);

    expect(result.status).toBe('complete');
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('treats legacy "running" rows without startedAt as stale (failed)', async () => {
    // Legacy data from before this fix may have status='running' but no
    // startedAt. The safest assumption is that the row is already dead —
    // the only way it could be missing startedAt is from old code that
    // doesn't exist anymore. Treat it as stale so the user can retry.
    const settings = {
      deepResearch: {
        status: 'running',
        queriesRun: 0,
        insightsFound: 0,
      },
    };

    const result = await markStaleDeepResearchAsFailed('org-1', settings);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/timed out|unknown start/i);
    expect(supabaseMocks.update).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no deepResearch object exists at all', async () => {
    const settings = { firmProfile: { name: 'Acme' } };

    const result = await markStaleDeepResearchAsFailed('org-1', settings);

    expect(result).toBeNull();
    expect(supabaseMocks.update).not.toHaveBeenCalled();
  });

  it('uses a 5-minute threshold', () => {
    expect(STALE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});
