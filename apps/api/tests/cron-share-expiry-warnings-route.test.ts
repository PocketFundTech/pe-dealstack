/**
 * Share-link expiry warning sweep — POST /api/cron/share-expiry-warnings.
 * Auth is the shared CRON_SECRET, same shape as cron-reactivation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetUserById = vi.fn();
const mockSupabase = {
  from: vi.fn(),
  auth: { admin: { getUserById: mockGetUserById } },
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendShareExpiryWarningEmail = vi.fn();
vi.mock('../src/services/shareExpiryWarningEmail.js', () => ({
  sendShareExpiryWarningEmail: (...args: any[]) => mockSendShareExpiryWarningEmail(...args),
}));

let shares: any[] = [];
let dealsById: Record<string, { name: string } | null> = {};
const selectCalls = { is: [] as any[], not: [] as any[], lte: [] as any[], gt: [] as any[] };
const updateCalls: Array<{ id: string; payload: any }> = [];

function dealShareSelectBuilder() {
  const builder: any = {
    is: (...args: any[]) => {
      selectCalls.is.push(args);
      return builder;
    },
    not: (...args: any[]) => {
      selectCalls.not.push(args);
      return builder;
    },
    lte: (...args: any[]) => {
      selectCalls.lte.push(args);
      return builder;
    },
    gt: (...args: any[]) => {
      selectCalls.gt.push(args);
      return builder;
    },
    then: (resolve: any) => resolve({ data: shares, error: null }),
  };
  return builder;
}

function dealShareUpdateBuilder(payload: any) {
  const builder: any = {
    eq: (_col: string, id: string) => {
      updateCalls.push({ id, payload });
      return builder;
    },
    then: (resolve: any) => resolve({ error: null }),
  };
  return builder;
}

function dealSelectBuilder() {
  let capturedId: string | undefined;
  const builder: any = {
    eq: (_col: string, id: string) => {
      capturedId = id;
      return builder;
    },
    single: () => builder,
    then: (resolve: any) => {
      const deal = capturedId ? dealsById[capturedId] : undefined;
      resolve(deal ? { data: deal, error: null } : { data: null, error: { message: 'not found' } });
    },
  };
  return builder;
}

function tableMock() {
  return (table: string) => {
    if (table === 'DealShare') {
      return {
        select: () => dealShareSelectBuilder(),
        update: (payload: any) => dealShareUpdateBuilder(payload),
      };
    }
    if (table === 'Deal') {
      return { select: () => dealSelectBuilder() };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-share-expiry-warnings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/share-expiry-warnings', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.is = [];
  selectCalls.not = [];
  selectCalls.lte = [];
  selectCalls.gt = [];
  updateCalls.length = 0;
  mockSupabase.from.mockImplementation(tableMock());
  mockSendShareExpiryWarningEmail.mockResolvedValue(true);
  process.env.CRON_SECRET = 'test-secret';

  shares = [
    {
      id: 'share-1',
      dealId: 'deal-1',
      label: 'Healthcare partner',
      createdBy: 'user-1',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  dealsById = { 'deal-1': { name: 'Project Falcon' } };
  mockGetUserById.mockImplementation(async (id: string) => {
    if (id === 'user-1') {
      return {
        data: { user: { id: 'user-1', email: 'owner@user.com', user_metadata: { full_name: 'Jamie Owner' } } },
        error: null,
      };
    }
    return { data: { user: null }, error: { message: 'not found' } };
  });
});

describe('POST /api/cron/share-expiry-warnings', () => {
  it('401s when CRON_SECRET is missing entirely', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp();
    const res = await request(app).post('/api/cron/share-expiry-warnings');
    expect(res.status).toBe(401);
    expect(mockSendShareExpiryWarningEmail).not.toHaveBeenCalled();
  });

  it('401s with a wrong bearer token', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/share-expiry-warnings')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(mockSendShareExpiryWarningEmail).not.toHaveBeenCalled();
  });

  it('queries only unrevoked, unwarned shares expiring within the next 48 hours', async () => {
    const app = await buildApp();
    await request(app).post('/api/cron/share-expiry-warnings').set('Authorization', 'Bearer test-secret');

    expect(selectCalls.is).toContainEqual(['revokedAt', null]);
    expect(selectCalls.is).toContainEqual(['expiryWarningSentAt', null]);
    expect(selectCalls.not).toContainEqual(['expiresAt', 'is', null]);
    expect(selectCalls.lte).toHaveLength(1);
    expect(selectCalls.gt).toHaveLength(1);

    const lteBoundary = new Date(selectCalls.lte[0][1]).getTime();
    const gtBoundary = new Date(selectCalls.gt[0][1]).getTime();
    const now = Date.now();
    // gt boundary is "now", lte boundary is "now + 48h" — allow generous slack
    // for test execution time.
    expect(gtBoundary).toBeLessThanOrEqual(now + 5000);
    expect(lteBoundary - gtBoundary).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(lteBoundary - gtBoundary).toBeLessThan(49 * 60 * 60 * 1000);
  });

  it('sends the warning email and stamps expiryWarningSentAt on success', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/share-expiry-warnings')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warningsSent: 1 });
    expect(mockSendShareExpiryWarningEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@user.com',
        name: 'Jamie Owner',
        dealName: 'Project Falcon',
        shareLabel: 'Healthcare partner',
      }),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('share-1');
    expect(updateCalls[0].payload.expiryWarningSentAt).toBeTruthy();
  });

  it('does not stamp expiryWarningSentAt when the send fails, so a later run retries', async () => {
    mockSendShareExpiryWarningEmail.mockResolvedValueOnce(false);
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/share-expiry-warnings')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warningsSent: 0 });
    expect(updateCalls).toHaveLength(0);
  });

  it('keeps going and still warns the other shares when one row fails (missing deal)', async () => {
    shares = [
      { id: 'share-bad', dealId: 'deal-missing', label: null, createdBy: 'user-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      { id: 'share-1', dealId: 'deal-1', label: 'Healthcare partner', createdBy: 'user-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    ];
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/share-expiry-warnings')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warningsSent: 1 });
    expect(mockSendShareExpiryWarningEmail).toHaveBeenCalledTimes(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('share-1');
  });

  it('skips a share whose creator lookup fails, without aborting the sweep', async () => {
    shares = [
      { id: 'share-orphan', dealId: 'deal-1', label: null, createdBy: 'user-ghost', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      { id: 'share-1', dealId: 'deal-1', label: 'Healthcare partner', createdBy: 'user-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    ];
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/share-expiry-warnings')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warningsSent: 1 });
  });
});
