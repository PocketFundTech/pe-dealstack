/**
 * Deal reactivation engine — rescorePassedDeal + sweepPassedDeals (spec §5.5).
 *
 * The headline assertion here is negative: a sweep over passed deals with
 * nothing new must not call the scorer at all. That is the difference
 * between a feature that compounds value and one that quietly bills the
 * customer for 300 LLM calls a night.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const scoreDeal = vi.fn();
vi.mock('../src/services/agents/dealScorecard/index.js', () => ({
  scoreDeal: (...args: any[]) => scoreDeal(...args),
  CriteriaNotConfiguredError: class extends Error {},
}));

const notifyDealTeam = vi.fn(async () => undefined);
vi.mock('../src/routes/notifications.js', () => ({
  notifyDealTeam: (...args: any[]) => notifyDealTeam(...args),
  resolveUserId: vi.fn(async () => null),
}));

let dealRows: any[] = [];
let financialRows: any[] = [];
let orgSettings: any = {};
let dealPatch: any = null;
let insertedReactivations: any[] = [];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: async () => ({ data: dealRows, error: null }),
        single: async () => ({ data: dealRows[0] ?? null, error: null }),
        update: (patch: any) => {
          dealPatch = patch;
          const upd: any = { eq: () => upd, then: (r: any) => r({ error: null }) };
          return upd;
        },
        then: (resolve: any) => resolve({ data: dealRows, error: null }),
      };
      return chain;
    }
    if (table === 'FinancialStatement') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: async () => ({ data: financialRows, error: null }),
        then: (resolve: any) => resolve({ data: financialRows, error: null }),
      };
      return chain;
    }
    if (table === 'Organization') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }),
      };
    }
    if (table === 'DealReactivation') {
      return {
        insert: (row: any) => {
          insertedReactivations.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 'react-1', ...row }, error: null }) }) };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function loadEngine() {
  return import('../src/services/agents/dealReactivation/index.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  dealPatch = null;
  insertedReactivations = [];
  financialRows = [];
  orgSettings = { dealCriteria: { thesis: 'x', updatedAt: daysAgo(200) } };
  dealRows = [
    {
      id: 'deal-1',
      organizationId: 'org-1',
      name: 'Meridian Logistics',
      stage: 'PASSED',
      revisitAt: null,
      lastRescoredAt: daysAgo(90),
      scorecard: { overallScore: 40, verdict: 'NO_GO', scoredAt: daysAgo(90), reasons: [] },
      scorecardHistory: [],
    },
  ];
  mockSupabase.from.mockImplementation(tableMock());
  scoreDeal.mockResolvedValue({
    overallScore: 78, verdict: 'GO', qualityScore: 70, thesisFitScore: 82,
    reasons: [{ kind: 'hit', text: 'Inside size range' }],
    scoredAt: new Date().toISOString(), model: 'claude-fable-5',
  });
});

describe('sweepPassedDeals — the cost gate', () => {
  it('makes ZERO scoring calls when nothing changed', async () => {
    const { sweepPassedDeals } = await loadEngine();
    const result = await sweepPassedDeals('org-1');

    expect(scoreDeal).not.toHaveBeenCalled();
    expect(result.rescored).toBe(0);
    expect(result.scanned).toBeGreaterThan(0);
  });

  it('scores only the deals that actually have new financials', async () => {
    dealRows = [
      dealRows[0],
      { ...dealRows[0], id: 'deal-2', name: 'Quiet Co' },
    ];
    financialRows = [{ dealId: 'deal-1', createdAt: daysAgo(1), updatedAt: daysAgo(1) }];

    const { sweepPassedDeals } = await loadEngine();
    const result = await sweepPassedDeals('org-1');

    expect(scoreDeal).toHaveBeenCalledTimes(1);
    expect(scoreDeal).toHaveBeenCalledWith('deal-1', 'org-1');
    expect(result.rescored).toBe(1);
  });

  it('caps how many deals one run may score, and says so', async () => {
    const { sweepPassedDeals, SWEEP_MAX_PER_RUN } = await loadEngine();
    dealRows = Array.from({ length: SWEEP_MAX_PER_RUN + 5 }, (_, i) => ({
      ...dealRows[0], id: `deal-${i}`,
    }));
    financialRows = dealRows.map((d) => ({ dealId: d.id, createdAt: daysAgo(1), updatedAt: daysAgo(1) }));

    const result = await sweepPassedDeals('org-1');

    expect(scoreDeal).toHaveBeenCalledTimes(SWEEP_MAX_PER_RUN);
    expect(result.truncated).toBe(true);
  });

  it('keeps sweeping when one deal fails to score', async () => {
    dealRows = [dealRows[0], { ...dealRows[0], id: 'deal-2' }];
    financialRows = dealRows.map((d) => ({ dealId: d.id, createdAt: daysAgo(1), updatedAt: daysAgo(1) }));
    scoreDeal.mockRejectedValueOnce(new Error('anthropic down'));

    const { sweepPassedDeals } = await loadEngine();
    const result = await sweepPassedDeals('org-1');

    expect(result.rescored).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('rescorePassedDeal', () => {
  it('records a reactivation and alerts the team when a deal wakes up', async () => {
    const { rescorePassedDeal } = await loadEngine();
    const result = await rescorePassedDeal('deal-1', 'org-1', 'MANUAL');

    expect(result.reactivated).toBe(true);
    expect(insertedReactivations).toHaveLength(1);
    expect(insertedReactivations[0]).toMatchObject({
      dealId: 'deal-1', organizationId: 'org-1', trigger: 'MANUAL',
      previousScore: 40, newScore: 78, previousVerdict: 'NO_GO', newVerdict: 'GO',
      status: 'NEW',
    });
    expect(notifyDealTeam).toHaveBeenCalled();
  });

  it('archives the superseded scorecard into history', async () => {
    const { rescorePassedDeal } = await loadEngine();
    await rescorePassedDeal('deal-1', 'org-1', 'MANUAL');

    expect(dealPatch.scorecardHistory).toHaveLength(1);
    expect(dealPatch.scorecardHistory[0]).toMatchObject({ score: 40, verdict: 'NO_GO' });
    expect(dealPatch.lastRescoredAt).toBeTruthy();
  });

  it('caps scorecard history so the row cannot grow without bound', async () => {
    const { rescorePassedDeal, SCORECARD_HISTORY_LIMIT } = await loadEngine();
    dealRows[0].scorecardHistory = Array.from({ length: SCORECARD_HISTORY_LIMIT + 4 }, (_, i) => ({
      score: i, verdict: 'NO_GO', scoredAt: daysAgo(200 - i),
    }));

    await rescorePassedDeal('deal-1', 'org-1', 'MANUAL');
    expect(dealPatch.scorecardHistory).toHaveLength(SCORECARD_HISTORY_LIMIT);
    // Newest entry retained, oldest dropped.
    expect(dealPatch.scorecardHistory.at(-1)).toMatchObject({ score: 40 });
  });

  it('stays silent when the deal merely wobbled', async () => {
    scoreDeal.mockResolvedValue({
      overallScore: 45, verdict: 'NO_GO', qualityScore: 40, thesisFitScore: 48,
      reasons: [], scoredAt: new Date().toISOString(), model: 'claude-fable-5',
    });

    const { rescorePassedDeal } = await loadEngine();
    const result = await rescorePassedDeal('deal-1', 'org-1', 'REVISIT_DUE');

    expect(result.reactivated).toBe(false);
    expect(insertedReactivations).toHaveLength(0);
    expect(notifyDealTeam).not.toHaveBeenCalled();
    // Still stamped, so the cooldown applies and we don't re-score tomorrow.
    expect(dealPatch.lastRescoredAt).toBeTruthy();
  });

  it('refuses to touch a deal that is no longer passed', async () => {
    dealRows[0].stage = 'DUE_DILIGENCE';
    const { rescorePassedDeal } = await loadEngine();
    const result = await rescorePassedDeal('deal-1', 'org-1', 'MANUAL');

    expect(result.reactivated).toBe(false);
    expect(scoreDeal).not.toHaveBeenCalled();
  });

  it('never throws — it piggybacks on user-facing requests', async () => {
    scoreDeal.mockRejectedValue(new Error('anthropic down'));
    const { rescorePassedDeal } = await loadEngine();
    await expect(rescorePassedDeal('deal-1', 'org-1', 'FINANCIALS_UPDATED')).resolves.toMatchObject({
      reactivated: false,
    });
  });
});
