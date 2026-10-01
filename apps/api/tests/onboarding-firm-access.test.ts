/**
 * Invited teammates must not overwrite the org's firm profile during
 * onboarding (USERFLOW-SMOOTHING batch 2). Exercises the real onboarding
 * router with a chainable Supabase mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));
const runFirmResearch = vi.fn();
vi.mock('../src/services/agents/firmResearchAgent/index.js', () => ({
  runFirmResearch: (...a: unknown[]) => runFirmResearch(...a),
  runDeepResearch: vi.fn(),
}));
vi.mock('../src/services/agents/firmResearchAgent/deepResearchProgress.js', () => ({
  markStaleDeepResearchAsFailed: vi.fn(),
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/middleware/usageContext.js', () => ({
  runWithUsageContext: vi.fn(),
  resolveInternalUserId: vi.fn(),
}));
vi.mock('../src/services/managedAgents/firmResearchOrchestrator.js', () => ({
  runFirmResearchViaManagedAgents: vi.fn(),
}));

interface World {
  user: { id: string; role: string } | null;
  org: { createdBy: string | null; settings: Record<string, unknown> };
}

function setWorld(world: World) {
  resolver = (op) => {
    if (op.table === 'User' && op.action === 'select') {
      if (op.columns?.includes('onboardingStatus')) return { data: { onboardingStatus: null } };
      return { data: world.user };
    }
    if (op.table === 'Organization' && op.action === 'select') {
      return { data: { id: 'org-A', name: 'Acme', ...world.org } };
    }
    if (op.table === 'AuditLog') return { count: 0 };
    return { data: null };
  };
}

async function buildApp(meta: Record<string, unknown> = {}) {
  const { default: router } = await import('../src/routes/onboarding.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-1', email: 'x@acme.com', role: 'MEMBER', organizationId: 'org-A', user_metadata: meta };
    next();
  });
  app.use('/api/onboarding', router);
  return app;
}

const PROFILE = { firmProfile: { aum: '$10-50M', sectors: ['Software'] } };

beforeEach(() => {
  chain.calls.length = 0;
  runFirmResearch.mockReset();
});

describe('POST /api/onboarding/firm-profile access', () => {
  it('lets the founding user overwrite an existing firm profile', async () => {
    setWorld({ user: { id: 'u-founder', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: PROFILE } });
    const res = await request(await buildApp()).post('/api/onboarding/firm-profile').send({ aum: '<$1M' });
    expect(res.status).toBe(200);
    expect(chain.calls.some((c) => c.table === 'Organization' && c.action === 'update')).toBe(true);
  });

  it('blocks an invited member from overwriting an existing firm profile (403, no write)', async () => {
    setWorld({ user: { id: 'u-invitee', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: PROFILE } });
    const res = await request(await buildApp({ invited: true }))
      .post('/api/onboarding/firm-profile')
      .send({ aum: '<$1M' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FIRM_PROFILE_LOCKED');
    expect(chain.calls.some((c) => c.table === 'Organization' && c.action === 'update')).toBe(false);
  });

  it('lets an org ADMIN edit even when they were invited', async () => {
    setWorld({ user: { id: 'u-admin', role: 'ADMIN' }, org: { createdBy: 'u-founder', settings: PROFILE } });
    const res = await request(await buildApp({ invited: true }))
      .post('/api/onboarding/firm-profile')
      .send({ aum: '<$1M' });
    expect(res.status).toBe(200);
  });

  it('lets anyone set the profile while the org has none yet', async () => {
    setWorld({ user: { id: 'u-invitee', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: {} } });
    const res = await request(await buildApp({ invited: true }))
      .post('/api/onboarding/firm-profile')
      .send({ aum: '<$1M' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/onboarding/enrich-firm access', () => {
  it('blocks an invited member from re-running research over an existing profile', async () => {
    setWorld({ user: { id: 'u-invitee', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: PROFILE } });
    const res = await request(await buildApp({ invited: true }))
      .post('/api/onboarding/enrich-firm')
      .send({ websiteUrl: 'https://acme.com' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FIRM_PROFILE_LOCKED');
    expect(runFirmResearch).not.toHaveBeenCalled();
  });
});

describe('GET /api/onboarding/status context', () => {
  it('flags an invited member so the web app can shorten onboarding', async () => {
    setWorld({ user: { id: 'u-invitee', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: PROFILE } });
    const res = await request(await buildApp({ invited: true })).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.context).toMatchObject({
      invited: true,
      firmProfileSet: true,
      canEditFirmProfile: false,
      isAdmin: false,
    });
  });

  it('reports the founder as not invited and able to edit', async () => {
    setWorld({ user: { id: 'u-founder', role: 'MEMBER' }, org: { createdBy: 'u-founder', settings: {} } });
    const res = await request(await buildApp()).get('/api/onboarding/status');
    expect(res.body.context).toMatchObject({ invited: false, firmProfileSet: false, canEditFirmProfile: true });
  });
});
