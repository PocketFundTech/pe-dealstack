/**
 * POST /api/deals/:dealId/scorecard route tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const scoreDeal = vi.fn();
class CriteriaNotConfiguredError extends Error {}
vi.mock('../src/services/agents/dealScorecard/index.js', () => ({
  scoreDeal: (...args: any[]) => scoreDeal(...args),
  CriteriaNotConfiguredError,
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-scorecard.js');
  const app = express();
  app.use(express.json());
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1' };
});

describe('POST /api/deals/:dealId/scorecard', () => {
  it('returns the persisted scorecard on success', async () => {
    scoreDeal.mockResolvedValue({ overallScore: 72, verdict: 'GO', qualityScore: 78, thesisFitScore: 66, reasons: [], scoredAt: 'now', model: 'claude-sonnet-5' });
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('GO');
    expect(scoreDeal).toHaveBeenCalledWith('deal-1', 'org-1');
  });

  it('404s when the deal is not in the caller org', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(404);
    expect(scoreDeal).not.toHaveBeenCalled();
  });

  it('400s with code CRITERIA_NOT_CONFIGURED when criteria are missing', async () => {
    scoreDeal.mockRejectedValue(new CriteriaNotConfiguredError('no criteria'));
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CRITERIA_NOT_CONFIGURED');
  });

  it('500s with a clear message on engine failure (e.g. missing scorecard column)', async () => {
    scoreDeal.mockRejectedValue(new Error("column \"scorecard\" of relation \"Deal\" does not exist"));
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('scorecard');
  });
});
