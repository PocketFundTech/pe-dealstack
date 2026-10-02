/** QA #16: deactivated users (isActive=false) could still sign in and use the API. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let userRow: any;
let firstSelectError: any = null;
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => ({
      select: (cols: string) => ({
        eq: () => ({
          single: async () => {
            if (firstSelectError && cols.includes('isActive')) return { data: null, error: firstSelectError };
            return { data: userRow, error: null };
          },
        }),
      }),
    }),
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/services/userService.js', () => ({ findOrCreateUser: async () => null }));

const { orgMiddleware } = await import('../src/middleware/orgScope.js');

function app() {
  const a = express();
  a.use((req: any, _r, next) => { req.user = { id: `auth-${Math.random()}`, role: 'MEMBER' }; next(); });
  a.use(orgMiddleware);
  a.get('/x', (req: any, res) => res.json({ org: req.user.organizationId }));
  return a;
}

beforeEach(() => { firstSelectError = null; });

describe('orgMiddleware deactivated-account check', () => {
  it('blocks a deactivated user with 403 ACCOUNT_DEACTIVATED', async () => {
    userRow = { id: 'u1', organizationId: 'o1', role: 'MEMBER', isActive: false };
    const res = await request(app()).get('/x');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('lets active users (and rows without the flag) through', async () => {
    userRow = { id: 'u1', organizationId: 'o1', role: 'MEMBER', isActive: true };
    expect((await request(app()).get('/x')).body).toEqual({ org: 'o1' });
    userRow = { id: 'u1', organizationId: 'o1', role: 'MEMBER', isActive: null };
    expect((await request(app()).get('/x')).status).toBe(200);
  });

  it('never breaks requests if the isActive column is missing', async () => {
    firstSelectError = { code: '42703', message: 'column User.isActive does not exist' };
    userRow = { id: 'u1', organizationId: 'o1', role: 'MEMBER' };
    expect((await request(app()).get('/x')).body).toEqual({ org: 'o1' });
  });
});
