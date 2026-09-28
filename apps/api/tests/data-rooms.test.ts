import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/data-rooms.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  // Mounted at /api like in app-lite.ts so the handler path is /api/data-rooms/summary
  app.use('/api', router);
  return app;
};

/** Chainable stub matching supabase-js's builder shape: every method
 *  returns `this` except the ones the route actually awaits, which are
 *  configured to resolve with the given rows. */
function table(rows: any[], { awaitAfter }: { awaitAfter: string[] }) {
  const stub: any = {};
  for (const method of ['select', 'eq', 'is', 'in']) {
    stub[method] = vi.fn((..._args: unknown[]) =>
      awaitAfter.includes(method) ? Promise.resolve({ data: rows, error: null }) : stub,
    );
  }
  return stub;
}

describe('GET /api/data-rooms/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('scopes the Deal query to the caller org and excludes soft-deleted deals', async () => {
    let dealEqCol: string | null = null;
    let dealEqVal: string | null = null;
    let dealIsCol: string | null = null;
    let dealIsVal: unknown = undefined;

    mockSupabase.from.mockImplementation((tbl: string) => {
      if (tbl === 'Deal') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              dealEqCol = col;
              dealEqVal = val;
              return {
                is: (col2: string, val2: unknown) => {
                  dealIsCol = col2;
                  dealIsVal = val2;
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${tbl}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/data-rooms/summary');

    expect(res.status).toBe(200);
    expect(dealEqCol).toBe('organizationId');
    expect(dealEqVal).toBe('org-A');
    expect(dealIsCol).toBe('deletedAt');
    expect(dealIsVal).toBeNull();
  });

  it('short-circuits with an empty rooms map when the org has no deals', async () => {
    let anyOtherTableQueried = false;
    mockSupabase.from.mockImplementation((tbl: string) => {
      if (tbl === 'Deal') {
        return { select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      anyOtherTableQueried = true;
      return table([], { awaitAfter: ['in'] });
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/data-rooms/summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rooms: {} });
    expect(anyOtherTableQueried).toBe(false);
  });

  it('seeds every deal with an (empty) bucket, even one with no folders/requests/shares', async () => {
    mockSupabase.from.mockImplementation((tbl: string) => {
      if (tbl === 'Deal') {
        return { select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: [{ id: 'deal-1' }, { id: 'deal-2' }], error: null }) }) }) };
      }
      // Folder/DocRequest/DealShare/Document/DocRequestItem/DealShareView all empty
      return table([], { awaitAfter: ['in'] });
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/data-rooms/summary');

    expect(res.status).toBe(200);
    expect(res.body.rooms).toEqual({
      'deal-1': { folders: [], requests: [], shares: [] },
      'deal-2': { folders: [], requests: [], shares: [] },
    });
  });

  it('computes folder fileCount, request received/total, and share viewCount, grouped per deal', async () => {
    const deals = [{ id: 'deal-1' }, { id: 'deal-2' }];
    const folders = [
      { id: 'f1', name: 'Financials', dealId: 'deal-1' },
      { id: 'f2', name: 'Legal', dealId: 'deal-1' },
      { id: 'f3', name: 'Financials', dealId: 'deal-2' },
    ];
    const docs = [{ folderId: 'f1' }, { folderId: 'f1' }, { folderId: 'f3' }]; // f1: 2, f2: 0, f3: 1
    const requests = [
      { id: 'r1', dealId: 'deal-1', status: 'OPEN', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', revokedAt: null, completedAt: null },
    ];
    const items = [
      { requestId: 'r1', fulfilledAt: '2026-09-05T00:00:00Z' },
      { requestId: 'r1', fulfilledAt: null },
      { requestId: 'r1', fulfilledAt: null },
    ];
    const shares = [
      { id: 's1', dealId: 'deal-2', createdAt: '2026-09-01T00:00:00Z', expiresAt: null, revokedAt: null },
    ];
    const views = [{ shareId: 's1' }, { shareId: 's1' }, { shareId: 's1' }];

    mockSupabase.from.mockImplementation((tbl: string) => {
      if (tbl === 'Deal') return { select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: deals, error: null }) }) }) };
      if (tbl === 'Folder') return table(folders, { awaitAfter: ['in'] });
      if (tbl === 'DocRequest') return table(requests, { awaitAfter: ['in'] });
      if (tbl === 'DealShare') return table(shares, { awaitAfter: ['in'] });
      if (tbl === 'Document') return table(docs, { awaitAfter: ['in'] });
      if (tbl === 'DocRequestItem') return table(items, { awaitAfter: ['in'] });
      if (tbl === 'DealShareView') return table(views, { awaitAfter: ['in'] });
      throw new Error(`Unexpected table: ${tbl}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/data-rooms/summary');

    expect(res.status).toBe(200);
    const room1 = res.body.rooms['deal-1'];
    expect(room1.folders).toEqual(
      expect.arrayContaining([
        { id: 'f1', name: 'Financials', fileCount: 2 },
        { id: 'f2', name: 'Legal', fileCount: 0 },
      ]),
    );
    expect(room1.requests).toEqual([
      expect.objectContaining({ id: 'r1', receivedCount: 1, totalCount: 3 }),
    ]);
    expect(room1.shares).toEqual([]);

    const room2 = res.body.rooms['deal-2'];
    expect(room2.folders).toEqual([{ id: 'f3', name: 'Financials', fileCount: 1 }]);
    expect(room2.requests).toEqual([]);
    expect(room2.shares).toEqual([expect.objectContaining({ id: 's1', viewCount: 3 })]);
  });

  it('returns 500 without leaking internals when a query fails', async () => {
    mockSupabase.from.mockImplementation((tbl: string) => {
      if (tbl === 'Deal') return { select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: null, error: new Error('db down') }) }) }) };
      throw new Error(`Unexpected table: ${tbl}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/data-rooms/summary');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load data room summary' });
  });
});
