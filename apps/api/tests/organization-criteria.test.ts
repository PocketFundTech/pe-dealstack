/**
 * GET/PUT /api/organizations/criteria — dealCriteria settings round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));

let orgSettings: Record<string, any> = {};
let lastUpdate: Record<string, any> | null = null;

function tableMock() {
  return (table: string) => {
    if (table !== 'Organization') throw new Error(`Unexpected table: ${table}`);
    return {
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }),
      update: (patch: any) => { lastUpdate = patch; return { eq: async () => ({ error: null }) }; },
    };
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/organization-criteria.js');
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgSettings = {};
  lastUpdate = null;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('GET /api/organizations/criteria', () => {
  it('returns null criteria when none are configured and no firmProfile exists', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ criteria: null, seededFromFirmProfile: false });
  });

  it('returns a firmProfile-seeded prefill (without persisting) when criteria are absent', async () => {
    orgSettings = { firmProfile: { sectors: ['SaaS', 'Healthcare'] } };
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.status).toBe(200);
    expect(res.body.seededFromFirmProfile).toBe(true);
    expect(res.body.criteria.sectorsInclude).toEqual(['SaaS', 'Healthcare']);
    expect(lastUpdate).toBeNull(); // read-time seeding only, nothing written
  });

  it('returns stored criteria verbatim when configured', async () => {
    orgSettings = { dealCriteria: { sectorsInclude: ['Industrial'], sectorsExclude: [], dealSizeMin: 5, dealSizeMax: 15, revenueMin: null, revenueMax: null, ebitdaMin: 1, hardExclusions: ['startups'], thesis: 'Boring businesses' } };
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.body.criteria.dealSizeMax).toBe(15);
    expect(res.body.seededFromFirmProfile).toBe(false);
  });
});

describe('PATCH /api/organizations/criteria', () => {
  it('validates and persists criteria into settings.dealCriteria, preserving other settings', async () => {
    orgSettings = { firmProfile: { sectors: ['SaaS'] } };
    const app = await buildApp();
    const body = {
      sectorsInclude: ['SaaS'], sectorsExclude: ['Retail'],
      dealSizeMin: 5, dealSizeMax: 15, revenueMin: null, revenueMax: null,
      ebitdaMin: 1, hardExclusions: ['startups', 'turnarounds'], thesis: 'Recurring revenue only',
    };
    const res = await request(app).patch('/api/organizations/criteria').send(body);
    expect(res.status).toBe(200);
    expect(lastUpdate!.settings.dealCriteria.thesis).toBe('Recurring revenue only');
    expect(lastUpdate!.settings.firmProfile).toEqual({ sectors: ['SaaS'] }); // untouched
  });

  it('rejects an invalid body with 400', async () => {
    const app = await buildApp();
    const res = await request(app).patch('/api/organizations/criteria').send({ dealSizeMin: 'not-a-number' });
    expect(res.status).toBe(400);
  });
});
