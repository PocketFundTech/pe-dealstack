/**
 * Owner-side deal share management — POST/GET/DELETE /api/deals/:dealId/shares.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

let insertedShare: any = null;
let insertedActivity: any = null;
let shares: any[] = [];
let views: any[] = [];
let revokePatch: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'DealShare') {
      return {
        insert: (row: any) => {
          insertedShare = row;
          return { select: () => ({ single: async () => ({ data: { id: 'share-1', ...row }, error: null }) }) };
        },
        select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: shares, error: null }) }) }) }),
        update: (patch: any) => {
          revokePatch = patch;
          return { eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) };
        },
      };
    }
    if (table === 'DealShareView') {
      return { select: () => ({ in: async () => ({ data: views, error: null }) }) };
    }
    if (table === 'Activity') {
      return { insert: async (row: any) => { insertedActivity = row; return { error: null }; } };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-share.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1' };
  insertedShare = null;
  insertedActivity = null;
  revokePatch = null;
  shares = [];
  views = [];
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.APP_URL;
});

describe('POST /api/deals/:dealId/shares', () => {
  it('creates a share with a 64-hex-char token, defaults all sections on, returns the portal URL', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/shares').send({ label: 'Healthcare partner' });

    expect(res.status).toBe(201);
    expect(insertedShare.token).toMatch(/^[0-9a-f]{64}$/);
    expect(insertedShare.includeFinancials).toBe(true);
    expect(insertedShare.includeDocuments).toBe(true);
    expect(insertedShare.includeMemos).toBe(true);
    expect(insertedShare.organizationId).toBe('org-1');
    expect(res.body.url).toContain(`/portal/${insertedShare.token}`);
    expect(insertedActivity).not.toBeNull(); // activity logged
  });

  it('respects section toggles and expiry preset', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/shares').send({ includeMemos: false, expiresInDays: 7 });
    expect(res.status).toBe(201);
    expect(insertedShare.includeMemos).toBe(false);
    expect(insertedShare.expiresAt).toBeTruthy();
    const daysOut = (new Date(insertedShare.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  it('404s for a deal outside the caller org', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/shares').send({});
    expect(res.status).toBe(404);
    expect(insertedShare).toBeNull();
  });

  it('400s on an invalid body', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/shares').send({ expiresInDays: 'soon' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/deals/:dealId/shares', () => {
  it('lists shares with aggregated view counts and last-viewed', async () => {
    shares = [
      { id: 'share-1', label: 'A', token: 't1', createdAt: 'x', revokedAt: null },
      { id: 'share-2', label: 'B', token: 't2', createdAt: 'y', revokedAt: null },
    ];
    views = [
      { shareId: 'share-1', viewedAt: '2026-08-01T00:00:00Z' },
      { shareId: 'share-1', viewedAt: '2026-08-05T00:00:00Z' },
    ];
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/shares');
    expect(res.status).toBe(200);
    const a = res.body.shares.find((s: any) => s.id === 'share-1');
    const b = res.body.shares.find((s: any) => s.id === 'share-2');
    expect(a.viewCount).toBe(2);
    expect(a.lastViewedAt).toBe('2026-08-05T00:00:00Z');
    expect(b.viewCount).toBe(0);
    expect(b.lastViewedAt).toBeNull();
  });
});

describe('DELETE /api/deals/:dealId/shares/:shareId', () => {
  it('soft-revokes by setting revokedAt', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/api/deals/deal-1/shares/share-1');
    expect(res.status).toBe(200);
    expect(revokePatch.revokedAt).toBeTruthy();
  });

  it('404s for a deal outside the caller org', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app).delete('/api/deals/deal-1/shares/share-1');
    expect(res.status).toBe(404);
    expect(revokePatch).toBeNull();
  });
});
