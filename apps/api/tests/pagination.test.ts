/**
 * Pagination tests — Task 5.3 of the remediation roadmap.
 *
 * Six unbounded list endpoints were identified by the architect review
 * (CONCERNS.md §3.3). Two of them were paginated cleanly:
 *   - GET /api/deals/:dealId/financials      (Task 5.3.3)
 *   - GET /api/watchlist                     (Task 5.3.5)
 *   - GET /api/conversations/:id/messages    (Task 5.3.6)
 * Three are aggregates that cap-and-warn instead of paginate (changing
 * semantics would silently produce wrong analytical math):
 *   - GET /api/deals/:dealId/financials/analysis        (Task 5.3.1)
 *   - GET /api/deals/:dealId/financials/insights        (Task 5.3.1)
 *   - GET /api/deals/:dealId/financials/cross-doc       (Task 5.3.1)
 *   - GET /api/deals/:dealId/financials/memo            (Task 5.3.2)
 *   - GET /api/deals/:dealId/financials/summary         (Task 5.3.3)
 *   - POST /api/memos (MemoTemplateSection clone)       (Task 5.3.4)
 *
 * These tests focus on the clean-pagination endpoints. They assert:
 *   1. Default limit is applied when no query param is passed
 *   2. Custom limit is respected within bounds
 *   3. Max limit cap is enforced (limit=10000 → 400 invalid)
 *   4. Offset is propagated to supabase.range()
 *   5. hasMore is true when data.length === limit, false otherwise
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 5 Task 5.3
 * Refs: .planning/codebase/CONCERNS.md §3.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Module-level mocks — must be set BEFORE the routers are imported.
const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDealAccess: vi.fn().mockResolvedValue({ id: 'deal-1', organizationId: 'org-A' }),
  verifyConversationAccess: vi.fn().mockResolvedValue({ id: 'conv-1' }),
}));

// notifications.resolveUserId is touched by watchlist POST but not GET; stub for safety
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(),
  notifyDealTeam: vi.fn(),
  resolveUserId: vi.fn().mockResolvedValue(null),
}));

// Mock the analysis sub-modules pulled in transitively by financials.ts — we
// don't exercise these paths in this test file but they must not throw at import.
vi.mock('../src/services/analysis/index.js', () => ({
  analyzeFinancials: vi.fn().mockResolvedValue({ qoe: null, ratios: [], periods: [] }),
}));
vi.mock('../src/services/narrativeInsights.js', () => ({
  generateNarrativeInsights: vi.fn(),
  computeAnalysisHash: vi.fn(),
  getCachedInsights: vi.fn(),
  cacheInsights: vi.fn(),
  invalidateCache: vi.fn(),
}));
vi.mock('../src/services/agentMemory.js', () => ({
  getIndustryBenchmarks: vi.fn(),
  getPortfolioSummary: vi.fn(),
  snapshotDealMetrics: vi.fn(),
  updateIndustryMemory: vi.fn(),
}));

/**
 * Build a fluent Supabase chain that captures the `.range()` call and
 * returns a synthetic dataset of `actualRowCount` rows. The chain mimics
 * the methods used by the endpoints under test: .from().select().eq()...
 * .order()...range().
 */
function buildChain(opts: {
  rangeSpy: ReturnType<typeof vi.fn>;
  actualRowCount: number;
}) {
  const { rangeSpy, actualRowCount } = opts;
  const synthetic = Array.from({ length: actualRowCount }, (_, i) => ({
    id: `row-${i}`,
    period: '2024-Q1',
    statementType: 'INCOME_STATEMENT',
    isActive: true,
  }));

  const terminal = {
    // Final await — supabase chains resolve when awaited at the end
    then: (resolve: (v: any) => void) =>
      resolve({ data: synthetic, error: null }),
  };

  const range = (...args: any[]) => {
    rangeSpy(...args);
    return terminal;
  };

  const order = (): any => ({ order, range, then: terminal.then });
  const eq = (): any => ({ eq, order, range, limit: () => ({ then: terminal.then }) });
  const select = () => ({ eq, order, range });
  return { select };
}

describe('GET /api/deals/:dealId/financials — pagination (Task 5.3.3)', () => {
  const rangeSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rangeSpy.mockReset();
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 10 })
    );
  });

  async function buildApp() {
    const { default: router } = await import('../src/routes/financials.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      next();
    });
    app.use('/api', router);
    return app;
  }

  it('applies default limit of 100 when no query params are passed', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials');
    expect(res.status).toBe(200);
    // .range(0, 99) → offset=0, limit=100
    expect(rangeSpy).toHaveBeenCalledWith(0, 99);
    expect(res.headers['x-pagination-limit']).toBe('100');
    expect(res.headers['x-pagination-offset']).toBe('0');
  });

  it('respects custom limit within bounds', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials?limit=25');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(0, 24);
    expect(res.headers['x-pagination-limit']).toBe('25');
  });

  it('rejects limit=10000 with 400 (above the 500 cap)', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials?limit=10000');
    expect(res.status).toBe(400);
    expect(rangeSpy).not.toHaveBeenCalled();
  });

  it('accepts offset and propagates to .range()', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials?limit=50&offset=200');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(200, 249);
    expect(res.headers['x-pagination-offset']).toBe('200');
  });

  it('reports hasMore=true when returned rows == limit (page is full)', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 25 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials?limit=25');
    expect(res.status).toBe(200);
    expect(res.headers['x-pagination-has-more']).toBe('true');
  });

  it('reports hasMore=false when returned rows < limit (last page)', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 7 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/financials?limit=25');
    expect(res.status).toBe(200);
    expect(res.headers['x-pagination-has-more']).toBe('false');
  });
});

describe('GET /api/watchlist — pagination (Task 5.3.5)', () => {
  const rangeSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rangeSpy.mockReset();
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 10 })
    );
  });

  async function buildApp() {
    const { default: router } = await import('../src/routes/watchlist.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      next();
    });
    app.use('/api/watchlist', router);
    return app;
  }

  it('applies default limit of 50 when no query params', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(0, 49);
    expect(res.body.pagination).toEqual({ limit: 50, offset: 0, hasMore: false });
  });

  it('respects custom limit', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist?limit=10');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(0, 9);
    expect(res.body.pagination.limit).toBe(10);
  });

  it('rejects limit above the 500 cap with 400', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist?limit=10000');
    expect(res.status).toBe(400);
    expect(rangeSpy).not.toHaveBeenCalled();
  });

  it('propagates offset to .range()', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist?limit=20&offset=40');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(40, 59);
    expect(res.body.pagination.offset).toBe(40);
  });

  it('hasMore=true when page is full', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 20 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it('hasMore=false when page is partial (last page)', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 3 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/watchlist?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.pagination.hasMore).toBe(false);
  });
});

describe('GET /api/conversations/:id/messages — pagination (Task 5.3.6)', () => {
  const rangeSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rangeSpy.mockReset();
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 10 })
    );
  });

  async function buildApp() {
    const { default: router } = await import('../src/routes/chat.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      next();
    });
    app.use('/api', router);
    return app;
  }

  it('applies default limit of 50 when no query params', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(0, 49);
    expect(res.headers['x-pagination-limit']).toBe('50');
  });

  it('respects custom limit', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages?limit=20');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(0, 19);
    expect(res.headers['x-pagination-limit']).toBe('20');
  });

  it('rejects limit above the 500 cap with 400', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages?limit=10000');
    expect(res.status).toBe(400);
    expect(rangeSpy).not.toHaveBeenCalled();
  });

  it('propagates offset to .range()', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages?limit=20&offset=80');
    expect(res.status).toBe(200);
    expect(rangeSpy).toHaveBeenCalledWith(80, 99);
    expect(res.headers['x-pagination-offset']).toBe('80');
  });

  it('hasMore=true when page is full', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 20 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages?limit=20');
    expect(res.status).toBe(200);
    expect(res.headers['x-pagination-has-more']).toBe('true');
  });

  it('hasMore=false when page is partial', async () => {
    mockSupabase.from.mockImplementation(() =>
      buildChain({ rangeSpy, actualRowCount: 4 })
    );
    const app = await buildApp();
    const res = await request(app).get('/api/conversations/conv-1/messages?limit=20');
    expect(res.status).toBe(200);
    expect(res.headers['x-pagination-has-more']).toBe('false');
  });
});
