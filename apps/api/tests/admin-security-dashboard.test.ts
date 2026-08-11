import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/supabase.js', () => {
  const mock = {
    from: vi.fn(),
    schema: vi.fn(() => mock),
  };
  return { supabase: mock };
});

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: vi.fn(() => 'org-1'),
}));

vi.mock('../src/services/auditLog.js', () => ({
  getAuditLogs: vi.fn(),
  AUDIT_ACTIONS: {
    STAFF_ACCESS: 'STAFF_ACCESS',
    LOGIN_FAILED: 'LOGIN_FAILED',
    DEAL_VIEWED: 'DEAL_VIEWED',
    USER_INVITED: 'USER_INVITED',
    USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
    USER_DELETED: 'USER_DELETED',
    SETTINGS_CHANGED: 'SETTINGS_CHANGED',
    ORG_MFA_REQUIRED: 'ORG_MFA_REQUIRED',
    ORG_MFA_NOT_REQUIRED: 'ORG_MFA_NOT_REQUIRED',
    SECURITY_TEST_RUN: 'SECURITY_TEST_RUN',
    STAFF_WEBHOOK_TEST: 'STAFF_WEBHOOK_TEST',
  },
}));

import dashboardRouter from '../src/routes/admin-security-dashboard.js';
import { supabase } from '../src/supabase.js';
import { getAuditLogs } from '../src/services/auditLog.js';

function buildApp(role: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = {
      id: 'u1',
      email: 'admin@example.com',
      organizationId: 'org-1',
      role,
    };
    next();
  });
  app.use('/api/admin/security', dashboardRouter);
  return app;
}

function configureSupabaseMocks(opts: {
  users?: any[] | null;
  sessions?: any[] | null;
  org?: any;
  membersCount?: number;
}) {
  // User table: two query shapes — "select(cols).eq(...)" returning rows,
  // and "select(cols, {count, head}).eq(...)" awaiting to a count.
  const userQuery: any = {
    select: vi.fn().mockImplementation((_cols: string, options?: any) => {
      if (options?.count === 'exact') {
        return {
          eq: vi.fn().mockResolvedValue({ count: opts.membersCount ?? 0, error: null }),
        };
      }
      return {
        eq: vi.fn().mockResolvedValue({ data: opts.users ?? [], error: null }),
      };
    }),
  };

  const sessionsQuery: any = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: opts.sessions ?? [], error: null }),
  };

  const orgQuery: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: opts.org ?? { requireMFA: false }, error: null }),
  };

  (supabase.from as any).mockImplementation((table: string) => {
    if (table === 'User') return userQuery;
    if (table === 'sessions') return sessionsQuery;
    if (table === 'Organization') return orgQuery;
    return userQuery;
  });
  (supabase as any).schema.mockReturnValue({
    from: (table: string) => {
      if (table === 'sessions') return sessionsQuery;
      return userQuery;
    },
  });
}

describe('GET /api/admin/security/dashboard', () => {
  beforeEach(() => {
    (getAuditLogs as any).mockReset();
    (getAuditLogs as any).mockResolvedValue({ data: [], count: 0, error: null });
    configureSupabaseMocks({ membersCount: 5, sessions: [], users: [], org: { requireMFA: false } });
  });

  it('returns 403 for non-admin role', async () => {
    const app = buildApp('member');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin role required' });
  });

  it('returns the dashboard structure for admin', async () => {
    const app = buildApp('admin');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.members.total).toBe(5);
    expect(res.body.members.requireMFA).toBe(false);
    expect(res.body.staffAccess).toEqual({ windowDays: 90, count: 0 });
    expect(res.body.failedLogins).toEqual({ windowDays: 7, count: 0 });
    expect(res.body.adminActions.windowDays).toBe(30);
    expect(res.body.adminActions.total).toBe(0);
    expect(res.body.adminActions.recent).toEqual([]);
    expect(res.body.topDeals).toEqual([]);
  });

  it('returns dashboard for partner role too', async () => {
    const app = buildApp('partner');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(200);
  });

  it('returns dashboard for principal role too', async () => {
    const app = buildApp('principal');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(200);
  });

  it('aggregates top deals from DEAL_VIEWED events', async () => {
    (getAuditLogs as any).mockImplementation((opts: any) => {
      if (opts.action === 'DEAL_VIEWED') {
        return Promise.resolve({
          data: [
            { entityId: 'deal-A', entityName: 'Acme', userId: 'u1', createdAt: '2026-05-07T10:00:00Z' },
            { entityId: 'deal-A', entityName: 'Acme', userId: 'u2', createdAt: '2026-05-07T09:00:00Z' },
            { entityId: 'deal-A', entityName: 'Acme', userId: 'u1', createdAt: '2026-05-06T09:00:00Z' },
            { entityId: 'deal-B', entityName: 'Beta', userId: 'u1', createdAt: '2026-05-06T11:00:00Z' },
          ],
          count: 4,
          error: null,
        });
      }
      return Promise.resolve({ data: [], count: 0, error: null });
    });

    const app = buildApp('admin');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.topDeals).toHaveLength(2);
    expect(res.body.topDeals[0]).toMatchObject({
      dealId: 'deal-A',
      dealName: 'Acme',
      views: 3,
      uniqueViewers: 2,
    });
    expect(res.body.topDeals[1]).toMatchObject({
      dealId: 'deal-B',
      views: 1,
      uniqueViewers: 1,
    });
  });

  it('gracefully degrades activeSessions to null when sessions query fails', async () => {
    configureSupabaseMocks({ membersCount: 5, users: [{ authId: 'auth-1' }], org: { requireMFA: true } });
    // Override schema().from('sessions') to error
    (supabase as any).schema.mockReturnValue({
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { message: 'auth schema not exposed' } }),
        }),
      }),
    });
    const app = buildApp('admin');
    const res = await request(app).get('/api/admin/security/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.activeSessions).toBeNull();
    expect(res.body.members.requireMFA).toBe(true);
  });
});
