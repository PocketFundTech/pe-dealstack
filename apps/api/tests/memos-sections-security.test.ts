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

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/memos-sections.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  // The sub-router is mounted under /api/memos in production.
  app.use('/api/memos', router);
  return app;
};

// Helper: chainable supabase mock fragments — each `.eq(col, val)` invocation
// records the (col,val) pair into `seenFilters`, then returns the chain. Tests
// inspect `seenFilters` afterwards to assert the bind is present.
type Filter = { col: string; val: any };

function makeMemoSelect(opts: { memoExists: boolean; orgId: string }) {
  // .from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single()
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          single: async () => ({
            data: opts.memoExists ? { id: 'memo-A' } : null,
            error: opts.memoExists ? null : { code: 'PGRST116' },
          }),
        }),
      }),
    }),
  };
}

describe('PATCH /api/memos/:id/sections/:sectionId — F-7 cross-memo bind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when sectionId does not belong to memo (cross-org write blocked)', async () => {
    const updateFilters: Filter[] = [];
    let updateInvoked = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return makeMemoSelect({ memoExists: true, orgId: 'org-A' });
      }
      if (table === 'MemoSection') {
        // Pre-check fetch path: .select().eq('id', sectionId).eq('memoId', id).single()
        // Update path:         .update().eq('id', sectionId).eq('memoId', id).select().single()
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              updateFilters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  updateFilters.push({ col: col2, val: val2 });
                  return {
                    single: async () => ({ data: null, error: { code: 'PGRST116' } }),
                  };
                },
              };
            },
          }),
          update: () => {
            updateInvoked = true;
            return {
              eq: (col: string, val: any) => {
                updateFilters.push({ col, val });
                return {
                  eq: (col2: string, val2: any) => {
                    updateFilters.push({ col: col2, val: val2 });
                    return {
                      select: () => ({
                        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .patch('/api/memos/memo-A/sections/section-from-other-memo')
      .send({ title: 'hijacked' });

    expect(res.status).toBe(404);
    // The pre-check fetch should have filtered on BOTH id AND memoId.
    const cols = updateFilters.map((f) => f.col).sort();
    expect(cols).toContain('memoId');
    expect(cols).toContain('id');
    // Update must NOT have run because pre-check returned null.
    expect(updateInvoked).toBe(false);
  });

  it('updates section when sectionId belongs to verified memo', async () => {
    const updateFilters: Filter[] = [];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return makeMemoSelect({ memoExists: true, orgId: 'org-A' });
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              updateFilters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  updateFilters.push({ col: col2, val: val2 });
                  return {
                    single: async () => ({
                      data: { id: 'section-A', memoId: 'memo-A' },
                      error: null,
                    }),
                  };
                },
              };
            },
          }),
          update: () => ({
            eq: (col: string, val: any) => {
              updateFilters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  updateFilters.push({ col: col2, val: val2 });
                  return {
                    select: () => ({
                      single: async () => ({
                        data: { id: 'section-A', memoId: 'memo-A', title: 'new title' },
                        error: null,
                      }),
                    }),
                  };
                },
              };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .patch('/api/memos/memo-A/sections/section-A')
      .send({ title: 'new title' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'section-A', memoId: 'memo-A', title: 'new title' });
    // Update must include a memoId filter
    const updateCols = updateFilters.map((f) => f.col);
    expect(updateCols).toContain('memoId');
  });
});
