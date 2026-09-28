import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { runWithUsageContext } from '../src/middleware/usageContext.js';
import { makeWebSearchTool } from '../src/services/agents/dealChatAgent/tools/webSearch.js';

describe('web_search tool — Tavily usage tracking', () => {
  const originalFetch = global.fetch;
  const originalPrimary = process.env.TAVILY_API_KEY;
  const originalFallback = process.env.TAVILY_API_KEY_FALLBACK;

  beforeEach(() => {
    insertSpy.mockClear();
    process.env.TAVILY_API_KEY = 'primary-key';
    delete process.env.TAVILY_API_KEY_FALLBACK;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.TAVILY_API_KEY = originalPrimary;
    process.env.TAVILY_API_KEY_FALLBACK = originalFallback;
  });

  it('records a 1-credit UsageEvent for a successful basic search', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ title: 'A', url: 'https://a.com', content: 'snippet' }] }),
    })) as any;

    const tool = makeWebSearchTool();
    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      const output = await tool.run({ query: 'acme corp' } as any);
      expect(output).toContain('Found 1 results');
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.provider).toBe('tavily');
    expect(row.units).toBe(1);
    expect(Number(row.costUsd)).toBeCloseTo(0.008, 6);
    expect(row.status).toBe('success');
  });

  it('records 2 credits for an advanced-depth search', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    })) as any;

    const tool = makeWebSearchTool();
    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      await tool.run({ query: 'acme corp', search_depth: 'advanced' } as any);
    });

    const row = insertSpy.mock.calls[0][0];
    expect(row.units).toBe(2);
    expect(Number(row.costUsd)).toBeCloseTo(0.016, 6);
  });

  it('records an error UsageEvent for a failed attempt, then a second event for the fallback-key retry', async () => {
    process.env.TAVILY_API_KEY_FALLBACK = 'fallback-key';
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 429, text: async () => 'rate limited' } as any;
      }
      return { ok: true, json: async () => ({ results: [{ title: 'B', url: 'https://b.com', content: 'x' }] }) } as any;
    }) as any;

    const tool = makeWebSearchTool();
    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      await tool.run({ query: 'acme corp' } as any);
    });

    expect(insertSpy).toHaveBeenCalledTimes(2);
    const [errorRow, successRow] = insertSpy.mock.calls.map((c) => c[0]);
    expect(errorRow.status).toBe('error');
    expect(errorRow.metadata.keyTier).toBe('primary');
    expect(successRow.status).toBe('success');
    expect(successRow.metadata.keyTier).toBe('fallback');
  });
});
