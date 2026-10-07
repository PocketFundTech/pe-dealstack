/**
 * AI on click only: opening a deal's Analysis section reads cached results.
 * The customer-concentration read and the narrative insights run only when
 * the user clicks "Generate AI insights" (?generate=1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/supabase.js', () => {
  const rows = [{ id: 's-1', period: '2024', statementType: 'INCOME_STATEMENT' }];
  const chain: any = {
    select: () => chain, eq: () => chain, order: () => chain,
    range: async () => ({ data: rows, error: null }),
    single: async () => ({ data: { name: 'Acme', industry: null }, error: null }),
  };
  return { supabase: { from: () => chain } };
});
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: async () => ({ id: 'deal-1' }),
}));
vi.mock('../src/routes/financials-memo.js', () => ({ default: express.Router() }));
vi.mock('../src/services/analysis/index.js', () => ({ analyzeFinancials: async () => ({ qoe: { score: 70 } }) }));

const getConcentrationFacts = vi.fn(async () => null);
vi.mock('../src/services/analysis/customerConcentrationReader.js', () => ({
  getConcentrationFacts: (...a: unknown[]) => getConcentrationFacts(...(a as [])),
}));

const getOrGenerateInsights = vi.fn(async () => ({ insights: { executiveSummary: 'Fresh.' }, fromCache: false }));
const getCachedInsights = vi.fn(async () => null as unknown);
vi.mock('../src/services/narrativeInsights.js', () => ({
  generateNarrativeInsights: vi.fn(),
  computeAnalysisHash: () => 'hash-1',
  getOrGenerateInsights: (...a: unknown[]) => getOrGenerateInsights(...(a as [])),
  getCachedInsights: (...a: unknown[]) => getCachedInsights(...(a as [])),
  cacheInsights: vi.fn(),
  invalidateCache: vi.fn(),
}));
vi.mock('../src/services/agentMemory.js', () => ({
  getIndustryBenchmarks: async () => [],
  getPortfolioSummary: async () => ({ dealCount: 0 }),
  snapshotDealMetrics: async () => {},
  updateIndustryMemory: async () => {},
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/financials-analysis.js');
  const app = express();
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCachedInsights.mockResolvedValue(null);
});

describe('GET /financials/analysis', () => {
  it('reads customer concentration from cache only on a page load', async () => {
    const res = await request(await buildApp()).get('/api/deals/deal-1/financials/analysis');
    expect(res.status).toBe(200);
    expect(getConcentrationFacts).toHaveBeenCalledWith('deal-1', { generate: false });
  });

  it('runs the AI read when the user clicks Generate (?generate=1)', async () => {
    await request(await buildApp()).get('/api/deals/deal-1/financials/analysis?generate=1');
    expect(getConcentrationFacts).toHaveBeenCalledWith('deal-1', { generate: true });
  });
});

describe('GET /financials/insights', () => {
  it('returns no insights and needsGeneration on a cache miss, with no AI call', async () => {
    const res = await request(await buildApp()).get('/api/deals/deal-1/financials/insights');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasData: true, insights: null, needsGeneration: true });
    expect(getOrGenerateInsights).not.toHaveBeenCalled();
  });

  it('returns cached insights on a page load', async () => {
    getCachedInsights.mockResolvedValue({ executiveSummary: 'Cached.' });
    const res = await request(await buildApp()).get('/api/deals/deal-1/financials/insights');
    expect(res.body).toMatchObject({ insights: { executiveSummary: 'Cached.' }, needsGeneration: false });
    expect(getOrGenerateInsights).not.toHaveBeenCalled();
  });

  it('generates when the user clicks Generate (?generate=1)', async () => {
    const res = await request(await buildApp()).get('/api/deals/deal-1/financials/insights?generate=1');
    expect(res.status).toBe(200);
    expect(getOrGenerateInsights).toHaveBeenCalledTimes(1);
    expect(res.body.insights).toEqual({ executiveSummary: 'Fresh.' });
  });
});
