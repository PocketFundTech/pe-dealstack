import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * POST /api/deals trusted body.companyId and body.assignedTo, and PATCH
 * /api/deals/:id trusted body.assignedTo. A foreign companyId linked the deal
 * to another org's Company (whose full row is embedded in every deal
 * response); a foreign assignedTo leaked that user's name + email and routed
 * stage-change emails about this org's deal to them.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => mock.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  PERMISSIONS: { DEAL_CREATE: 'deal.create', DEAL_DELETE: 'deal.delete' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user.organizationId,
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(async () => undefined),
  notifyDealTeam: vi.fn(async () => undefined),
  resolveUserId: vi.fn(async () => 'user-a'),
}));
vi.mock('../src/services/dealStageChangedEmail.js', () => ({ sendDealStageChangedEmail: vi.fn() }));
vi.mock('../src/services/outboundWebhooks.js', () => ({ emitWebhookEvent: vi.fn() }));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const owner: Record<string, string> = {
  'company-a': 'org-A', 'company-b': 'org-B', [USER_A]: 'org-A', [USER_B]: 'org-B',
};

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A', role: 'ADMIN' };
    next();
  });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    if ((op.table === 'Company' || op.table === 'User') && op.action === 'select') {
      const id = filterValue(op, 'id') as string;
      const org = filterValue(op, 'organizationId');
      return owner[id] && owner[id] === org ? { data: { id } } : { data: null, error: { code: 'PGRST116' } };
    }
    if (op.table === 'Deal' && op.action === 'select') {
      return { data: { id: 'deal-a', organizationId: 'org-A', stage: 'INITIAL_REVIEW', updatedAt: '2026-01-01' } };
    }
    if (op.table === 'Deal') return { data: { id: 'deal-a', name: 'D', ...(op.payload as object) } };
    return { data: null };
  };
});

const dealInserts = () => mock.calls.filter((c) => c.table === 'Deal' && c.action === 'insert');
const dealWrites = () => mock.calls.filter((c) => c.table === 'Deal' && (c.action === 'insert' || c.action === 'update'));

describe('POST /api/deals — referenced ids must be in the caller org', () => {
  it('rejects a companyId from another org', async () => {
    const res = await request(await buildApp()).post('/api/deals').send({ name: 'X', companyId: 'company-b' });
    expect(res.status).toBe(400);
    expect(dealInserts()).toHaveLength(0);
  });

  it('rejects an assignedTo user from another org', async () => {
    const res = await request(await buildApp()).post('/api/deals').send({ name: 'X', companyId: 'company-a', assignedTo: USER_B });
    expect(res.status).toBe(400);
    expect(dealInserts()).toHaveLength(0);
  });

  it('creates the deal when company and assignee are in the caller org', async () => {
    const res = await request(await buildApp()).post('/api/deals').send({ name: 'X', companyId: 'company-a', assignedTo: USER_A });
    expect(res.status).toBe(201);
    expect(dealInserts()).toHaveLength(1);
  });
});

describe('PATCH /api/deals/:id — assignedTo must be in the caller org', () => {
  it('rejects an assignedTo user from another org', async () => {
    const res = await request(await buildApp()).patch('/api/deals/deal-a').send({ assignedTo: USER_B });
    expect(res.status).toBe(400);
    expect(dealWrites()).toHaveLength(0);
  });

  it('allows an assignee in the caller org, and unassigning', async () => {
    const ok = await request(await buildApp()).patch('/api/deals/deal-a').send({ assignedTo: USER_A });
    expect(ok.status).toBe(200);
    const unassign = await request(await buildApp()).patch('/api/deals/deal-a').send({ assignedTo: null });
    expect(unassign.status).toBe(200);
  });
});
