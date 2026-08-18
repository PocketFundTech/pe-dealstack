/**
 * Reactivation routes (spec §5.8):
 *   GET   /api/deals/reactivations           — org-wide "worth revisiting" feed
 *   POST  /api/deals/:dealId/rescore         — manual re-score
 *   PATCH /api/deals/:dealId/reactivations/:id — seen / acted / dismissed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1', name: 'Meridian Logistics' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const rescorePassedDeal = vi.fn(async () => ({ reactivated: true, newScore: 78 }));
vi.mock('../src/services/agents/dealReactivation/index.js', () => ({
  rescorePassedDeal: (...args: any[]) => rescorePassedDeal(...args),
}));

// Columns Deal actually has in production (verified against the live schema
// 2026-08-18). companyName and evMultiple are NOT among them.
const DEAL_COLUMNS = [
  'id', 'name', 'stage', 'industry', 'description', 'dealSize', 'revenue',
  'ebitda', 'currency', 'companyId', 'organizationId', 'scorecard',
  'passReason', 'passedAt', 'revisitAt', 'lastRescoredAt', 'scorecardHistory',
];
/** Reject a select naming a column Deal does not have, like PostgREST does. */
function badColumns(sel: string): string[] {
  return sel.split(',').map((s) => s.trim())
    .filter((s) => s && !s.includes('(') && !DEAL_COLUMNS.includes(s));
}

let reactivationRows: any[] = [];
let dealRows: any[] = [];
let reactivationPatch: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'DealReactivation') {
      // The real PostgREST builder keeps returning itself and is thenable,
      // so filters can be appended after .limit(). Model that, or the
      // route's conditional .eq('status') lands on a Promise.
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: reactivationRows[0] ?? null, error: null }),
        update: (patch: any) => { reactivationPatch = patch; return chain; },
        then: (resolve: any) => resolve({ data: reactivationRows, error: null }),
      };
      return chain;
    }
    if (table === 'Deal') {
      let rejected: string[] = [];
      const result = () => rejected.length
        ? { data: null, error: { message: `column Deal.${rejected[0]} does not exist` } }
        : { data: dealRows, error: null };
      const chain: any = {
        select: (sel: string) => { rejected = badColumns(sel); return chain; },
        eq: () => chain,
        in: async () => result(),
        single: async () => (rejected.length ? result() : { data: dealRows[0] ?? null, error: null }),
        then: (resolve: any) => resolve(result()),
      };
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-reactivations.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1', organizationId: 'org-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1', name: 'Meridian Logistics' };
  reactivationPatch = null;
  reactivationRows = [
    {
      id: 'react-1', dealId: 'deal-1', organizationId: 'org-1', trigger: 'FINANCIALS_UPDATED',
      previousScore: 40, newScore: 78, previousVerdict: 'NO_GO', newVerdict: 'GO',
      delta: { resolvedMisses: ['Outside size range'], gainedHits: [], newFlags: [] },
      status: 'NEW', createdAt: '2026-08-17T00:00:00Z', seenAt: null,
    },
  ];
  dealRows = [{ id: 'deal-1', name: 'Meridian Logistics', company: { name: 'Meridian' },
    stage: 'PASSED', passReason: 'Too small', revisitAt: '2026-08-01' }];
  mockSupabase.from.mockImplementation(tableMock());
  rescorePassedDeal.mockResolvedValue({ reactivated: true, newScore: 78 });
});

describe('GET /api/deals/reactivations', () => {
  it('returns the feed joined to deal names', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/reactivations');

    expect(res.status).toBe(200);
    expect(res.body.reactivations).toHaveLength(1);
    expect(res.body.reactivations[0]).toMatchObject({
      id: 'react-1',
      dealName: 'Meridian Logistics',
      previousScore: 40,
      newScore: 78,
    });
  });

  it('is not swallowed by the /:id deal route — literal path wins', async () => {
    // Regression guard: 'reactivations' must not be parsed as a deal id.
    const app = await buildApp();
    const res = await request(app).get('/api/deals/reactivations');
    expect(res.body.reactivations).toBeDefined();
  });

  it('defaults to unseen items only', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/reactivations');
    expect(res.status).toBe(200);
    expect(res.body.appliedStatus).toBe('NEW');
  });

  it('can be asked for every status', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/reactivations?status=all');
    expect(res.body.appliedStatus).toBe('all');
  });
});

describe('POST /api/deals/:dealId/rescore', () => {
  it('re-scores on demand and reports the outcome', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/rescore');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reactivated: true, newScore: 78 });
    expect(rescorePassedDeal).toHaveBeenCalledWith('deal-1', 'org-1', 'MANUAL');
  });

  it('404s across orgs', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app).post('/api/deals/other-org-deal/rescore');

    expect(res.status).toBe(404);
    expect(rescorePassedDeal).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/deals/:dealId/reactivations/:id', () => {
  it('marks an alert as dismissed', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/api/deals/deal-1/reactivations/react-1')
      .send({ status: 'DISMISSED' });

    expect(res.status).toBe(200);
    expect(reactivationPatch.status).toBe('DISMISSED');
  });

  it('stamps seenAt when marking as seen', async () => {
    const app = await buildApp();
    await request(app)
      .patch('/api/deals/deal-1/reactivations/react-1')
      .send({ status: 'SEEN' });

    expect(reactivationPatch.seenAt).toBeTruthy();
  });

  it('rejects an unknown status', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/api/deals/deal-1/reactivations/react-1')
      .send({ status: 'BANANA' });

    expect(res.status).toBe(400);
    expect(reactivationPatch).toBeNull();
  });
});
