import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: () => ({
      insert: insertSpy,
      select: () => ({ eq: () => ({ single: async () => ({ data: null }) }), in: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    }),
  },
}));
vi.mock('../../src/services/usage/modelPrices.js', () => ({
  getModelPrice: async () => null,
  getCreditsForOperation: async () => 0,
}));

import { recordUsageEvent } from '../../src/services/usage/trackedLLM.js';
import { runWithUsageContext, runWithDealUsage } from '../../src/middleware/usageContext.js';

const ctx = { userId: 'u1', organizationId: 'o1', source: 'test' as const };

describe('deal usage tagging', () => {
  beforeEach(() => insertSpy.mockClear());

  it('stamps metadata.dealId on usage recorded inside runWithDealUsage', async () => {
    await runWithUsageContext(ctx, () =>
      runWithDealUsage('deal-42', () =>
        recordUsageEvent({ operation: 'deal_ingest', provider: 'anthropic', status: 'success', model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 1 }),
      ),
    );
    expect(insertSpy.mock.calls[0][0].metadata.dealId).toBe('deal-42');
  });

  it('omits dealId for usage outside a deal', async () => {
    await runWithUsageContext(ctx, () =>
      recordUsageEvent({ operation: 'nda_review', provider: 'anthropic', status: 'success', model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 1 }),
    );
    expect(insertSpy.mock.calls[0][0].metadata).not.toHaveProperty('dealId');
  });

  it('is a no-op when no usage context is bound', async () => {
    const out = await runWithDealUsage('deal-42', async () => 'ok');
    expect(out).toBe('ok');
  });
});
