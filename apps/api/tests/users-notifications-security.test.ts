import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks BEFORE importing the router
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// rbac middleware passes through
vi.mock('../src/middleware/rbac.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  PERMISSIONS: { USER_CREATE: 'user:create', USER_UPDATE: 'user:update', USER_DELETE: 'user:delete' },
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { log: vi.fn() },
}));
// users-profile sub-router is a no-op for these tests
vi.mock('../src/routes/users-profile.js', () => ({
  default: express.Router(),
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
  // global error handler so next(error) doesn't crash
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });
  return app;
};

describe('GET /api/users/:id/notifications — cross-tenant protection (F-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when target user belongs to another org', async () => {
    // The target user lookup must verify organizationId match.
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'User') {
        // .select('id').eq('id', id).eq('organizationId', orgId).single() → null
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: { code: 'PGRST116' } }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/users/user-from-org-B/notifications');

    expect(res.status).toBe(404);
  });

  it('returns notifications when target user is in caller org', async () => {
    const notifications = [
      { id: 'notif-1', userId: 'user-A', type: 'MENTION', message: 'hi' },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'User') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 'user-A', organizationId: 'org-A' },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'Notification') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: notifications, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/users/user-A/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(notifications);
  });
});
