import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  PERMISSIONS: { USER_CREATE: 'user.create', USER_UPDATE: 'user.update', USER_DELETE: 'user.delete' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    userCreated: vi.fn(),
    userUpdated: vi.fn(),
    userDeleted: vi.fn(),
  },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/users.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/users', router);
  return app;
};

describe('GET /api/users/:id/deals — cross-tenant protection (F-20)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when target user is in another org (no DealTeamMember leak)', async () => {
    let dealTeamMemberSelectCalled = false;
    let userLookupFilters: { col: string; val: string }[] = [];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'User') {
        const chain: any = {
          eq: (col: string, val: string) => {
            userLookupFilters.push({ col, val });
            return chain;
          },
          single: async () => ({ data: null, error: { code: 'PGRST116' } }),
        };
        return {
          select: () => chain,
        };
      }
      if (table === 'DealTeamMember') {
        return {
          select: () => {
            dealTeamMemberSelectCalled = true;
            return { eq: () => Promise.resolve({ data: [], error: null }) };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/users/user-from-org-B/deals');

    expect(res.status).toBe(404);
    expect(dealTeamMemberSelectCalled).toBe(false);
    // Pre-check uses an organizationId filter
    const cols = userLookupFilters.map((f) => f.col);
    expect(cols).toContain('organizationId');
  });

  it('returns memberships when target user belongs to caller org', async () => {
    const memberships = [
      {
        id: 'tm-1',
        role: 'OWNER',
        addedAt: '2026-01-01T00:00:00Z',
        Deal: {
          id: 'deal-A1',
          name: 'Acme',
          stage: 'DILIGENCE',
          status: 'ACTIVE',
          industry: 'SAAS',
          dealSize: 100,
          irrProjected: 0.3,
          Company: { id: 'co-1', name: 'Acme Inc', logo: null },
        },
      },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'User') {
        const chain: any = {
          eq: () => chain,
          single: async () => ({
            data: { id: 'user-A1', organizationId: 'org-A' },
            error: null,
          }),
        };
        return {
          select: () => chain,
        };
      }
      if (table === 'DealTeamMember') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: memberships, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/users/user-A1/deals');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(memberships);
  });
});
