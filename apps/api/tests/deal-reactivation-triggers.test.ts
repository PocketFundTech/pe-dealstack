/**
 * Reactivation triggers wired into existing routes (spec §5.7):
 *   - PATCH /api/organizations/criteria stamps updatedAt (the signal the
 *     eligibility gate reads) and kicks a background sweep.
 *   - Moving a deal to PASSED records why and when, so the dormant state
 *     carries the context a partner needs six months later.
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

const sweepPassedDeals = vi.fn(async () => ({
  scanned: 0, eligible: 0, rescored: 0, reactivated: 0, failed: 0, truncated: false,
}));
vi.mock('../src/services/agents/dealReactivation/index.js', () => ({
  sweepPassedDeals: (...args: any[]) => sweepPassedDeals(...args),
}));

let orgSettings: any = {};
let settingsPatch: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'Organization') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }),
        update: (patch: any) => {
          settingsPatch = patch;
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildCriteriaApp() {
  const { default: router } = await import('../src/routes/organization-criteria.js');
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgSettings = {};
  settingsPatch = null;
  mockSupabase.from.mockImplementation(tableMock());
});

const validCriteria = {
  sectorsInclude: ['Logistics'],
  sectorsExclude: [],
  dealSizeMin: null,
  dealSizeMax: null,
  revenueMin: null,
  revenueMax: null,
  ebitdaMin: 5,
  hardExclusions: [],
  thesis: 'Asset-light logistics roll-ups',
};

describe('PATCH /api/organizations/criteria', () => {
  it('stamps updatedAt so the eligibility gate can tell criteria changed', async () => {
    const app = await buildCriteriaApp();
    const res = await request(app).patch('/api/organizations/criteria').send(validCriteria);

    expect(res.status).toBe(200);
    expect(settingsPatch.settings.dealCriteria.updatedAt).toBeTruthy();
    expect(new Date(settingsPatch.settings.dealCriteria.updatedAt).getTime())
      .toBeLessThanOrEqual(Date.now());
  });

  it('preserves the criteria the user actually sent', async () => {
    const app = await buildCriteriaApp();
    await request(app).patch('/api/organizations/criteria').send(validCriteria);

    expect(settingsPatch.settings.dealCriteria).toMatchObject({
      ebitdaMin: 5,
      thesis: 'Asset-light logistics roll-ups',
    });
  });

  it('re-scores dormant deals against the new criteria in the background', async () => {
    const app = await buildCriteriaApp();
    await request(app).patch('/api/organizations/criteria').send(validCriteria);

    expect(sweepPassedDeals).toHaveBeenCalledWith('org-1', 'CRITERIA_CHANGED');
  });

  it('does not make the user wait for the sweep', async () => {
    // A firm with hundreds of passed deals must still get an instant save.
    let release: () => void = () => {};
    sweepPassedDeals.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ scanned: 0, eligible: 0, rescored: 0, reactivated: 0, failed: 0, truncated: false } as never); }),
    );

    const app = await buildCriteriaApp();
    const res = await request(app).patch('/api/organizations/criteria').send(validCriteria);

    expect(res.status).toBe(200);
    release();
  });

  it('still saves when the sweep blows up', async () => {
    sweepPassedDeals.mockRejectedValue(new Error('anthropic down'));
    const app = await buildCriteriaApp();
    const res = await request(app).patch('/api/organizations/criteria').send(validCriteria);

    expect(res.status).toBe(200);
    expect(settingsPatch.settings.dealCriteria).toBeTruthy();
  });

  it('rejects invalid criteria before touching anything', async () => {
    const app = await buildCriteriaApp();
    const res = await request(app)
      .patch('/api/organizations/criteria')
      .send({ ...validCriteria, thesis: 'x'.repeat(5000) });

    expect(res.status).toBe(400);
    expect(settingsPatch).toBeNull();
    expect(sweepPassedDeals).not.toHaveBeenCalled();
  });
});
