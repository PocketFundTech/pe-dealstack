/**
 * Integration sync sweep — GET/POST /api/integrations/_cron/sync-all.
 * Vercel Cron always invokes via GET; POST is kept for manual/test triggering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const syncAll = vi.fn();
vi.mock('../src/integrations/_platform/syncEngine.js', () => ({ syncAll: (...args: any[]) => syncAll(...args) }));
vi.mock('../src/integrations/_platform/webhookRouter.js', () => ({ routeWebhook: vi.fn() }));
vi.mock('../src/integrations/_platform/registry.js', () => ({
  getProvider: vi.fn(),
  isProviderRegistered: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/integrations-public.js');
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
  syncAll.mockResolvedValue({ synced: 3, failed: 0 });
});

describe('GET/POST /api/integrations/_cron/sync-all', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/integrations/_cron/sync-all');
    expect(res.status).toBe(401);
    expect(syncAll).not.toHaveBeenCalled();
  });

  it('runs the sync via POST', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/integrations/_cron/sync-all')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, synced: 3, failed: 0 });
  });

  it('also responds to GET, matching how Vercel Cron actually invokes it', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/api/integrations/_cron/sync-all')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(syncAll).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ ok: true, synced: 3, failed: 0 });
  });

  it('401s on GET without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/integrations/_cron/sync-all');
    expect(res.status).toBe(401);
    expect(syncAll).not.toHaveBeenCalled();
  });
});
