// AI cost plan H4: every AI call that belongs to a deal carries
// metadata.dealId, so cost per deal is read from the ledger instead of
// estimated. Covers the URL-derived tag (deal chat, memo, scorecard,
// financials…) and the ingest read that runs before its deal exists.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.hoisted(() => vi.fn(async (_row: any) => ({ error: null })));
const updateSpy = vi.hoisted(() => vi.fn());
const memoRows = vi.hoisted(() => new Map<string, { dealId: string | null }>());
const memoLookups = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'Memo') {
        const filters: Record<string, string> = {};
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: string) => { filters[col] = val; return chain; },
          maybeSingle: async () => {
            memoLookups.count++;
            const row = memoRows.get(filters.id);
            return { data: row && filters.organizationId === 'o1' ? row : null, error: null };
          },
        };
        return chain;
      }
      return {
        insert: insertSpy,
        update: (patch: any) => ({
          eq: async (_col: string, id: string) => { updateSpy(id, patch); return { error: null }; },
        }),
      };
    },
  },
}));
vi.mock('../../src/services/usage/modelPrices.js', () => ({
  getModelPrice: async () => null,
  computeCostUsd: () => 0,
}));
vi.mock('../../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: async () => 0,
}));

import { recordUsageEvent } from '../../src/services/usage/trackedLLM.js';
import {
  runWithUsageContext,
  runWithPendingDeal,
  bindDealToUsage,
  dealIdForRequest,
  getUsageContext,
} from '../../src/middleware/usageContext.js';

const ctx = { userId: 'u1', organizationId: 'o1', source: 'test' as const };
const DEAL = '3f2c1a9e-8b7d-4c6e-9f10-112233445566';
const OTHER_DEAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MEMO = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

const record = (operation: string) =>
  recordUsageEvent({ operation, provider: 'anthropic', status: 'success', model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 1 });

beforeEach(() => {
  insertSpy.mockClear();
  updateSpy.mockClear();
  memoRows.clear();
  memoLookups.count = 0;
});

describe('dealIdForRequest', () => {
  it('reads the deal from a /deals/:dealId/... URL', async () => {
    expect(await dealIdForRequest(`/api/deals/${DEAL}/chat`, 'o1')).toBe(DEAL);
    expect(await dealIdForRequest(`/api/deals/${DEAL}/financials/extract?force=1`, 'o1')).toBe(DEAL);
    expect(await dealIdForRequest(`/api/deals/${DEAL}`, 'o1')).toBe(DEAL);
  });

  it('ignores deal routes that are not about one deal', async () => {
    expect(await dealIdForRequest('/api/deals/stats', 'o1')).toBeUndefined();
    expect(await dealIdForRequest('/api/deals/import/preview', 'o1')).toBeUndefined();
    expect(await dealIdForRequest('/api/ai/chat', 'o1')).toBeUndefined();
  });

  it('reads a memo route’s deal from the memo, scoped to the org, and caches it', async () => {
    memoRows.set(MEMO, { dealId: DEAL });
    expect(await dealIdForRequest(`/api/memos/${MEMO}/sections/s1/generate`, 'o1')).toBe(DEAL);
    expect(await dealIdForRequest(`/api/memos/${MEMO}/chat`, 'o1')).toBe(DEAL);
    expect(memoLookups.count).toBe(1);
  });

  it('does not tag a memo from another org', async () => {
    memoRows.set('11111111-2222-4333-8444-555555555555', { dealId: DEAL });
    expect(await dealIdForRequest('/api/memos/11111111-2222-4333-8444-555555555555/chat', 'o2')).toBeUndefined();
  });
});

describe('ingest: usage recorded before the deal exists', () => {
  it('tags the earlier rows once the deal is created, and later rows directly', async () => {
    await runWithUsageContext(ctx, () =>
      runWithPendingDeal(async () => {
        await record('deal_ingest'); // the read that decides the deal
        await bindDealToUsage(DEAL);
        await record('embedding'); // after the deal exists
      }),
    );

    // insertSpy also sees the audit-log row written after each success.
    const [first, second] = insertSpy.mock.calls.map((c) => c[0]).filter((r) => 'promptTokens' in r);
    expect(first.metadata).not.toHaveProperty('dealId');
    expect(first.id).toEqual(expect.any(String));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(first.id, { metadata: expect.objectContaining({ dealId: DEAL }) });
    expect(second.metadata.dealId).toBe(DEAL);
    expect(second).not.toHaveProperty('id');
  });

  it('keeps two ingests in one request apart (bulk / email attachments)', async () => {
    await runWithUsageContext(ctx, async () => {
      await runWithPendingDeal(async () => {
        await record('deal_ingest');
        await bindDealToUsage(DEAL);
      });
      await runWithPendingDeal(async () => {
        expect(getUsageContext()?.dealId).toBeUndefined();
        await record('deal_ingest');
        await bindDealToUsage(OTHER_DEAL);
      });
    });
    expect(updateSpy.mock.calls.map((c) => c[1].metadata.dealId)).toEqual([DEAL, OTHER_DEAL]);
  });

  it('records normally, with no row id, outside an ingest', async () => {
    await runWithUsageContext(ctx, () => record('nda_review'));
    expect(insertSpy.mock.calls[0][0]).not.toHaveProperty('id');
  });

  it('is a no-op without a usage context', async () => {
    await expect(bindDealToUsage(DEAL)).resolves.toBeUndefined();
    expect(await runWithPendingDeal(async () => 'ok')).toBe('ok');
  });
});
