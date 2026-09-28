// services/webSearch.ts's searchViaApify/scrapeLinkedInProfile used to
// swallow Apify actor failures inside the trackedApifyCall callback and
// return [] / null — which trackedApifyCall records as a full-cost
// 'success' UsageEvent (it only records 'error' when its fn rejects). This
// verifies the fix: an actor failure now surfaces as a thrown error inside
// the tracked callback (recorded as status 'error', $0 cost), while the
// public function still returns [] / null to its caller exactly as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertSpy,
      select: vi.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  },
}));

vi.mock('../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: vi.fn(async () => 1),
}));

vi.mock('../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

const { actorCall } = vi.hoisted(() => ({ actorCall: vi.fn() }));
vi.mock('apify-client', () => ({
  ApifyClient: class {
    actor() {
      return { call: actorCall };
    }
  },
}));

import { runWithUsageContext } from '../src/middleware/usageContext.js';

describe('webSearch.ts — Apify actor failures record status error, not success', () => {
  beforeEach(() => {
    insertSpy.mockClear();
    actorCall.mockReset();
    process.env.APIFY_API_KEY = 'test-apify-key';
  });

  it('searchWeb via Apify: an actor throw records a $0 error UsageEvent and still returns [] to the caller (via DDG fallback)', async () => {
    actorCall.mockRejectedValue(new Error('actor run failed'));

    const { searchWeb } = await import('../src/services/webSearch.js');

    // Stub the DDG fallbacks so this test only exercises the Apify path —
    // fetch is used by fetchDDGLite/fetchDDGHtml after Apify returns [].
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })) as any;

    try {
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        const results = await searchWeb('acme corp', 5);
        expect(results).toEqual([]);
      });
    } finally {
      global.fetch = originalFetch;
    }

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.provider).toBe('apify');
    expect(row.status).toBe('error');
    expect(Number(row.costUsd)).toBe(0);
  });
});
