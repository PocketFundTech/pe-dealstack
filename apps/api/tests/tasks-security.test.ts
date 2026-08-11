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
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: vi.fn(),
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { log: vi.fn() },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  PERMISSIONS: { DEAL_ASSIGN: 'deal.assign', ADMIN_SETTINGS: 'admin.settings' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(async () => {}),
  resolveUserId: vi.fn(async () => 'creator-1'),
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/tasks.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/tasks', router);
  return app;
};

describe('POST /api/tasks — cross-org reference protection (F-22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('rejects when dealId belongs to another org', async () => {
    verifyDealAccess.mockResolvedValue(null); // cross-org deal
    let taskInsertCalled = false;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Task') {
        return {
          insert: () => {
            taskInsertCalled = true;
            return {
              select: () => ({
                single: async () => ({ data: { id: 'task-1' }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/tasks').send({
      title: 'Do the thing',
      dealId: '11111111-1111-1111-1111-111111111111',
    });

    expect(res.status).toBe(400);
    expect(taskInsertCalled).toBe(false);
    expect(verifyDealAccess).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'org-A'
    );
  });

  it('rejects when assignedTo is a user in another org', async () => {
    let userLookupFilters: { col: string; val: string }[] = [];
    let taskInsertCalled = false;
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
      if (table === 'Task') {
        return {
          insert: () => {
            taskInsertCalled = true;
            return {
              select: () => ({
                single: async () => ({ data: { id: 'task-1' }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/tasks').send({
      title: 'Do the thing',
      assignedTo: '22222222-2222-2222-2222-222222222222',
    });

    expect(res.status).toBe(400);
    expect(taskInsertCalled).toBe(false);
    const cols = userLookupFilters.map((f) => f.col);
    expect(cols).toContain('organizationId');
  });

  it('creates the task when dealId + assignedTo are both same-org', async () => {
    verifyDealAccess.mockResolvedValue({ id: 'deal-A1', organizationId: 'org-A' });

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
      if (table === 'Task') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 'task-1', title: 'Do the thing', assignedTo: 'user-A1' },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/tasks').send({
      title: 'Do the thing',
      dealId: '33333333-3333-3333-3333-333333333333',
      assignedTo: '44444444-4444-4444-4444-444444444444',
    });

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/tasks/:id — cross-org reference protection (F-22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('rejects PATCH when body dealId belongs to another org', async () => {
    verifyDealAccess.mockResolvedValue(null); // cross-org
    let taskUpdateCalled = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Task') {
        return {
          // Pre-fetch returns existing task in same org
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 'task-1', organizationId: 'org-A', dealId: null, assignedTo: null },
                  error: null,
                }),
              }),
            }),
          }),
          update: () => {
            taskUpdateCalled = true;
            return {
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: async () => ({ data: { id: 'task-1' }, error: null }),
                  }),
                }),
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .patch('/api/tasks/task-1')
      .send({ dealId: '11111111-1111-1111-1111-111111111111' });

    expect(res.status).toBe(400);
    expect(taskUpdateCalled).toBe(false);
  });
});
