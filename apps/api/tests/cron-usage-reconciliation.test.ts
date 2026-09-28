/**
 * Daily Anthropic usage reconciliation sweep — GET|POST
 * /api/cron/usage-reconciliation. Auth is the shared CRON_SECRET, same
 * shape as cron-reactivation. Vercel invokes crons via GET; POST is kept
 * for manual/test triggering (see cron-reactivation.ts's "accept GET on
 * every scheduled job route" fix).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const reconcileAnthropicDay = vi.fn();
vi.mock('../src/services/usage/anthropicReconciliation.js', () => ({
  reconcileAnthropicDay: (...args: any[]) => reconcileAnthropicDay(...args),
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-usage-reconciliation.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/usage-reconciliation', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.CRON_SECRET = 'test-secret';
  reconcileAnthropicDay.mockResolvedValue({
    day: '2026-09-28',
    provider: 'anthropic',
    ledgerCostUsd: 10,
    providerCostUsd: 10,
    driftUsd: 0,
    driftPct: 0,
    ledgerTokens: 1000,
    providerTokens: 1000,
    breakdown: {},
    persisted: true,
    alerted: false,
  });
});

describe('GET /api/cron/usage-reconciliation', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/cron/usage-reconciliation');
    expect(res.status).toBe(401);
    expect(reconcileAnthropicDay).not.toHaveBeenCalled();
  });

  it('401s when CRON_SECRET is unset entirely', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation')
      .set('Authorization', 'Bearer whatever');
    expect(res.status).toBe(401);
  });

  it('200s with the correct secret and reconciles yesterday (UTC) by default', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(reconcileAnthropicDay).toHaveBeenCalledTimes(1);
    const calledDay = reconcileAnthropicDay.mock.calls[0][0] as string;
    expect(calledDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const now = new Date();
    const expectedYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
      .toISOString()
      .slice(0, 10);
    expect(calledDay).toBe(expectedYesterday);
  });
});

describe('POST /api/cron/usage-reconciliation', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/cron/usage-reconciliation');
    expect(res.status).toBe(401);
  });

  it('200s with the correct secret', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/usage-reconciliation')
      .set('Authorization', 'Bearer test-secret');
    expect(res.status).toBe(200);
    expect(reconcileAnthropicDay).toHaveBeenCalledTimes(1);
  });
});

describe('?day= override', () => {
  it('reconciles the explicitly requested day instead of yesterday', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation?day=2026-01-15')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(reconcileAnthropicDay).toHaveBeenCalledWith('2026-01-15');
  });

  it('falls back to yesterday for a malformed day override', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation?day=not-a-date')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    const calledDay = reconcileAnthropicDay.mock.calls[0][0] as string;
    expect(calledDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calledDay).not.toBe('not-a-date');
  });
});

describe('response shapes', () => {
  it('passes through a { skipped: "no_admin_key" } result without erroring', async () => {
    reconcileAnthropicDay.mockResolvedValue({ skipped: 'no_admin_key' });
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('no_admin_key');
  });

  it('returns 500 when reconcileAnthropicDay throws', async () => {
    reconcileAnthropicDay.mockRejectedValue(new Error('Admin API 401'));
    const app = await buildApp();
    const res = await request(app)
      .get('/api/cron/usage-reconciliation')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(500);
  });
});
