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
  const { default: router } = await import('../src/routes/documents-alerts.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  // Mounted at /api/documents like in app.ts so the handler path is /api/documents/alerts
  app.use('/api/documents', router);
  return app;
};

describe('GET /api/documents/alerts — multi-tenant scoping (Task 5.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('scopes Document query to caller org via pre-fetched dealIds (.in)', async () => {
    // Scenario: org A owns 2 deals (and 2 docs); org B owns 100 deals.
    // The pre-fix code fetched 50 most-recent docs globally and filtered in JS,
    // which under realistic loads can drop org A's docs entirely. After the fix
    // the SQL query must already be scoped: .in('dealId', [...orgA dealIds]).
    const dealsForOrgA = [{ id: 'deal-A1' }, { id: 'deal-A2' }];
    const orgADocs = [
      {
        id: 'doc-A1',
        name: 'CIM.pdf',
        type: 'PDF',
        createdAt: '2026-05-18T10:00:00Z',
        extractedText: null,
        aiAnalyzedAt: null,
        deal: { id: 'deal-A1', name: 'Project Alpha' },
      },
      {
        id: 'doc-A2',
        name: 'Financials.xlsx',
        type: 'XLSX',
        createdAt: '2026-05-18T09:00:00Z',
        extractedText: 'extracted body',
        aiAnalyzedAt: null,
        deal: { id: 'deal-A2', name: 'Project Beta' },
      },
    ];

    let documentInCol: string | null = null;
    let documentInIds: string[] | null = null;
    let dealEqCol: string | null = null;
    let dealEqVal: string | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              dealEqCol = col;
              dealEqVal = val;
              return Promise.resolve({ data: dealsForOrgA, error: null });
            },
          }),
        };
      }
      if (table === 'Document') {
        return {
          select: () => ({
            in: (col: string, ids: string[]) => {
              documentInCol = col;
              documentInIds = ids;
              return {
                order: () => ({
                  limit: () => Promise.resolve({ data: orgADocs, error: null }),
                }),
              };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/documents/alerts');

    expect(res.status).toBe(200);

    // (a) SQL filter happens at the supabase layer
    expect(dealEqCol).toBe('organizationId');
    expect(dealEqVal).toBe('org-A');
    expect(documentInCol).toBe('dealId');
    expect(documentInIds).toEqual(['deal-A1', 'deal-A2']);

    // (b) response contains only org A docs (both qualify: one missing
    // extractedText, the other missing aiAnalyzedAt)
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((i: any) => i.id).sort()).toEqual(['doc-A1', 'doc-A2']);
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({
        id: 'doc-A1',
        name: 'CIM.pdf',
        type: 'PDF',
        dealId: 'deal-A1',
        dealName: 'Project Alpha',
        state: 'pending',
      })
    );
    const second = res.body.items.find((i: any) => i.id === 'doc-A2');
    expect(second.state).toBe('ready_for_ai');
  });

  it('returns empty items array when caller org has no deals (short-circuits Document query)', async () => {
    let documentQueried = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      if (table === 'Document') {
        documentQueried = true;
        return {
          select: () => ({
            in: () => ({
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
    const res = await request(app).get('/api/documents/alerts');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // Should short-circuit — Document query never issued when org has no deals
    expect(documentQueried).toBe(false);
  });

  it('filters out documents that are already analyzed (extracted AND aiAnalyzedAt set)', async () => {
    const dealsForOrgA = [{ id: 'deal-A1' }];
    const docs = [
      {
        id: 'doc-pending',
        name: 'a.pdf',
        type: 'PDF',
        createdAt: '2026-05-18T10:00:00Z',
        extractedText: null,
        aiAnalyzedAt: null,
        deal: { id: 'deal-A1', name: 'Project Alpha' },
      },
      {
        id: 'doc-done',
        name: 'b.pdf',
        type: 'PDF',
        createdAt: '2026-05-18T09:00:00Z',
        extractedText: 'body',
        aiAnalyzedAt: '2026-05-17T00:00:00Z',
        deal: { id: 'deal-A1', name: 'Project Alpha' },
      },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: dealsForOrgA, error: null }),
          }),
        };
      }
      if (table === 'Document') {
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: docs, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).get('/api/documents/alerts');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('doc-pending');
  });
});
