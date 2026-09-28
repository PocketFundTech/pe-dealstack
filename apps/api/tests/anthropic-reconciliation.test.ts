/**
 * reconcileAnthropicDay — compares our UsageEvent ledger against Anthropic's
 * Admin API cost_report + usage_report/messages for one UTC day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

const logWarn = vi.fn();
const logError = vi.fn();
const logInfo = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  log: { info: (...a: any[]) => logInfo(...a), warn: (...a: any[]) => logWarn(...a), error: (...a: any[]) => logError(...a), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

/** Ledger rows to return from the (paginated) UsageEvent select. Each entry is one page. */
let ledgerPages: Array<Array<{ costUsd: number; totalTokens: number }>> = [[]];
let reconciliationUpsertError: { code?: string; message: string } | null = null;
let reconciliationUpsertCalls: any[] = [];
// Pagination state must persist ACROSS `supabase.from('UsageEvent')` calls —
// the real code calls .from() fresh for every page, so a per-call counter
// would keep re-serving page 0 forever and hang (this bit an earlier draft
// of this test with an OOM from the resulting infinite loop).
let ledgerPageIndex = 0;

function tableMock() {
  return (table: string) => {
    if (table === 'UsageEvent') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lt: () => chain,
        range: () => {
          const page = ledgerPages[ledgerPageIndex] ?? [];
          ledgerPageIndex += 1;
          return { data: page, error: null };
        },
      };
      return chain;
    }
    if (table === 'UsageReconciliation') {
      return {
        upsert: (payload: any) => {
          reconciliationUpsertCalls.push(payload);
          return { error: reconciliationUpsertError };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  ledgerPages = [[]];
  ledgerPageIndex = 0;
  reconciliationUpsertError = null;
  reconciliationUpsertCalls = [];
  mockSupabase.from.mockImplementation(tableMock());
  process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-test';
  delete process.env.ANTHROPIC_RECONCILE_WORKSPACE_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_ADMIN_KEY;
  delete process.env.ANTHROPIC_RECONCILE_WORKSPACE_ID;
});

function costResponse(opts: {
  results: any[];
  has_more?: boolean;
  next_page?: string | null;
}): Response {
  return new Response(
    JSON.stringify({
      data: [{ starting_at: '2026-09-28T00:00:00Z', ending_at: '2026-09-29T00:00:00Z', results: opts.results }],
      has_more: opts.has_more ?? false,
      next_page: opts.next_page ?? null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function usageResponse(results: any[]): Response {
  return new Response(
    JSON.stringify({
      data: [{ starting_at: '2026-09-28T00:00:00Z', ending_at: '2026-09-29T00:00:00Z', results }],
      has_more: false,
      next_page: null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('reconcileAnthropicDay', () => {
  it('returns { skipped: "no_admin_key" } and calls no fetch when ANTHROPIC_ADMIN_KEY is unset', async () => {
    delete process.env.ANTHROPIC_ADMIN_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result = await reconcileAnthropicDay('2026-09-28');

    expect(result).toEqual({ skipped: 'no_admin_key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('converts cents-denominated amount strings to USD ("123.45" -> 1.2345)', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(
          costResponse({
            results: [
              {
                amount: '123.45',
                currency: 'USD',
                cost_type: 'tokens',
                description: 'Claude Sonnet 5 input',
                model: 'claude-sonnet-5',
                token_type: 'uncached_input_tokens',
                workspace_id: null,
              },
            ],
          }),
        );
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.providerCostUsd).toBeCloseTo(1.2345, 6);
    expect(result.breakdown.costByTokenType.uncached_input_tokens).toBeCloseTo(1.2345, 6);
  });

  it('paginates a 2-page cost report and sums both pages', async () => {
    let costCalls = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        costCalls += 1;
        if (costCalls === 1) {
          expect(url).not.toContain('page=');
          return Promise.resolve(
            costResponse({
              results: [
                { amount: '100.00', currency: 'USD', cost_type: 'tokens', description: 'p1', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null },
              ],
              has_more: true,
              next_page: 'cursor-2',
            }),
          );
        }
        expect(url).toContain('page=cursor-2');
        return Promise.resolve(
          costResponse({
            results: [
              { amount: '50.00', currency: 'USD', cost_type: 'tokens', description: 'p2', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null },
            ],
            has_more: false,
          }),
        );
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(costCalls).toBe(2);
    // (100.00 + 50.00) cents = 150 cents = $1.50
    expect(result.providerCostUsd).toBeCloseTo(1.5, 6);
  });

  it('applies the ANTHROPIC_RECONCILE_WORKSPACE_ID filter, excluding non-matching rows', async () => {
    process.env.ANTHROPIC_RECONCILE_WORKSPACE_ID = 'ws-123';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(
          costResponse({
            results: [
              { amount: '100.00', currency: 'USD', cost_type: 'tokens', description: 'match', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: 'ws-123' },
              { amount: '999.00', currency: 'USD', cost_type: 'tokens', description: 'other-app', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: 'ws-999' },
              { amount: '500.00', currency: 'USD', cost_type: 'tokens', description: 'default-ws', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null },
            ],
          }),
        );
      }
      return Promise.resolve(
        usageResponse([
          { uncached_input_tokens: 10, cache_read_input_tokens: 0, cache_creation: null, output_tokens: 5, model: 'claude-sonnet-5', workspace_id: 'ws-123' },
          { uncached_input_tokens: 1000, cache_read_input_tokens: 0, cache_creation: null, output_tokens: 500, model: 'claude-sonnet-5', workspace_id: 'ws-999' },
        ]),
      );
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    // Only the ws-123 row (100.00 cents) should count; ws-999 and the default
    // workspace (null) are excluded once a specific filter is set.
    expect(result.providerCostUsd).toBeCloseTo(1.0, 6);
    expect(result.providerTokens).toBe(15);
    expect(result.breakdown.workspaceFilter).toBe('ws-123');
  });

  it('treats the literal "default" filter as workspace_id === null', async () => {
    process.env.ANTHROPIC_RECONCILE_WORKSPACE_ID = 'default';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(
          costResponse({
            results: [
              { amount: '100.00', currency: 'USD', cost_type: 'tokens', description: 'default-ws', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null },
              { amount: '999.00', currency: 'USD', cost_type: 'tokens', description: 'other-ws', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: 'ws-999' },
            ],
          }),
        );
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.providerCostUsd).toBeCloseTo(1.0, 6);
  });

  it('computes drift and fires the alert when drift exceeds both the pct and usd thresholds', async () => {
    // Provider cost $1.00, ledger cost $2.00 -> driftUsd=$1.00 (>0.50), driftPct=100% (>5%)
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(
          costResponse({
            results: [{ amount: '100.00', currency: 'USD', cost_type: 'tokens', description: 'd', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null }],
          }),
        );
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;
    ledgerPages = [[{ costUsd: 2.0, totalTokens: 100 }]];

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.driftUsd).toBeCloseTo(1.0, 6);
    expect(result.driftPct).toBeCloseTo(100, 3);
    expect(result.alerted).toBe(true);
    expect(logWarn).toHaveBeenCalled();
    expect(captureAgentError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'usage-reconciliation', day: '2026-09-28' }),
      'warning',
    );
  });

  it('does not alert when drift is within threshold', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(
          costResponse({
            results: [{ amount: '10000.00', currency: 'USD', cost_type: 'tokens', description: 'd', model: 'claude-sonnet-5', token_type: 'output_tokens', workspace_id: null }],
          }),
        );
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;
    // provider = $100.00, ledger = $100.10 -> driftUsd=$0.10 (< $0.50 threshold)
    ledgerPages = [[{ costUsd: 100.1, totalTokens: 100 }]];

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.alerted).toBe(false);
    expect(captureAgentError).not.toHaveBeenCalled();
  });

  it('sums ledger costUsd/totalTokens across multiple UsageEvent pages', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) return Promise.resolve(costResponse({ results: [] }));
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const page = (n: number) => Array.from({ length: n }, () => ({ costUsd: 0.01, totalTokens: 10 }));
    ledgerPages = [page(1000), page(250), page(0)];

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.ledgerCostUsd).toBeCloseTo(1250 * 0.01, 6);
    expect(result.ledgerTokens).toBe(1250 * 10);
  });

  it('degrades gracefully (logs + skips persistence) when UsageReconciliation does not exist yet', async () => {
    reconciliationUpsertError = { code: 'PGRST205', message: 'table not found' };
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) return Promise.resolve(costResponse({ results: [] }));
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.persisted).toBe(false);
    expect(logWarn).toHaveBeenCalled();
    // The summary itself is still fully computed and returned.
    expect(result.day).toBe('2026-09-28');
  });

  it('also treats 42P01 (undefined_table) as a graceful missing-table skip', async () => {
    reconciliationUpsertError = { code: '42P01', message: 'relation does not exist' };
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) return Promise.resolve(costResponse({ results: [] }));
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    const result: any = await reconcileAnthropicDay('2026-09-28');

    expect(result.persisted).toBe(false);
  });

  it('throws a clear error on a non-2xx Admin API response', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) {
        return Promise.resolve(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }));
      }
      return Promise.resolve(usageResponse([]));
    }) as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    await expect(reconcileAnthropicDay('2026-09-28')).rejects.toThrow(/401/);
  });

  it('sets the User-Agent header and correct auth headers on requests', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/cost_report')) return Promise.resolve(costResponse({ results: [] }));
      return Promise.resolve(usageResponse([]));
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    await reconcileAnthropicDay('2026-09-28');

    for (const call of fetchSpy.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-admin01-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['User-Agent']).toBeTruthy();
    }
  });

  it('rejects a malformed day string', async () => {
    const { reconcileAnthropicDay } = await import('../src/services/usage/anthropicReconciliation.js');
    await expect(reconcileAnthropicDay('09-28-2026')).rejects.toThrow(/YYYY-MM-DD/);
  });
});
