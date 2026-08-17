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
// notifications.js is imported transitively by activities.ts
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(),
  notifyDealTeam: vi.fn(),
  resolveUserId: vi.fn(),
}));

// Spy on orgScope helpers
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/activities.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api', router);
  return app;
};

describe('GET /api/activities/:id — cross-tenant protection (F-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when activity belongs to a deal in another org', async () => {
    // Activity lookup returns the row (dealId points at another org's deal)
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'activity-1', dealId: 'deal-from-org-B' },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    verifyDealAccess.mockResolvedValue(null); // cross-org deal

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/activities/activity-1');

    expect(res.status).toBe(404);
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-B', 'org-A');
  });

  it('returns the activity when its deal belongs to the caller org', async () => {
    const fullActivity = {
      id: 'activity-1',
      dealId: 'deal-from-org-A',
      type: 'NOTE_ADDED',
      description: 'thesis snippet',
      metadata: { extracted: 'value' },
    };

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        // Single select('*') — the handler fetches once, then verifies the
        // parent deal's org before returning.
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: fullActivity, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    verifyDealAccess.mockResolvedValue({ id: 'deal-from-org-A', organizationId: 'org-A' });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/activities/activity-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fullActivity);
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-A', 'org-A');
  });

  it('returns 404 when activity does not exist', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/activities/does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/activities/recent — multi-tenant scoping (F-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('only returns activities for deals in caller org', async () => {
    // Two orgs: A and B. Deal-A1 belongs to org-A; activities for it should
    // be returned. Deal-B1 belongs to org-B and must not appear.
    const dealsForOrgA = [{ id: 'deal-A1' }];
    const orgAActivities = [
      { id: 'act-A1', dealId: 'deal-A1', type: 'NOTE_ADDED', title: 'A note' },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        // Single query scoped via the Deal!inner join — must filter on
        // deal.organizationId so cross-tenant rows never leak.
        return {
          select: (sel: string) => {
            expect(sel).toContain('Deal!inner');
            return {
              eq: (col: string, val: string) => {
                expect(col).toBe('deal.organizationId');
                expect(val).toBe('org-A');
                return {
                  order: () => ({
                    limit: () => Promise.resolve({ data: orgAActivities, error: null }),
                  }),
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/activities/recent');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(orgAActivities);
  });

  it('returns empty array when caller org has no deals', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        // Inner join yields no rows when the org owns no deals.
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/activities/recent');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /api/activities/:id — cross-tenant protection (F-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 and does not delete when activity belongs to another org', async () => {
    let deleteInvoked = false;
    let deleteIdFilter: string | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        return {
          // Pre-fetch dealId for the activity
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'activity-1', dealId: 'deal-from-org-B' },
                error: null,
              }),
            }),
          }),
          delete: () => {
            deleteInvoked = true;
            return {
              eq: (col: string, val: any) => {
                if (col === 'id') deleteIdFilter = val;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    verifyDealAccess.mockResolvedValue(null); // cross-org deal

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/activities/activity-1');

    expect(res.status).toBe(404);
    expect(deleteInvoked).toBe(false);
    expect(deleteIdFilter).toBe(null);
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-B', 'org-A');
  });

  it('returns 404 when activity does not exist', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/activities/does-not-exist');

    expect(res.status).toBe(404);
    expect(verifyDealAccess).not.toHaveBeenCalled();
  });

  it('deletes activity when its deal belongs to caller org', async () => {
    let deleteIdFilter: string | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Activity') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'activity-1', dealId: 'deal-from-org-A' },
                error: null,
              }),
            }),
          }),
          delete: () => ({
            eq: (col: string, val: any) => {
              if (col === 'id') deleteIdFilter = val;
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    verifyDealAccess.mockResolvedValue({ id: 'deal-from-org-A', organizationId: 'org-A' });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/activities/activity-1');

    expect(res.status).toBe(204);
    expect(deleteIdFilter).toBe('activity-1');
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-A', 'org-A');
  });
});
