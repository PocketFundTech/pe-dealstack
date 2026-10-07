/** QA #16: a user deactivates their own account (POST /api/users/me/deactivate). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let me: any;
let otherAdmins = 0;
let countFilter: Record<string, unknown> = {};
const updates: Array<{ table: string; row: any }> = [];
const signOut = vi.fn(async () => ({ error: null }));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    auth: { admin: { signOut: (...a: any[]) => signOut(...(a as [])) } },
    from: (table: string) => {
      let counting = false;
      const b: any = {
        select: (_c: string, opts?: { head?: boolean }) => { counting = !!opts?.head; return b; },
        eq: (k: string, v: unknown) => { if (counting) countFilter[k] = v; return b; },
        in: (k: string, v: unknown) => { countFilter[k] = v; return b; },
        neq: () => (counting ? Promise.resolve({ count: otherAdmins, error: null }) : b),
        is: () => Promise.resolve({ error: null }),
        maybeSingle: async () => ({ data: me, error: null }),
        update: (row: any) => { updates.push({ table, row }); return b; },
        then: (res: any) => Promise.resolve({ error: null }).then(res),
      };
      return b;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { userUpdated: vi.fn(async () => {}) } }));
const invalidateUserContext = vi.fn();
vi.mock('../src/middleware/authContextCache.js', () => ({ invalidateUserContext: (id: string) => invalidateUserContext(id) }));

const { default: router } = await import('../src/routes/users-profile.js');
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { id: 'auth-1' }; next(); });
app.use('/api/users', router);

const post = (body: unknown) =>
  request(app).post('/api/users/me/deactivate').set('Authorization', 'Bearer jwt-abc').send(body as object);

beforeEach(() => {
  me = { id: 'u1', email: 'a@firm.com', role: 'MEMBER', organizationId: 'o1' };
  otherAdmins = 0;
  countFilter = {};
  updates.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/users/me/deactivate', () => {
  it('needs the typed confirmation', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ confirm: 'yes' })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('deactivates a member, revokes keys + integrations, and signs out everywhere', async () => {
    const res = await post({ confirm: 'DEACTIVATE' });
    expect(res.status).toBe(200);
    expect(updates.find((u) => u.table === 'User')?.row.isActive).toBe(false);
    expect(updates.find((u) => u.table === 'ApiKey')?.row.revokedAt).toBeTruthy();
    expect(updates.find((u) => u.table === 'Integration')?.row.status).toBe('revoked');
    expect(invalidateUserContext).toHaveBeenCalledWith('auth-1');
    expect(signOut).toHaveBeenCalledWith('jwt-abc', 'global');
  });

  it('blocks the last admin of the firm', async () => {
    me.role = 'ADMIN';
    const res = await post({ confirm: 'DEACTIVATE' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect(updates).toHaveLength(0);
    expect(countFilter.role).toEqual(expect.arrayContaining(['ADMIN', 'admin']));
  });

  it('lets an admin leave when another active admin remains', async () => {
    me.role = 'ADMIN';
    otherAdmins = 1;
    expect((await post({ confirm: 'DEACTIVATE' })).status).toBe(200);
    expect(countFilter).toMatchObject({ organizationId: 'o1', isActive: true });
  });
});
