import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = {
  from: vi.fn(),
  rpc: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Auto-generation paths
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  generateAllSections: vi.fn(async () => ({ sections: [] })),
  COMPREHENSIVE_IC_SECTIONS: [],
  STANDARD_IC_SECTIONS: [],
  SEARCH_FUND_SECTIONS: [],
  SCREENING_NOTE_SECTIONS: [],
}));
vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => false,
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    memoCreated: vi.fn(),
    memoDeleted: vi.fn(),
  },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  PERMISSIONS: { MEMO_DELETE: 'memo.delete' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/memos-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/memos', router);
  return app;
};

const insertedRows: Record<string, any[]> = {};
const updatedRows: Record<string, any[]> = {};

const resetTrackers = () => {
  for (const k of Object.keys(insertedRows)) delete insertedRows[k];
  for (const k of Object.keys(updatedRows)) delete updatedRows[k];
};

describe('POST /api/memos — deal scoping (F-18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    resetTrackers();
  });

  it('rejects creation when dealId belongs to another org (does not leak deal name)', async () => {
    let dealLookupFilters: { col: string; val: string }[] = [];
    let memoInsertCalled = false;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        const chain: any = {
          eq: (col: string, val: string) => {
            dealLookupFilters.push({ col, val });
            return chain;
          },
          single: async () => ({ data: null, error: null }),
        };
        return {
          select: () => chain,
        };
      }
      if (table === 'Memo') {
        return {
          insert: () => {
            memoInsertCalled = true;
            return {
              select: () => ({ single: async () => ({ data: { id: 'memo-1' }, error: null }) }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/memos').send({
      title: 'My Memo',
      dealId: '11111111-1111-1111-1111-111111111111',
      type: 'IC_MEMO',
    });

    expect(res.status).toBe(400);
    expect(memoInsertCalled).toBe(false);
    // Lookup must include an org filter
    const colsUsed = dealLookupFilters.map((f) => f.col);
    expect(colsUsed).toContain('organizationId');
  });
});

describe('POST /api/memos — template usage scoping (F-19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    resetTrackers();
  });

  it('does not clone sections or increment usage when template belongs to another org', async () => {
    let templateLookupFilters: { col: string; val: string }[] = [];
    let templateSectionsFetched = false;
    let memoSectionInsertCalled = false;
    let templateUpdateCalled = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        // Deal in caller's org for the projectName lookup
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Acme Co' }, error: null }),
              }),
              single: async () => ({ data: { name: 'Acme Co' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'Memo') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 'memo-1', type: 'STRATEGY_DOC' },
                error: null,
              }),
            }),
          }),
          // For the final fullMemo fetch
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: 'memo-1', sections: [] }, error: null }),
            }),
          }),
        };
      }
      if (table === 'MemoTemplate') {
        // The fix should add an org filter on this lookup. Treat foreign-template
        // org filter as miss → no template found, no usage increment.
        const selectChain: any = {
          eq: (col: string, val: string) => {
            templateLookupFilters.push({ col, val });
            return selectChain;
          },
          single: async () => {
            // foreign template with org filter applied → null
            if (templateLookupFilters.some((f) => f.col === 'organizationId' && f.val !== 'org-B')) {
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
        };
        return {
          select: () => selectChain,
          update: () => {
            templateUpdateCalled = true;
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      if (table === 'MemoTemplateSection') {
        // Should not be reached if template org check fails first.
        const chain: any = {
          eq: () => chain,
          order: () => {
            templateSectionsFetched = true;
            return Promise.resolve({ data: [], error: null });
          },
        };
        return {
          select: () => chain,
        };
      }
      if (table === 'MemoSection') {
        return {
          insert: () => {
            memoSectionInsertCalled = true;
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/memos').send({
      title: 'My Memo',
      dealId: '22222222-2222-2222-2222-222222222222',
      type: 'IC_MEMO',
      templateId: '00000000-0000-0000-0000-000000000099',
    });

    expect(res.status).toBe(201);
    // Critical: template lookup MUST include an organizationId filter (the fix)
    const colsUsed = templateLookupFilters.map((f) => f.col);
    expect(colsUsed).toContain('organizationId');
    // No update on foreign template
    expect(templateUpdateCalled).toBe(false);
  });
});

describe('POST /api/templates/:id/use — RPC scoping (F-19, templates.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    mockSupabase.rpc.mockReset();
  });

  it('returns 404 and does NOT call RPC when template is in another org', async () => {
    let rpcCalled = false;
    mockSupabase.rpc.mockImplementation(() => {
      rpcCalled = true;
      return Promise.resolve({ data: null, error: null });
    });

    let templateLookupFilters: { col: string; val: string }[] = [];
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'MemoTemplate') {
        const chain: any = {
          eq: (col: string, val: string) => {
            templateLookupFilters.push({ col, val });
            return chain;
          },
          single: async () => ({ data: null, error: null }), // cross-org → null
        };
        return {
          select: () => chain,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const { default: router } = await import('../src/routes/templates.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      next();
    });
    app.use('/api/templates', router);

    const res = await request(app).post('/api/templates/foreign-tpl/use');

    expect(res.status).toBe(404);
    expect(rpcCalled).toBe(false);
    const cols = templateLookupFilters.map((f) => f.col);
    expect(cols).toContain('organizationId');
  });
});
