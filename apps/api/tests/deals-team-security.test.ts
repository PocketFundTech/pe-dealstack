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
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(async () => {}),
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/deals-team.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/deals', router);
  return app;
};

describe('POST /api/deals/:id/team — userId org check (F-23)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('rejects when userId is a user in another org', async () => {
    verifyDealAccess.mockResolvedValue({ id: 'deal-A1', organizationId: 'org-A' });
    let dealTeamMemberInsertCalled = false;
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
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: { code: 'PGRST116' } }),
              }),
            }),
          }),
          insert: () => {
            dealTeamMemberInsertCalled = true;
            return {
              select: () => ({ single: async () => ({ data: { id: 'tm-1' }, error: null }) }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/deals/deal-A1/team').send({
      userId: '99999999-9999-9999-9999-999999999999',
      role: 'MEMBER',
    });

    expect(res.status).toBe(400);
    expect(dealTeamMemberInsertCalled).toBe(false);
    const cols = userLookupFilters.map((f) => f.col);
    expect(cols).toContain('organizationId');
  });

  it('adds the team member when userId is same-org', async () => {
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
      if (table === 'DealTeamMember') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: null, error: { code: 'PGRST116' } }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 'tm-1', role: 'MEMBER', addedAt: '2026-01-01T00:00:00Z' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'Activity') {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { name: 'Acme' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/deals/deal-A1/team').send({
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'MEMBER',
    });

    expect(res.status).toBe(201);
  });
});
