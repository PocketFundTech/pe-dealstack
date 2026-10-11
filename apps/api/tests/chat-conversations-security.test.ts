import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * F-17 (UNGUARDED_SELECTS_AUDIT): a Conversation with no dealId skipped the
 * org check entirely, so any signed-in user could read / post into / delete
 * another org's deal-less conversation by id. Deal-less conversations are
 * now owned through Conversation.userId -> User.organizationId, and the
 * create path refuses a userId from another org.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => mock.from(t) },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/openai.js', () => ({
  openai: null,
  isAIEnabled: () => false,
  trackedChatCompletion: vi.fn(),
}));

const verifyDealAccess = vi.fn();
const verifyConversationAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user.organizationId,
  verifyDealAccess: (...a: unknown[]) => verifyDealAccess(...a),
  verifyConversationAccess: (...a: unknown[]) => verifyConversationAccess(...a),
}));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const usersByOrg: Record<string, string> = { [USER_A]: 'org-A', [USER_B]: 'org-B' };

/** Resolves User lookups by (id, organizationId) the way Postgres would. */
function userRow(op: ChainOp): ChainResult {
  const id = filterValue(op, 'id') as string;
  const org = filterValue(op, 'organizationId') as string | undefined;
  if (!usersByOrg[id]) return { data: null, error: { code: 'PGRST116' } };
  if (org !== undefined && usersByOrg[id] !== org) return { data: null, error: { code: 'PGRST116' } };
  return { data: { id, organizationId: usersByOrg[id] } };
}

const orgBOrphan = {
  id: 'conv-b',
  dealId: null,
  userId: USER_B,
  title: 'Org B private chat',
  Deal: null,
  ChatMessage: [{ id: 'm1', role: 'user', content: 'org B secret', createdAt: '2026-10-01' }],
};

async function buildApp(orgId = 'org-A') {
  const { default: router } = await import('../src/routes/chat.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: orgId };
    next();
  });
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock = makeSupabaseChainMock((op) => resolver(op));
  verifyDealAccess.mockResolvedValue(null);
});

describe('F-17 — deal-less conversations are scoped to the owner org', () => {
  it('GET /conversations/:id returns 404 for another org\'s deal-less conversation', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation') return { data: orgBOrphan };
      if (op.table === 'User') return userRow(op);
      return {};
    };
    const res = await request(await buildApp('org-A')).get('/api/conversations/conv-b');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('org B secret');
  });

  it('GET /conversations/:id still returns the caller org\'s own deal-less conversation', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation') return { data: orgBOrphan };
      if (op.table === 'User') return userRow(op);
      return {};
    };
    const res = await request(await buildApp('org-B')).get('/api/conversations/conv-b');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('conv-b');
  });

  it('DELETE /conversations/:id refuses another org\'s deal-less conversation and deletes nothing', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation' && op.action === 'select') return { data: { dealId: null, userId: USER_B } };
      if (op.table === 'User') return userRow(op);
      return {};
    };
    const res = await request(await buildApp('org-A')).delete('/api/conversations/conv-b');
    expect(res.status).toBe(404);
    expect(mock.calls.some((c) => c.action === 'delete')).toBe(false);
  });

  it('DELETE /conversations/:id returns 404 for a conversation that does not exist', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation' && op.action === 'select') return { data: null, error: { code: 'PGRST116' } };
      return {};
    };
    const res = await request(await buildApp('org-A')).delete('/api/conversations/nope');
    expect(res.status).toBe(404);
    expect(mock.calls.some((c) => c.action === 'delete')).toBe(false);
  });

  it('POST /conversations/:id/messages refuses another org\'s deal-less conversation and writes nothing', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation' && op.action === 'select') return { data: orgBOrphan };
      if (op.table === 'User') return userRow(op);
      return {};
    };
    const res = await request(await buildApp('org-A'))
      .post('/api/conversations/conv-b/messages')
      .send({ content: 'hi', userId: USER_A });
    expect(res.status).toBe(404);
    expect(mock.calls.some((c) => c.action === 'insert' || c.action === 'update')).toBe(false);
  });

  it('POST /conversations rejects a userId from another org', async () => {
    resolver = (op) => {
      if (op.table === 'User') return userRow(op);
      if (op.table === 'Conversation') return { data: { id: 'new' } };
      return {};
    };
    const res = await request(await buildApp('org-A'))
      .post('/api/conversations')
      .send({ userId: USER_B, title: 'x' });
    expect(res.status).toBe(400);
    expect(mock.calls.some((c) => c.table === 'Conversation' && c.action === 'insert')).toBe(false);
  });

  it('POST /conversations accepts a userId in the caller\'s org', async () => {
    resolver = (op) => {
      if (op.table === 'User') return userRow(op);
      if (op.table === 'Conversation') return { data: { id: 'new', userId: USER_A } };
      return {};
    };
    const res = await request(await buildApp('org-A'))
      .post('/api/conversations')
      .send({ userId: USER_A, title: 'x' });
    expect(res.status).toBe(201);
  });
});
