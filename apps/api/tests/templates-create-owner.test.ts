/**
 * POST /api/templates and /:id/duplicate must store the internal User.id in
 * MemoTemplate.createdBy (FK MemoTemplate_createdBy_fkey → User.id). They used
 * to store the Supabase auth UUID, which failed the FK and returned 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { inserts } = vi.hoisted(() => ({ inserts: [] as { table: string; row: any }[] }));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
      chain.insert = (row: any) => { inserts.push({ table, row }); return chain; };
      chain.single = async () => {
        if (table === 'MemoTemplate' && inserts.at(-1)?.table === 'MemoTemplate') {
          return { data: { id: 'tpl-new', ...inserts.at(-1)!.row }, error: null };
        }
        if (table === 'MemoTemplate') {
          return { data: { id: 'tpl-1', name: 'IC memo', organizationId: 'org-A', category: 'INVESTMENT_MEMO', permissions: 'FIRM_WIDE', sections: [] }, error: null };
        }
        return { data: null, error: null };
      };
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return chain;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));
vi.mock('../src/middleware/rbac.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  PERMISSIONS: {},
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('../src/routes/notifications.js', () => ({
  resolveUserId: vi.fn(async (authId: string) => (authId === 'auth-uuid-1' ? 'user-row-1' : null)),
}));

import router from '../src/routes/templates.js';

const app = express()
  .use(express.json())
  .use((req: any, _res, next) => { req.user = { id: 'auth-uuid-1', role: 'ADMIN' }; next(); })
  .use('/api/templates', router);

beforeEach(() => { inserts.length = 0; });

describe('template ownership', () => {
  it('create stores the internal User.id, not the auth UUID', async () => {
    const res = await request(app).post('/api/templates').send({ name: 'QA template' });
    expect(res.status).toBe(201);
    const row = inserts.find((i) => i.table === 'MemoTemplate')!.row;
    expect(row.createdBy).toBe('user-row-1');
  });

  it('duplicate stores the internal User.id too', async () => {
    await request(app).post('/api/templates/tpl-1/duplicate').send({ name: 'Copy' });
    const row = inserts.find((i) => i.table === 'MemoTemplate')?.row;
    expect(row?.createdBy).toBe('user-row-1');
  });
});
