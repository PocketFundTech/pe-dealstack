/**
 * A missing CRON_SECRET must be LOUD, not silent.
 *
 * Both cron routes reject with 401 whether the caller sent a wrong secret
 * or the secret was never configured. That's correct for the response —
 * never leak configuration state to an unauthenticated caller — but it
 * means a misconfigured environment fails invisibly forever: reminders
 * never send, dormant deals never re-score, and no error is ever raised.
 *
 * So the two cases must be distinguishable in the LOGS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const logError = vi.fn();
const logInfo = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: (...a: any[]) => logInfo(...a), warn: vi.fn(), error: (...a: any[]) => logError(...a), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/services/agents/dealReactivation/index.js', () => ({
  sweepPassedDeals: vi.fn(async () => ({ scanned: 0, eligible: 0, rescored: 0, reactivated: 0, failed: 0, truncated: false })),
}));
vi.mock('../src/services/docRequestEmail.js', () => ({ sendDocRequestEmail: vi.fn(async () => true) }));
vi.mock('../src/services/docRequests.js', async (orig) => await orig());

const ROUTES = [
  ['reactivation', '../src/routes/cron-reactivation.js'],
  ['doc-request-reminders', '../src/routes/cron-doc-request-reminders.js'],
] as const;

async function buildApp(modulePath: string) {
  const { default: router } = await import(modulePath);
  const app = express();
  app.use(express.json());
  app.use('/cron', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES)('cron %s — missing CRON_SECRET', (name, modulePath) => {
  it('still returns a bare 401, leaking nothing about the configuration', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp(modulePath);
    const res = await request(app).post('/cron').set('Authorization', 'Bearer anything');

    expect(res.status).toBe(401);
    // The body must look identical to a wrong-secret rejection.
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(JSON.stringify(res.body)).not.toMatch(/CRON_SECRET|not set|misconfig/i);
  });

  it('logs an error so the misconfiguration is findable in Vercel logs', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp(modulePath);
    await request(app).post('/cron').set('Authorization', 'Bearer anything');

    expect(logError).toHaveBeenCalled();
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toMatch(/CRON_SECRET/);
  });

  it('does NOT log a misconfiguration error when the secret is merely wrong', async () => {
    // A wrong secret is a routine rejected request, not an ops problem —
    // logging it as an error would train people to ignore the real one.
    process.env.CRON_SECRET = 'correct-secret';
    const app = await buildApp(modulePath);
    await request(app).post('/cron').set('Authorization', 'Bearer wrong-secret');

    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toMatch(/CRON_SECRET is not set/);
  });
});
