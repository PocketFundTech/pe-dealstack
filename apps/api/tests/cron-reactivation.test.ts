/**
 * Nightly reactivation sweep — POST /api/cron/reactivation (spec §5.7).
 * Auth is the shared CRON_SECRET, same shape as cron-signal-scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const sweepPassedDeals = vi.fn();
vi.mock('../src/services/agents/dealReactivation/index.js', () => ({
  sweepPassedDeals: (...args: any[]) => sweepPassedDeals(...args),
}));

let orgs: any[] = [];

function tableMock() {
  return (table: string) => {
    if (table === 'Organization') {
      return { select: () => ({ eq: async () => ({ data: orgs, error: null }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-reactivation.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/reactivation', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgs = [{ id: 'org-1' }, { id: 'org-2' }];
  mockSupabase.from.mockImplementation(tableMock());
  sweepPassedDeals.mockResolvedValue({
    scanned: 10, eligible: 2, rescored: 2, reactivated: 1, failed: 0, truncated: false,
  });
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/reactivation', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    expect((await request(app).post('/api/cron/reactivation')).status).toBe(401);
    expect(sweepPassedDeals).not.toHaveBeenCalled();
  });

  it('sweeps every active org and totals the results', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reactivation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(sweepPassedDeals).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ orgs: 2, rescored: 4, reactivated: 2, failed: 0 });
  });

  it('keeps going when one org throws', async () => {
    sweepPassedDeals.mockRejectedValueOnce(new Error('supabase blip'));
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reactivation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.orgs).toBe(2);
    expect(res.body.failedOrgs).toBe(1);
  });

  it('surfaces truncation rather than reporting full coverage', async () => {
    sweepPassedDeals.mockResolvedValue({
      scanned: 400, eligible: 90, rescored: 25, reactivated: 3, failed: 0, truncated: true,
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reactivation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.body.truncatedOrgs).toBe(2);
  });
});
