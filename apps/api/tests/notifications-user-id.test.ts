/**
 * The notification panel sends the Supabase *auth* id. GET /notifications
 * translated it to the internal User.id, but mark-all-read and bulk delete
 * compared it straight against User.id, found nothing, and answered 403
 * "outside your organization" — for every user (live QA 2026-09-30).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const users = [{ id: '11111111-1111-4111-8111-111111111111', authId: '22222222-2222-4222-8222-222222222222', organizationId: 'org-A' }];
const notificationWrites: Array<{ op: string; filters: Record<string, unknown> }> = [];

function userTable() {
  const filters: Record<string, unknown> = {};
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { filters[col] = val; return q; },
    single: async () => {
      const row = users.find((u) => Object.entries(filters).every(([k, v]) => (u as any)[k] === v));
      return row ? { data: { id: row.id }, error: null } : { data: null, error: { code: 'PGRST116' } };
    },
  };
  return q;
}
function notificationTable() {
  const filters: Record<string, unknown> = {};
  let op = '';
  const q: any = {
    update: () => { op = 'update'; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (col: string, val: unknown) => { filters[col] = val; return q; },
    then: (resolve: (v: unknown) => void) => { notificationWrites.push({ op, filters: { ...filters } }); resolve({ error: null }); },
  };
  return q;
}

vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => (t === 'User' ? userTable() : notificationTable()) },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: (req: any) => req.user.organizationId }));

async function buildApp(orgId = 'org-A') {
  const { default: router } = await import('../src/routes/notifications.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: '22222222-2222-4222-8222-222222222222', organizationId: orgId }; next(); });
  app.use('/api/notifications', router);
  return app;
}

beforeEach(() => { notificationWrites.length = 0; });

describe('notification bulk actions accept the auth id the client sends', () => {
  it('mark-all-read resolves the auth id and marks that user\'s notifications', async () => {
    const res = await request(await buildApp()).post('/api/notifications/mark-all-read').send({ userId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(200);
    expect(notificationWrites).toEqual([{ op: 'update', filters: { userId: '11111111-1111-4111-8111-111111111111', isRead: false } }]);
  });

  it('bulk delete resolves the auth id too', async () => {
    const res = await request(await buildApp()).delete('/api/notifications?userId=22222222-2222-4222-8222-222222222222&readOnly=true');
    expect(res.status).toBe(204);
    expect(notificationWrites).toEqual([{ op: 'delete', filters: { userId: '11111111-1111-4111-8111-111111111111', isRead: true } }]);
  });

  it('still accepts the internal id', async () => {
    const res = await request(await buildApp()).post('/api/notifications/mark-all-read').send({ userId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(200);
  });

  it('still refuses a user from another org', async () => {
    const res = await request(await buildApp('org-B')).post('/api/notifications/mark-all-read').send({ userId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(403);
    expect(notificationWrites).toEqual([]);
  });
});
