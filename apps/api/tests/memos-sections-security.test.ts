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

describe('DELETE /api/memos/:id/sections/:sectionId — F-8 cross-memo bind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when sectionId does not belong to memo (cross-org delete blocked)', async () => {
    const filters: Filter[] = [];
    let deleteInvoked = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return makeMemoSelect({ memoExists: true, orgId: 'org-A' });
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  filters.push({ col: col2, val: val2 });
                  return {
                    single: async () => ({ data: null, error: { code: 'PGRST116' } }),
                  };
                },
              };
            },
          }),
          delete: () => {
            deleteInvoked = true;
            return {
              eq: () => ({ eq: async () => ({ error: null }) }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/memos/memo-A/sections/section-from-other-memo');

    expect(res.status).toBe(404);
    expect(deleteInvoked).toBe(false);
    const cols = filters.map((f) => f.col);
    expect(cols).toContain('memoId');
  });

  it('deletes section when sectionId belongs to verified memo', async () => {
    const filters: Filter[] = [];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return makeMemoSelect({ memoExists: true, orgId: 'org-A' });
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  filters.push({ col: col2, val: val2 });
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
          delete: () => ({
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return {
                eq: async (col2: string, val2: any) => {
                  filters.push({ col: col2, val: val2 });
                  return { error: null };
                },
              };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/memos/memo-A/sections/section-A');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const deleteFilterCols = filters
      .filter((f) => f.col === 'memoId')
      .map((f) => f.val);
    // memoId filter must have been applied with the verified memo
    expect(deleteFilterCols).toContain('memo-A');
  });
});

describe('POST /api/memos/:id/sections/reorder — F-9 cross-memo bind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('does not update sections from a different memo', async () => {
    // Records every (sectionId, memoId-filter-or-null) that .update() was called with
    const updateAttempts: { sectionId: string; memoIdFilter: string | null }[] = [];

    const VALID_ID = '11111111-1111-1111-1111-111111111111';
    const STRANGER_ID = '22222222-2222-2222-2222-222222222222';

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return makeMemoSelect({ memoExists: true, orgId: 'org-A' });
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              // Pre-fetch valid section IDs for the memo (no .order()).
              if (col === 'memoId' && val === 'memo-A') {
                // Make this thenable for `await` AND chainable via .order()
                // for the post-reorder full fetch.
                const result = {
                  then: (resolve: any) =>
                    resolve({ data: [{ id: VALID_ID }], error: null }),
                  order: () => Promise.resolve({ data: [{ id: VALID_ID, sortOrder: 5 }], error: null }),
                };
                return result;
              }
              return { single: async () => ({ data: null, error: { code: 'PGRST116' } }) };
            },
          }),
          update: () => ({
            eq: (col: string, val: any) => {
              if (col !== 'id') {
                // Should not happen — first filter is always 'id'
                return { eq: async () => ({ error: null }) };
              }
              const sectionId = val;
              // Default to "no memoId filter applied" — the buggy code only
              // chains .eq('id', sid) once and returns a resolvable.
              let memoIdFilter: string | null = null;
              const after: any = {
                eq: async (col2: string, val2: any) => {
                  if (col2 === 'memoId') memoIdFilter = val2;
                  updateAttempts.push({ sectionId, memoIdFilter });
                  return { error: null };
                },
                then: (resolve: any) => {
                  // Buggy code path: await supabase.update().eq('id', ...)
                  updateAttempts.push({ sectionId, memoIdFilter });
                  resolve({ error: null });
                },
              };
              return after;
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/memos/memo-A/sections/reorder')
      .send({
        sections: [
          { id: VALID_ID, sortOrder: 5 },
          { id: STRANGER_ID, sortOrder: 6 },
        ],
      });

    expect(res.status).toBe(200);
    // Every recorded update attempt must (a) have a memoId filter AND
    // (b) target a sectionId that the verified memo actually owns.
    expect(updateAttempts.length).toBeGreaterThan(0);
    for (const attempt of updateAttempts) {
      expect(attempt.memoIdFilter).toBe('memo-A');
      expect(attempt.sectionId).toBe(VALID_ID);
    }
    // The stranger ID must not have been touched at all.
    const strangerHits = updateAttempts.filter((a) => a.sectionId === STRANGER_ID);
    expect(strangerHits).toEqual([]);
  });
});
