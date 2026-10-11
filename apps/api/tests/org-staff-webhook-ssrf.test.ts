import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * PATCH /api/organizations/me/staff-access-webhook saved any URL and
 * immediately POSTed a test event to it from the server — a blind SSRF into
 * internal / cloud-metadata addresses. Private URLs are now refused, matching
 * the outbound webhook-subscriptions rule.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => mock.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: (req: any) => req.user.organizationId }));
vi.mock('../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => undefined),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  RESOURCE_TYPES: new Proxy({}, { get: (_t, k) => String(k) }),
  SEVERITY: new Proxy({}, { get: (_t, k) => String(k) }),
}));
const notifyStaffAccess = vi.fn(async () => undefined);
vi.mock('../src/services/staffAccessNotifier.js', () => ({
  notifyStaffAccess: (...a: unknown[]) => notifyStaffAccess(...(a as [])),
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/org-staff-webhook.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A', role: 'ADMIN' };
    next();
  });
  app.use('/api/organizations', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = () => ({ data: { id: 'org-A', name: 'A' } });
});

describe('PATCH /api/organizations/me/staff-access-webhook — no private URLs', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/hook',
    'http://10.0.0.5/hook',
    'http://localhost/hook',
  ])('refuses %s and never fires the test event', async (url) => {
    const res = await request(await buildApp())
      .patch('/api/organizations/me/staff-access-webhook')
      .send({ staffAccessWebhookUrl: url });
    expect(res.status).toBe(400);
    expect(notifyStaffAccess).not.toHaveBeenCalled();
    expect(mock.calls.some((c) => c.action === 'update')).toBe(false);
  });

  it('accepts a public Slack webhook URL', async () => {
    const res = await request(await buildApp())
      .patch('/api/organizations/me/staff-access-webhook')
      .send({ staffAccessWebhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' });
    expect(res.status).toBe(200);
  });
});
