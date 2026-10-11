import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * POST /api/notifications only checked the target userId. A foreign dealId /
 * documentId was stored on the notification, and the notification list /
 * detail embeds Deal(id, name, stage) — leaking another org's deal name and
 * stage (and confirming the id exists).
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => mock.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: (req: any) => req.user.organizationId }));

const USER_A = '11111111-1111-4111-8111-111111111111';
const DEAL_A = '33333333-3333-4333-8333-333333333333';
const DEAL_B = '44444444-4444-4444-8444-444444444444';
const DOC_A = '55555555-5555-4555-8555-555555555555';
const DOC_B = '66666666-6666-4666-8666-666666666666';

const orgOf: Record<string, string> = { [USER_A]: 'org-A', [DEAL_A]: 'org-A', [DEAL_B]: 'org-B' };
const docDeal: Record<string, string> = { [DOC_A]: DEAL_A, [DOC_B]: DEAL_B };

async function buildApp() {
  const { default: router } = await import('../src/routes/notifications.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A' };
    next();
  });
  app.use('/api/notifications', router);
  return app;
}

beforeEach(() => {
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    const id = filterValue(op, 'id') as string;
    if ((op.table === 'User' || op.table === 'Deal') && op.action === 'select') {
      return orgOf[id] && orgOf[id] === filterValue(op, 'organizationId') ? { data: { id } } : { data: null };
    }
    if (op.table === 'Document' && op.action === 'select') {
      return docDeal[id] ? { data: { id, dealId: docDeal[id] } } : { data: null };
    }
    if (op.table === 'Notification' && op.action === 'insert') return { data: { id: 'n1' } };
    return { data: null };
  };
});

const inserted = () => mock.calls.filter((c) => c.table === 'Notification' && c.action === 'insert');
const base = { userId: USER_A, type: 'SYSTEM', title: 'Reminder' };

describe('POST /api/notifications — dealId / documentId must be in the caller org', () => {
  it('rejects a dealId from another org', async () => {
    const res = await request(await buildApp()).post('/api/notifications').send({ ...base, dealId: DEAL_B });
    expect(res.status).toBe(403);
    expect(inserted()).toHaveLength(0);
  });

  it('rejects a documentId from another org', async () => {
    const res = await request(await buildApp()).post('/api/notifications').send({ ...base, documentId: DOC_B });
    expect(res.status).toBe(403);
    expect(inserted()).toHaveLength(0);
  });

  it('accepts a dealId and documentId from the caller org', async () => {
    const res = await request(await buildApp()).post('/api/notifications').send({ ...base, dealId: DEAL_A, documentId: DOC_A });
    expect([201, 202]).toContain(res.status);
  });
});
