/**
 * Performance tests for DELETE /api/deals/:id cascade.
 *
 * Bug: the delete handler ran sequential `await supabase.from(...).delete()`
 * inside `for (... of ...)` loops for FolderInsight (per folder) and
 * MemoSection (per memo). For a deal with N folders and M memos this is
 * N + M sequential round-trips. On Vercel serverless each carries
 * ~5-20ms overhead, so deletes scaled linearly with deal size.
 *
 * Fix: collapse per-row deletes into single `.in(<fkCol>, ids)` deletes.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 5 Task 5.1
 * Refs: .planning/codebase/CONCERNS.md §3.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks BEFORE importing the router (mirrors documents-sharing.test.ts)
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// rbac middleware passes through (DEAL_DELETE permission auto-granted in test)
vi.mock('../src/middleware/rbac.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  PERMISSIONS: {
    DEAL_CREATE: 'deal:create',
    DEAL_DELETE: 'deal:delete',
  },
}));

vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    dealCreated: vi.fn(),
    dealUpdated: vi.fn(),
    dealDeleted: vi.fn(),
  },
}));

vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(),
  notifyDealTeam: vi.fn(),
  resolveUserId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDealAccess: vi.fn(),
}));

const DEAL_ID = 'deal-perf-1';
const ORG_ID = 'org-A';

/**
 * Build a mock supabase.from() that tracks per-table call counts.
 *
 * The deal-delete handler does:
 *   - Deal: select (preflight) + delete (final)
 *   - DocumentChunk: delete
 *   - Document: delete
 *   - Folder: select (ids) + delete
 *   - FolderInsight: delete (per folder in N+1 code, once with .in() in fix)
 *   - ChatMessage, Conversation, Activity, DealTeamMember: delete
 *   - Memo: select (ids) + delete
 *   - MemoSection: delete (per memo in N+1 code, once with .in() in fix)
 *   - Notification: delete
 */
function buildMockSupabase(opts: {
  folderIds: string[];
  memoIds: string[];
  counts: Record<string, { select: number; delete: number }>;
}) {
  const { folderIds, memoIds, counts } = opts;

  function track(table: string, op: 'select' | 'delete') {
    if (!counts[table]) counts[table] = { select: 0, delete: 0 };
    counts[table][op] += 1;
  }

  return (table: string) => {
    if (table === 'Deal') {
      return {
        select: () => {
          track('Deal', 'select');
          return {
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Deal' }, error: null }),
              }),
            }),
          };
        },
        delete: () => {
          track('Deal', 'delete');
          return {
            eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        },
      };
    }

    if (table === 'Folder') {
      return {
        select: () => {
          track('Folder', 'select');
          return {
            eq: () =>
              Promise.resolve({
                data: folderIds.map((id) => ({ id })),
                error: null,
              }),
          };
        },
        delete: () => {
          track('Folder', 'delete');
          // Folder.delete().eq('dealId', id)
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    }

    if (table === 'Memo') {
      return {
        select: () => {
          track('Memo', 'select');
          return {
            eq: () =>
              Promise.resolve({
                data: memoIds.map((id) => ({ id })),
                error: null,
              }),
          };
        },
        delete: () => {
          track('Memo', 'delete');
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    }

    // Generic child tables that only get .delete().eq() or .delete().in() called
    return {
      delete: () => {
        track(table, 'delete');
        return {
          // Both .eq() and .in() should resolve cleanly
          eq: () => Promise.resolve({ error: null }),
          in: () => Promise.resolve({ error: null }),
        };
      },
      // FolderInsight/MemoSection never use select; keep it safe though.
      select: () => {
        track(table, 'select');
        return { eq: () => Promise.resolve({ data: [], error: null }) };
      },
    };
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: ORG_ID };
    next();
  });
  app.use('/api/deals', router);
  return app;
}

describe('DELETE /api/deals/:id — batched cascade (N+1 fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('issues exactly one FolderInsight.delete regardless of folder count', async () => {
    const folderIds = Array.from({ length: 10 }, (_, i) => `folder-${i}`);
    const memoIds = Array.from({ length: 5 }, (_, i) => `memo-${i}`);
    const counts: Record<string, { select: number; delete: number }> = {};

    mockSupabase.from.mockImplementation(
      buildMockSupabase({ folderIds, memoIds, counts })
    );

    const app = await buildApp();
    const res = await request(app).delete(`/api/deals/${DEAL_ID}`);

    expect(res.status).toBe(204);
    // With N=10 folders the buggy code called FolderInsight.delete 10 times.
    // The fix collapses it to a single batched .in() delete.
    expect(counts.FolderInsight?.delete ?? 0).toBe(1);
  });

  it('issues exactly one MemoSection.delete regardless of memo count', async () => {
    const folderIds = Array.from({ length: 10 }, (_, i) => `folder-${i}`);
    const memoIds = Array.from({ length: 5 }, (_, i) => `memo-${i}`);
    const counts: Record<string, { select: number; delete: number }> = {};

    mockSupabase.from.mockImplementation(
      buildMockSupabase({ folderIds, memoIds, counts })
    );

    const app = await buildApp();
    const res = await request(app).delete(`/api/deals/${DEAL_ID}`);

    expect(res.status).toBe(204);
    // With M=5 memos the buggy code called MemoSection.delete 5 times.
    // The fix collapses it to a single batched .in() delete.
    expect(counts.MemoSection?.delete ?? 0).toBe(1);
  });

  it('skips child-row deletes entirely when no parents exist', async () => {
    const counts: Record<string, { select: number; delete: number }> = {};

    mockSupabase.from.mockImplementation(
      buildMockSupabase({ folderIds: [], memoIds: [], counts })
    );

    const app = await buildApp();
    const res = await request(app).delete(`/api/deals/${DEAL_ID}`);

    expect(res.status).toBe(204);
    // Nothing to batch on — must not issue a .in([]) delete.
    expect(counts.FolderInsight?.delete ?? 0).toBe(0);
    expect(counts.MemoSection?.delete ?? 0).toBe(0);
  });

  it('preserves cascade order: children deleted before their parents', async () => {
    const folderIds = ['folder-1', 'folder-2'];
    const memoIds = ['memo-1'];
    const counts: Record<string, { select: number; delete: number }> = {};

    // Record table-level delete order so we can assert children-before-parents.
    const deleteOrder: string[] = [];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Deal' }, error: null }),
              }),
            }),
          }),
          delete: () => {
            deleteOrder.push('Deal');
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      }
      if (table === 'Folder') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: folderIds.map((id) => ({ id })),
                error: null,
              }),
          }),
          delete: () => {
            deleteOrder.push('Folder');
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      if (table === 'Memo') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: memoIds.map((id) => ({ id })),
                error: null,
              }),
          }),
          delete: () => {
            deleteOrder.push('Memo');
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      return {
        delete: () => {
          deleteOrder.push(table);
          if (!counts[table]) counts[table] = { select: 0, delete: 0 };
          counts[table].delete += 1;
          return {
            eq: () => Promise.resolve({ error: null }),
            in: () => Promise.resolve({ error: null }),
          };
        },
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      };
    });

    const app = await buildApp();
    const res = await request(app).delete(`/api/deals/${DEAL_ID}`);

    expect(res.status).toBe(204);

    // FolderInsight must be deleted BEFORE its Folder parent (FK constraint).
    const folderInsightIdx = deleteOrder.indexOf('FolderInsight');
    const folderIdx = deleteOrder.indexOf('Folder');
    expect(folderInsightIdx).toBeGreaterThanOrEqual(0);
    expect(folderInsightIdx).toBeLessThan(folderIdx);

    // MemoSection must be deleted BEFORE its Memo parent.
    const memoSectionIdx = deleteOrder.indexOf('MemoSection');
    const memoIdx = deleteOrder.indexOf('Memo');
    expect(memoSectionIdx).toBeGreaterThanOrEqual(0);
    expect(memoSectionIdx).toBeLessThan(memoIdx);

    // Deal itself is the very last delete.
    expect(deleteOrder[deleteOrder.length - 1]).toBe('Deal');
  });
});
