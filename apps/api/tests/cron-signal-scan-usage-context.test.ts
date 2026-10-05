// The nightly signal-scan cron runs per-org AI work with no requesting
// user. Before this fix, recordUsageEvent silently no-op'd ("no usage
// context bound") for every managed-agents call the cron triggered. This
// verifies the route now binds a runAsOrgSystem context around each org's
// work, so getUsageContext() is populated (and therefore any
// recordUsageEvent call inside the wrapped fn actually inserts) while it
// runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const { capturedContexts, runSignalMonitorViaManagedAgents } = vi.hoisted(() => {
  const capturedContexts: unknown[] = [];
  const runSignalMonitorViaManagedAgents = vi.fn(async () => {
    // Dynamic import so this resolves against the same (mocked-supabase)
    // module graph the route itself uses, instead of a static top-level
    // import that would race the vi.mock('../src/supabase.js', ...) setup
    // above (whose factory references `mockSupabase` before it's assigned).
    const { getUsageContext } = await import('../src/middleware/usageContext.js');
    capturedContexts.push(getUsageContext());
    return { status: 'completed' as const };
  });
  return { capturedContexts, runSignalMonitorViaManagedAgents };
});
vi.mock('../src/services/managedAgents/signalMonitorOrchestrator.js', () => ({ runSignalMonitorViaManagedAgents }));

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-signal-scan.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/signal-scan', router);
  return app;
}

describe('cron-signal-scan binds an org-system usage context per org', () => {
  beforeEach(() => {
    mockSupabase.from.mockReset();
    runSignalMonitorViaManagedAgents.mockClear();
    capturedContexts.length = 0;
    process.env.CRON_SECRET = 'test-secret';
  });

  it('runs each org under a bound usage context attributed to that org', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Organization') {
        return { select: () => ({ eq: async () => ({ data: [{ id: 'org-1' }], error: null }) }) };
      }
      if (table === 'User') {
        // runAsOrgSystem's admin lookup: pick(['ADMIN']) then pick(null)
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          limit: async () => ({ data: [{ id: 'admin-user-1' }] }),
        };
        return chain;
      }
      if (table === 'Deal') {
        // Idle-org check: this org has active deals, so it is scanned.
        const q: any = { select: () => q, eq: () => q, neq: () => q, then: (r: (v: unknown) => void) => r({ count: 3, error: null }) };
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp();
    const res = await request(app).post('/api/cron/signal-scan').set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledOnce();
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toMatchObject({
      userId: 'admin-user-1',
      organizationId: 'org-1',
      systemSource: 'cron:signal-scan',
    });
  });
});
