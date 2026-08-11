import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const runSignalMonitorViaManagedAgents = vi.fn();
vi.mock('../src/services/managedAgents/signalMonitorOrchestrator.js', () => ({ runSignalMonitorViaManagedAgents }));

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-signal-scan.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/signal-scan', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/signal-scan', () => {
  it('rejects requests without a valid bearer token', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/cron/signal-scan').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('fans out to every active org and returns a summary', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Organization') throw new Error(`Unexpected table: ${table}`);
      return { select: () => ({ eq: async () => ({ data: [{ id: 'org-1' }, { id: 'org-2' }], error: null }) }) };
    });
    runSignalMonitorViaManagedAgents.mockResolvedValue({ status: 'completed' });

    const app = await buildApp();
    const res = await request(app).post('/api/cron/signal-scan').set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledTimes(2);
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledWith('org-1');
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledWith('org-2');
    expect(res.body).toEqual({ scanned: 2, failed: 0 });
  });

  it('continues past a single org failure and reports it in the summary', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: async () => ({ data: [{ id: 'org-1' }, { id: 'org-2' }], error: null }) }),
    }));
    runSignalMonitorViaManagedAgents.mockImplementation(async (orgId: string) =>
      orgId === 'org-1' ? { status: 'failed', error: 'boom' } : { status: 'completed' },
    );

    const app = await buildApp();
    const res = await request(app).post('/api/cron/signal-scan').set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 2, failed: 1 });
  });
});
