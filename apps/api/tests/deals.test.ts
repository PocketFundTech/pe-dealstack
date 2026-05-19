/**
 * Deals API Endpoint Tests — exercises the REAL dealsRouter.
 *
 * Prior versions of this file used the "mini-app" pattern: an inline
 * express() app that reproduced route logic against a local mockDeals
 * array. That meant the actual handlers in apps/api/src/routes/deals*.ts
 * were never executed — bugs in real handlers would slip through.
 *
 * This file mounts the real dealsRouter (apps/api/src/routes/deals.ts)
 * and exercises it via supertest. Supabase + orgScope helpers + a few
 * notification side-effects are mocked (those are runtime dependencies,
 * not handler logic). The control flow of the actual handlers runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ───── Mocks (MUST be declared before the dynamic import) ─────────

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

// AuditLog is called from POST/PATCH/DELETE — stub each method.
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    dealCreated: vi.fn(),
    dealUpdated: vi.fn(),
    dealDeleted: vi.fn(),
    log: vi.fn(),
  },
}));

// notifications.js is imported by deals-mutate.ts (createNotification,
// notifyDealTeam, resolveUserId).
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(),
  notifyDealTeam: vi.fn(),
  resolveUserId: vi.fn().mockResolvedValue('internal-user-1'),
}));

// orgScope helpers — getOrgId returns 'org-A' for this suite.
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDealAccess,
}));

// ───── Test app builder ─────────────────────────────────────────────

const buildApp = async () => {
  const { default: dealsRouter } = await import('../src/routes/deals.js');
  const errorHandlerModule = await import('../src/middleware/errorHandler.js');
  const app = express();
  app.use(express.json());
  // Fake auth — mirrors what the real authMiddleware would attach.
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'test-auth-uuid',
      organizationId: 'org-A',
      role: 'admin', // rbac uses lowercase role strings
      email: 'test@example.com',
    };
    next();
  });
  app.use('/api/deals', dealsRouter);
  // The real GET /:id handler delegates to next(error) — mount the
  // shared error handler so NotFoundError becomes a 404 JSON response.
  app.use(errorHandlerModule.errorHandler);
  return app;
};

// ───── Tests ────────────────────────────────────────────────────────

describe('Real /api/deals handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    verifyDealAccess.mockReset();
  });

  // ── GET /api/deals ─────────────────────────────────────────────
  describe('GET /api/deals', () => {
    // Helper to build a chainable mock for the list select pipeline.
    // The real handler does: from('Deal').select(...).eq(...).[optional .eq/.ilike/.gte/.lte/.or].order()
    // We collect every filter call so we can assert the final pipeline,
    // and resolve at .order().
    const setupDealListMock = (returned: unknown[]) => {
      const calls: { method: string; args: unknown[] }[] = [];
      const chain: any = {};
      const passthrough = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args });
        return chain;
      };
      chain.select = passthrough('select');
      chain.eq = passthrough('eq');
      chain.ilike = passthrough('ilike');
      chain.gte = passthrough('gte');
      chain.lte = passthrough('lte');
      chain.or = passthrough('or');
      chain.order = (...args: unknown[]) => {
        calls.push({ method: 'order', args });
        return Promise.resolve({ data: returned, error: null });
      };
      mockSupabase.from.mockReturnValue(chain);
      return calls;
    };

    it('returns all deals (no filters)', async () => {
      const deals = [
        { id: 'd1', name: 'Apex Logistics', stage: 'DUE_DILIGENCE', status: 'ACTIVE', industry: 'Supply Chain SaaS' },
        { id: 'd2', name: 'MediCare Plus', stage: 'INITIAL_REVIEW', status: 'ACTIVE', industry: 'Healthcare Services' },
      ];
      const calls = setupDealListMock(deals);

      const app = await buildApp();
      const res = await request(app).get('/api/deals');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(deals);
      // Always scoped to org
      expect(calls).toContainEqual({ method: 'eq', args: ['organizationId', 'org-A'] });
    });

    it('passes stage filter into the supabase query', async () => {
      const calls = setupDealListMock([
        { id: 'd1', name: 'Apex', stage: 'DUE_DILIGENCE' },
      ]);

      const app = await buildApp();
      const res = await request(app).get('/api/deals?stage=DUE_DILIGENCE');

      expect(res.status).toBe(200);
      expect(calls).toContainEqual({ method: 'eq', args: ['stage', 'DUE_DILIGENCE'] });
    });

    it('passes industry filter as ilike', async () => {
      const calls = setupDealListMock([
        { id: 'd2', name: 'MediCare', industry: 'Healthcare Services' },
      ]);

      const app = await buildApp();
      const res = await request(app).get('/api/deals?industry=Healthcare');

      expect(res.status).toBe(200);
      expect(calls).toContainEqual({ method: 'ilike', args: ['industry', '%Healthcare%'] });
    });

    it('passes search term as an .or() across multiple columns', async () => {
      const calls = setupDealListMock([
        { id: 'd1', name: 'Apex Logistics' },
      ]);

      const app = await buildApp();
      const res = await request(app).get('/api/deals?search=Apex');

      expect(res.status).toBe(200);
      // The handler builds: name.ilike.%Apex%,industry.ilike.%Apex%,aiThesis.ilike.%Apex%
      const orCall = calls.find(c => c.method === 'or');
      expect(orCall).toBeDefined();
      expect(orCall!.args[0]).toContain('name.ilike.%Apex%');
    });

    it('returns 400 on invalid query params (Zod)', async () => {
      // industry > 100 chars rejected by dealsQuerySchema
      const app = await buildApp();
      const res = await request(app).get(`/api/deals?industry=${'x'.repeat(150)}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid query parameters');
    });
  });

  // ── GET /api/deals/stats/summary ───────────────────────────────
  describe('GET /api/deals/stats/summary', () => {
    it('returns counts + byStage breakdown', async () => {
      // The handler does 4 supabase calls in sequence:
      //   1. count of all deals for org
      //   2. count of ACTIVE deals
      //   3. count of PASSED deals
      //   4. select(stage) from ACTIVE deals → reduces in memory
      // Each call is `from('Deal').select(...)…` with different .eq chains.
      // We return a chainable object whose terminal `eq()` resolves to the
      // configured response.
      const responses = [
        // 1. total (head + count)
        { count: 5, data: null, error: null },
        // 2. active
        { count: 4, data: null, error: null },
        // 3. passed
        { count: 1, data: null, error: null },
        // 4. data with stages
        { data: [{ stage: 'DUE_DILIGENCE' }, { stage: 'DUE_DILIGENCE' }, { stage: 'INITIAL_REVIEW' }], error: null },
      ];
      let call = 0;
      mockSupabase.from.mockImplementation(() => {
        const resp = responses[call++];
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          // The final `.eq()` in each chain is the awaited promise.
          // To support both `await chain.eq(...)` and `chain.eq(...).eq(...)`
          // we make the chain object itself thenable.
          then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resp).then(onFulfilled),
        };
        return chain;
      });

      const app = await buildApp();
      const res = await request(app).get('/api/deals/stats/summary');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.active).toBe(4);
      expect(res.body.passed).toBe(1);
      expect(Array.isArray(res.body.byStage)).toBe(true);
      // byStage from the data array above: 2 DD + 1 IR
      const dd = res.body.byStage.find((b: any) => b.stage === 'DUE_DILIGENCE');
      expect(dd?.count).toBe(2);
    });
  });

  // ── GET /api/deals/:id ─────────────────────────────────────────
  describe('GET /api/deals/:id', () => {
    it('returns the deal when found in caller org', async () => {
      const deal = {
        id: 'deal-A',
        name: 'Apex Logistics',
        organizationId: 'org-A',
        activities: [
          { id: 'a1', createdAt: '2026-02-01T00:00:00Z' },
          { id: 'a2', createdAt: '2026-02-13T00:00:00Z' },
        ],
      };
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: deal, error: null }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/deals/deal-A');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Apex Logistics');
      // Activities must come back sorted most-recent-first
      expect(res.body.activities[0].id).toBe('a2');
    });

    it('returns 404 when supabase reports PGRST116 (no rows)', async () => {
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116', message: 'No rows' } }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/deals/missing');

      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/deals ────────────────────────────────────────────
  describe('POST /api/deals', () => {
    it('creates a deal, auto-creating the company when only companyName is given', async () => {
      const createdCompany = { id: 'company-new', name: 'Test Company' };
      const createdDeal = {
        id: 'new-deal-id',
        name: 'New Test Deal',
        companyId: 'company-new',
        organizationId: 'org-A',
        company: createdCompany,
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'Company') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: createdCompany, error: null }),
              }),
            }),
          };
        }
        if (table === 'Deal') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: createdDeal, error: null }),
              }),
            }),
            // For the fire-and-forget auto-archive sample-deal call:
            update: () => ({
              eq: () => ({
                contains: () => ({
                  then: (onFulfilled: (v: unknown) => unknown) =>
                    Promise.resolve({ error: null }).then(onFulfilled),
                }),
              }),
            }),
          };
        }
        if (table === 'Activity') {
          return {
            insert: async () => ({ data: null, error: null }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildApp();
      const res = await request(app).post('/api/deals').send({
        name: 'New Test Deal',
        companyName: 'Test Company',
        industry: 'Technology',
        dealSize: 50,
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('new-deal-id');
      expect(res.body.name).toBe('New Test Deal');
    });

    it('returns 400 when both companyId and companyName are missing', async () => {
      // The handler only reaches the company-id check if Zod parses OK.
      // No supabase calls expected — but in case the handler ever does,
      // safe fallback:
      mockSupabase.from.mockReturnValue({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).post('/api/deals').send({
        name: 'Test Deal',
        industry: 'Technology',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Company ID or name is required');
    });

    it('returns 400 on Zod validation error (empty name)', async () => {
      const app = await buildApp();
      const res = await request(app).post('/api/deals').send({
        name: '',
        companyName: 'Test Company',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });
  });

  // ── PATCH /api/deals/:id ───────────────────────────────────────
  describe('PATCH /api/deals/:id', () => {
    it('updates an existing deal', async () => {
      const existingDeal = {
        id: 'deal-A',
        name: 'Apex',
        stage: 'DUE_DILIGENCE',
        updatedAt: '2026-02-13T10:00:00Z',
        organizationId: 'org-A',
      };
      const updatedDeal = { ...existingDeal, stage: 'LOI_SUBMITTED', dealSize: 55 };

      let dealSelectCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'Deal') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => {
                    dealSelectCount++;
                    return { data: existingDeal, error: null };
                  },
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: async () => ({ data: updatedDeal, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'Activity') {
          return { insert: async () => ({ data: null, error: null }) };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildApp();
      const res = await request(app)
        .patch('/api/deals/deal-A')
        .send({ stage: 'LOI_SUBMITTED', dealSize: 55 });

      expect(res.status).toBe(200);
      expect(res.body.stage).toBe('LOI_SUBMITTED');
      expect(res.body.dealSize).toBe(55);
      expect(dealSelectCount).toBe(1);
    });

    it('returns 404 when deal not found in caller org', async () => {
      mockSupabase.from.mockImplementation(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        }),
      }));

      const app = await buildApp();
      const res = await request(app)
        .patch('/api/deals/nonexistent')
        .send({ stage: 'LOI_SUBMITTED' });

      expect(res.status).toBe(404);
    });

    it('returns 409 when lastKnownUpdatedAt is stale (optimistic lock)', async () => {
      const existingDeal = {
        id: 'deal-A',
        name: 'Apex',
        stage: 'DUE_DILIGENCE',
        updatedAt: '2026-02-13T10:00:00Z',
        organizationId: 'org-A',
      };
      mockSupabase.from.mockImplementation(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: existingDeal, error: null }),
            }),
          }),
        }),
      }));

      const app = await buildApp();
      const res = await request(app)
        .patch('/api/deals/deal-A')
        .send({
          stage: 'LOI_SUBMITTED',
          lastKnownUpdatedAt: '2026-02-13T09:00:00Z', // earlier than server's 10:00
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('modified by another user');
      expect(res.body.updatedAt).toBe('2026-02-13T10:00:00Z');
    });
  });

  // ── DELETE /api/deals/:id ──────────────────────────────────────
  describe('DELETE /api/deals/:id', () => {
    /**
     * The real DELETE handler cascades through many child tables before
     * deleting the deal. For test purposes we make every table answer
     * with no rows / no error, so the cascade collapses into ~12 no-op
     * calls. We only assert the user-visible response.
     */
    const wireCascadeMock = (dealFound: boolean) => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'Deal') {
          return {
            // Initial existence-check: select('name').eq('id').eq('organizationId').single()
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () =>
                    dealFound
                      ? { data: { name: 'Apex' }, error: null }
                      : { data: null, error: { code: 'PGRST116' } },
                }),
              }),
            }),
            // Final delete
            delete: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        // Folder/Memo selects used to gather IDs for batched .in() deletes
        if (table === 'Folder' || table === 'Memo') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
            delete: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
            }),
          };
        }
        // All other child-table deletes: just resolve.
        return {
          delete: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
            in: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      });
    };

    it('returns 204 when delete succeeds', async () => {
      wireCascadeMock(true);
      const app = await buildApp();
      const res = await request(app).delete('/api/deals/deal-A');

      expect(res.status).toBe(204);
    });

    it('returns 404 when deal not found in caller org', async () => {
      wireCascadeMock(false);
      const app = await buildApp();
      const res = await request(app).delete('/api/deals/nonexistent');

      expect(res.status).toBe(404);
    });
  });
});
