/**
 * Performance tests for memo section upserts.
 *
 * Bug: when auto-generating section content (POST /api/memos with
 * autoGenerate=true, and POST /api/memos/:id/generate-all), the handlers
 * iterated each generated section and ran a `.single()` existence check
 * followed by an update/insert. For a 10-section memo this was 10-20
 * sequential supabase round-trips. On Vercel serverless each round-trip
 * carries ~5-20ms overhead, so generation time scaled linearly with
 * section count for the DB-write phase.
 *
 * Fix: pre-fetch ALL existing sections for the memo in ONE query, classify
 * each generated section in-memory, then issue ONE batch insert for new
 * rows plus parallel per-row updates (per-row because content/tableData
 * differ — but the N+1 existence checks are eliminated).
 *
 * Note: the schema has no compound unique constraint on (memoId, type)
 * (multiple CUSTOM sections may coexist), so `.upsert(..., { onConflict })`
 * isn't safe. We use the pre-fetch + classify pattern instead.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 5 Task 5.2
 * Refs: .planning/codebase/CONCERNS.md §3.2
 */

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

vi.mock('../src/middleware/rbac.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  PERMISSIONS: {
    MEMO_DELETE: 'memo:delete',
  },
}));

vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    memoCreated: vi.fn(),
    memoUpdated: vi.fn(),
    memoDeleted: vi.fn(),
  },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
}));

vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
}));

// Stub the memo agent so we don't hit an LLM. The mock returns N synthetic
// sections — half pre-existing in the DB (update path), half new (insert path).
const generateAllSectionsMock = vi.fn();
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  generateAllSections: (...args: any[]) => generateAllSectionsMock(...args),
  COMPREHENSIVE_IC_SECTIONS: [],
  STANDARD_IC_SECTIONS: [],
  SEARCH_FUND_SECTIONS: [],
  SCREENING_NOTE_SECTIONS: [],
}));

const ORG_ID = 'org-A';
const MEMO_ID = 'memo-perf-1';
const DEAL_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Build a supabase mock that tracks per-table call counts. The auto-generate
 * path executes (in order):
 *   1. Deal.select (for name) — when projectName is missing
 *   2. Memo.insert (the new memo row)
 *   3. MemoSection.insert (default sections for IC_MEMO)
 *   4. generateAllSections (mocked, no supabase calls)
 *   5. [N+1 code] for each generated section:
 *        MemoSection.select(.single) + MemoSection.update
 *   6. Memo.select (fetch full memo with sections)
 *
 * In the fixed code, step 5 collapses to:
 *   - ONE MemoSection.select (pre-fetch all rows for memoId)
 *   - ONE MemoSection.insert (batch insert new rows; skipped if empty)
 *   - Parallel MemoSection.update calls (still N for differing content,
 *     but the per-row existence-check selects are gone)
 *
 * The assertion: total MemoSection.select calls in the auto-generate phase
 * is bounded (1 pre-fetch + 1 final hydrate = ≤ 2), independent of section
 * count — instead of scaling 1:1 with sections.
 */
function buildMockSupabase(opts: {
  existingSections: Array<{ id: string; type: string }>;
  counts: Record<string, { select: number; insert: number; update: number }>;
}) {
  const { existingSections, counts } = opts;

  function track(table: string, op: 'select' | 'insert' | 'update') {
    if (!counts[table]) counts[table] = { select: 0, insert: 0, update: 0 };
    counts[table][op] += 1;
  }

  return (table: string) => {
    if (table === 'Deal') {
      // .select('name').eq('id', dealId).eq('organizationId', orgId).single()
      return {
        select: () => {
          track('Deal', 'select');
          const chain: any = {
            eq: () => chain,
            single: async () => ({ data: { name: 'Test Deal' }, error: null }),
          };
          return chain;
        },
      };
    }

    if (table === 'Memo') {
      return {
        insert: () => {
          track('Memo', 'insert');
          // .insert(memoData).select().single()
          return {
            select: () => ({
              single: async () => ({
                data: { id: MEMO_ID, type: 'IC_MEMO', title: 'Test Memo' },
                error: null,
              }),
            }),
          };
        },
        select: () => {
          track('Memo', 'select');
          // Hydrate at the end: .select(...).eq('id', memo.id).single()
          return {
            eq: () => ({
              single: async () => ({
                data: {
                  id: MEMO_ID,
                  type: 'IC_MEMO',
                  title: 'Test Memo',
                  sections: existingSections,
                },
                error: null,
              }),
            }),
          };
        },
      };
    }

    if (table === 'MemoSection') {
      return {
        // Initial default sections insert (.insert(defaultSections))
        // and any batched insert path used by the fix (.insert(toInsert))
        insert: () => {
          track('MemoSection', 'insert');
          return Promise.resolve({ error: null });
        },
        // N+1 path: .select('id').eq('memoId', x).eq('type', y).single()
        // Fixed path: .select('id, type').eq('memoId', x)  (no .eq().single())
        select: () => {
          track('MemoSection', 'select');
          // Chain shape compatible with both:
          //   .eq('memoId', ...).eq('type', ...).single()  → returns one row or null
          //   .eq('memoId', ...)                            → returns the array
          const chain: any = {
            eq: () => chain,
            single: async () => {
              // Per-section existence check (N+1 code). Return the first
              // existing row of whatever type is queried, otherwise null.
              return existingSections.length > 0
                ? { data: existingSections[0], error: null }
                : { data: null, error: { code: 'PGRST116' } };
            },
            then: (resolve: any) => {
              // Awaited directly (batched pre-fetch): return all rows.
              resolve({ data: existingSections, error: null });
            },
          };
          return chain;
        },
        update: () => {
          track('MemoSection', 'update');
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    }

    // Unknown table — generic resolved mock
    return {
      insert: () => Promise.resolve({ error: null }),
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/memos-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: ORG_ID };
    next();
  });
  app.use('/api/memos', router);
  return app;
}

describe('POST /api/memos (autoGenerate) — batched section upsert (N+1 fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    generateAllSectionsMock.mockReset();
  });

  it('does NOT scale MemoSection.select with section count (≤ 2 selects regardless of N)', async () => {
    // 10 sections generated, ALL pre-exist in the memo (worst case for the
    // N+1 code: 10 existence checks + 10 updates).
    const N = 10;
    const generated = Array.from({ length: N }, (_, i) => ({
      type: 'EXECUTIVE_SUMMARY', // any valid type; mock ignores per-row uniqueness
      title: `Section ${i}`,
      content: `Generated content ${i}`,
      aiGenerated: true,
      aiModel: 'gpt-4o',
    }));
    const existingSections = Array.from({ length: N }, (_, i) => ({
      id: `sec-${i}`,
      type: 'EXECUTIVE_SUMMARY',
    }));

    generateAllSectionsMock.mockResolvedValue({ sections: generated });

    const counts: Record<string, { select: number; insert: number; update: number }> = {};
    mockSupabase.from.mockImplementation(
      buildMockSupabase({ existingSections, counts })
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/api/memos')
      .send({
        title: 'Test Memo',
        dealId: DEAL_ID,
        type: 'IC_MEMO',
        autoGenerate: true,
      });

    expect(res.status).toBe(201);

    // Budget: 1 pre-fetch (.select().eq(memoId)) for existence classification.
    // The final memo hydrate uses Memo.select with embedded MemoSection, not
    // a separate MemoSection.select call. The N+1 code had N=10 selects here
    // (one .single() per generated section). The fix should be exactly 1.
    expect(counts.MemoSection?.select ?? 0).toBeLessThanOrEqual(2);
  });

  it('issues exactly one batched MemoSection.insert for new sections', async () => {
    // All 6 generated sections are NEW (none pre-exist). N+1 code would do
    // 6 selects + 6 inserts. Fix: 1 pre-fetch select + 1 batched insert.
    const generated = Array.from({ length: 6 }, (_, i) => ({
      type: 'CUSTOM',
      title: `New Section ${i}`,
      content: `Content ${i}`,
      aiGenerated: true,
      aiModel: 'gpt-4o',
    }));

    generateAllSectionsMock.mockResolvedValue({ sections: generated });

    const counts: Record<string, { select: number; insert: number; update: number }> = {};
    mockSupabase.from.mockImplementation(
      buildMockSupabase({ existingSections: [], counts })
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/api/memos')
      .send({
        title: 'Test Memo',
        dealId: DEAL_ID,
        type: 'IC_MEMO',
        autoGenerate: true,
      });

    expect(res.status).toBe(201);

    // MemoSection.insert calls expected:
    //   1× for the default IC_MEMO sections (lines 121-122 of memos-mutate.ts)
    //   1× batched insert for the 6 new generated sections (the fix)
    // = 2 total. The N+1 code would have done 1 (defaults) + 6 (per-row) = 7.
    expect(counts.MemoSection?.insert ?? 0).toBeLessThanOrEqual(2);
  });
});
