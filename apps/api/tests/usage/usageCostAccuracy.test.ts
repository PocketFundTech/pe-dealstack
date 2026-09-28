/**
 * Cost-accuracy core (2026-09-29). The ledger was wrong in both directions:
 *  - Anthropic cache tokens were never recorded or priced. `usage.input_tokens`
 *    EXCLUDES cached tokens, so a prompt-cached extraction (PR #145) dropped
 *    most of its real input from the bill. Anthropic bills cache writes at
 *    1.25x (5-minute TTL) / 2x (1-hour TTL) the input price, and reads at 0.1x
 *    (0.025x on claude-fable-5-1) — verified against the Claude API reference.
 *  - Served model ids like `claude-haiku-4-5-20251001` missed the exact-match
 *    price table and recorded $0.
 *  - Managed-agent sessions report an authoritative `usage.list_cost` (tokens +
 *    web search + runtime) that must be recorded as-is, not re-derived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertMock = vi.fn(async () => ({ error: null }));
const priceRows = [
  { model: 'claude-sonnet-5', provider: 'anthropic', inputPricePer1M: 2, outputPricePer1M: 10 },
  { model: 'claude-haiku-4-5', provider: 'anthropic', inputPricePer1M: 1, outputPricePer1M: 5 },
  {
    model: 'claude-fable-5-1', provider: 'anthropic', inputPricePer1M: 10, outputPricePer1M: 50,
    cacheReadPricePer1M: 0.25, cacheWrite5mPricePer1M: null, cacheWrite1hPricePer1M: null,
  },
  { model: 'gpt-4o', provider: 'openai', inputPricePer1M: 2.5, outputPricePer1M: 10 },
];
const orgAdmins: Record<string, Array<{ id: string }>> = { 'org-1': [{ id: 'admin-user-1' }], 'org-empty': [] };

vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'ModelPrice') return { select: vi.fn(async () => ({ data: priceRows, error: null })) };
      if (table === 'UsageEvent') return { insert: insertMock };
      if (table === 'User') {
        let org = '';
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: string) => { if (col === 'organizationId') org = val; return chain; },
          in: () => chain,
          order: () => chain,
          limit: async () => ({ data: orgAdmins[org] ?? [], error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  },
}));
vi.mock('../../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/services/usage/operationCredits.js', () => ({ getCreditsForOperation: vi.fn(async () => 1) }));
vi.mock('../../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

import { getModelPrice, computeCostUsd, _resetModelPriceCache } from '../../src/services/usage/modelPrices.js';
import { recordUsageEvent } from '../../src/services/usage/trackedLLM.js';
import { runWithUsageContext, runAsOrgSystem } from '../../src/middleware/usageContext.js';

const ctx = { userId: 'user-1', organizationId: 'org-1', source: 'test' as const };
const lastRow = () => (insertMock.mock.calls.at(-1) as unknown as [Record<string, any>])[0];

beforeEach(() => {
  _resetModelPriceCache();
  insertMock.mockClear();
});

describe('model price lookup', () => {
  it('falls back from a date-suffixed served model id to its base id', async () => {
    const price = await getModelPrice('claude-haiku-4-5-20251001');
    expect(price).toMatchObject({ inputPricePer1M: 1, outputPricePer1M: 5 });
  });

  it('still returns null for a genuinely unknown model', async () => {
    expect(await getModelPrice('totally-unknown-model')).toBeNull();
  });
});

describe('computeCostUsd with prompt caching', () => {
  it('prices Anthropic cache reads at 0.1x and 5-minute / 1-hour writes at 1.25x / 2x input', async () => {
    const price = await getModelPrice('claude-sonnet-5'); // $2 in / $10 out
    const cost = computeCostUsd(price, 1_000_000, 1_000_000, {
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    // 2 (input) + 10 (output) + 0.2 (read) + 2.5 (5m write) + 4 (1h write)
    expect(cost).toBeCloseTo(18.7, 6);
  });

  it('uses an explicit per-model cache price when the table sets one (Fable 5.1 reads at $0.25/MTok)', async () => {
    const price = await getModelPrice('claude-fable-5-1');
    expect(computeCostUsd(price, 0, 0, { cacheReadTokens: 1_000_000 })).toBeCloseTo(0.25, 6);
    // unset write prices still fall back to the standard multipliers
    expect(computeCostUsd(price, 0, 0, { cacheWrite5mTokens: 1_000_000 })).toBeCloseTo(12.5, 6);
  });

  it('prices cache tokens at the full input rate for non-Anthropic providers (no guessed discount)', async () => {
    const price = await getModelPrice('gpt-4o'); // $2.5 in
    expect(computeCostUsd(price, 0, 0, { cacheReadTokens: 1_000_000 })).toBeCloseTo(2.5, 6);
  });

  it('keeps the old 3-argument behaviour unchanged', () => {
    expect(computeCostUsd({ inputPricePer1M: 2.5, outputPricePer1M: 10 }, 1000, 500)).toBeCloseTo(0.0075, 6);
  });
});

describe('recordUsageEvent — every token counted', () => {
  it('includes cache tokens in cost and totalTokens and records them in metadata', async () => {
    await runWithUsageContext(ctx, () =>
      recordUsageEvent({
        operation: 'financial_extraction',
        provider: 'anthropic',
        status: 'success',
        model: 'claude-sonnet-5',
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 10_000,
        cacheWrite5mTokens: 20_000,
      }),
    );
    const row = lastRow();
    expect(row.totalTokens).toBe(1000 + 500 + 10_000 + 20_000);
    // 1000*2 + 500*10 + 10000*0.2 + 20000*2.5 per 1M
    expect(row.costUsd).toBeCloseTo((2000 + 5000 + 2000 + 50_000) / 1_000_000, 9);
    expect(row.metadata).toMatchObject({ cacheReadTokens: 10_000, cacheWrite5mTokens: 20_000 });
  });

  it('records a caller-supplied authoritative cost as-is (managed-agent list_cost)', async () => {
    await runWithUsageContext(ctx, () =>
      recordUsageEvent({
        operation: 'signal_monitor_managed_agent',
        provider: 'anthropic',
        status: 'success',
        model: 'claude-sonnet-5',
        promptTokens: 1000,
        completionTokens: 100,
        costOverrideUsd: 0.42,
      }),
    );
    expect(lastRow().costUsd).toBe(0.42);
    expect(lastRow().model).toBe('claude-sonnet-5');
  });

  it('keeps the model name on non-LLM rows instead of writing null', async () => {
    await runWithUsageContext(ctx, () =>
      recordUsageEvent({
        operation: 'gemini_embed_doc',
        provider: 'gemini',
        status: 'success',
        model: 'gemini-embedding-001',
        unitCostUsd: 0.001,
        units: 3,
      }),
    );
    expect(lastRow().model).toBe('gemini-embedding-001');
  });
});

describe('runAsOrgSystem — background, cron and webhook work is attributed, not dropped', () => {
  it('binds a context for the org (attributed to an org admin) so usage is recorded', async () => {
    await runAsOrgSystem('org-1', 'cron:signal-scan', () =>
      recordUsageEvent({ operation: 'x', provider: 'anthropic', status: 'success', model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 1 }),
    );
    const row = lastRow();
    expect(row.organizationId).toBe('org-1');
    expect(row.userId).toBe('admin-user-1');
    expect(row.metadata).toMatchObject({ attribution: 'system', systemSource: 'cron:signal-scan' });
  });

  it('keeps an existing request context instead of overriding it', async () => {
    await runWithUsageContext(ctx, () =>
      runAsOrgSystem('org-1', 'background:embed', () =>
        recordUsageEvent({ operation: 'x', provider: 'anthropic', status: 'success', model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 1 }),
      ),
    );
    expect(lastRow().userId).toBe('user-1');
  });

  it('still runs the work when the org has no user to attribute to', async () => {
    const result = await runAsOrgSystem('org-empty', 'cron:x', async () => 'ran');
    expect(result).toBe('ran');
  });
});
