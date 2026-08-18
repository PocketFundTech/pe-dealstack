/**
 * Passing a deal records WHY and WHEN (spec §5.8).
 *
 * The dormant state is only useful if it carries context: six months on,
 * "we passed because EBITDA was $2M against our $5M floor" is what makes a
 * reactivation alert actionable rather than noise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => ({ id: 'deal-1' })),
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { dealUpdated: vi.fn(), dealCreated: vi.fn(), dealDeleted: vi.fn() },
  logFromRequest: vi.fn(),
  AUDIT_ACTIONS: {}, RESOURCE_TYPES: {}, SEVERITY: {},
}));
vi.mock('../src/routes/notifications.js', () => ({
  notifyDealTeam: vi.fn(async () => undefined),
  resolveUserId: vi.fn(async () => null),
}));

let existingDeal: any;
let dealPatch: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: existingDeal, error: null }),
        update: (patch: any) => {
          dealPatch = patch;
          const upd: any = {
            eq: () => upd,
            select: () => upd,
            single: async () => ({ data: { ...existingDeal, ...patch }, error: null }),
          };
          return upd;
        },
      };
      return chain;
    }
    if (table === 'Activity') {
      return { insert: async () => ({ error: null }) };
    }
    if (table === 'DealTeamMember') {
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    }
    return {
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ error: null }),
    };
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1', organizationId: 'org-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealPatch = null;
  existingDeal = {
    id: 'deal-1', name: 'Meridian Logistics', organizationId: 'org-1',
    stage: 'DUE_DILIGENCE', updatedAt: '2026-08-01T00:00:00Z',
    passedAt: null, passReason: null, revisitAt: null,
  };
  mockSupabase.from.mockImplementation(tableMock());
});

describe('PATCH /api/deals/:id — passing a deal', () => {
  it('stamps passedAt when the stage becomes PASSED', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/api/deals/deal-1')
      .send({ stage: 'PASSED', passReason: 'EBITDA $2M vs our $5M floor' });

    expect(res.status).toBe(200);
    expect(dealPatch.passedAt).toBeTruthy();
    expect(dealPatch.passReason).toBe('EBITDA $2M vs our $5M floor');
  });

  it('accepts a revisit date', async () => {
    const app = await buildApp();
    await request(app)
      .patch('/api/deals/deal-1')
      .send({ stage: 'PASSED', revisitAt: '2027-02-18' });

    expect(dealPatch.revisitAt).toBe('2027-02-18');
  });

  it('rejects a malformed revisit date', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/api/deals/deal-1')
      .send({ stage: 'PASSED', revisitAt: 'next spring' });

    expect(res.status).toBe(400);
    expect(dealPatch).toBeNull();
  });

  it('does not re-stamp passedAt on an already-passed deal', async () => {
    existingDeal.stage = 'PASSED';
    existingDeal.passedAt = '2026-01-01T00:00:00Z';

    const app = await buildApp();
    await request(app).patch('/api/deals/deal-1').send({ passReason: 'Refined reason' });

    expect(dealPatch.passedAt).toBeUndefined();
    expect(dealPatch.passReason).toBe('Refined reason');
  });

  it('clears the dormant fields when a deal is revived out of PASSED', async () => {
    existingDeal.stage = 'PASSED';
    existingDeal.passedAt = '2026-01-01T00:00:00Z';
    existingDeal.passReason = 'Too small';
    existingDeal.revisitAt = '2026-08-01';

    const app = await buildApp();
    await request(app).patch('/api/deals/deal-1').send({ stage: 'DUE_DILIGENCE' });

    expect(dealPatch.passedAt).toBeNull();
    expect(dealPatch.revisitAt).toBeNull();
  });

  it('leaves passedAt alone for edits unrelated to stage', async () => {
    const app = await buildApp();
    await request(app).patch('/api/deals/deal-1').send({ name: 'Meridian Logistics II' });

    expect(dealPatch.passedAt).toBeUndefined();
  });
});
