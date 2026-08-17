/**
 * Export API Tests — exercises the REAL exportRouter.
 *
 * Prior version of this file used the "mini-app" pattern: an inline
 * express() app that reimplemented CSV/JSON serialization against a local
 * mockDeals array. That meant the actual handler in
 * apps/api/src/routes/export.ts was never executed — bugs in real handlers
 * (org scoping, supabase chain shape, AuditLog wiring, Zod validation)
 * would slip through.
 *
 * This file mounts the real exportRouter and exercises it via supertest.
 * Supabase + orgScope + AuditLog + logger are mocked; the control flow of
 * the actual handler (Zod parse, supabase query chain, CSV formatting)
 * runs.
 *
 * Mini-app fictions corrected:
 *   - The mini-app's "format=json" default was a fiction wrapped in an
 *     ad-hoc object. The real handler returns the same { success, count,
 *     deals } shape — confirmed at assertion level.
 *   - The mini-app's "deals-export-${Date.now()}.csv" filename pattern
 *     matches real router output — still asserted.
 *   - The "Export route module" smoke check at the bottom of the old file
 *     was tautological (just checked createExportApp() exists). Dropped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ───── Mocks (MUST be declared before the dynamic import) ─────────

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDealAccess: vi.fn().mockResolvedValue({ id: 'deal-1', organizationId: 'org-A' }),
}));

vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    log: vi.fn(),
  },
}));

// ───── Test app builder ──────────────────────────────────────────

const buildApp = async () => {
  const { default: exportRouter } = await import('../src/routes/export.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'user-123',
      organizationId: 'org-A',
      role: 'ADMIN',
      email: 'admin@example.com',
    };
    next();
  });
  app.use('/api/export', exportRouter);
  return app;
};

// ───── Sample data (shape matches real Deal+Company join) ─────────

const sampleDeals = [
  {
    id: 'deal-1',
    name: 'Acme Corp',
    industry: 'SaaS',
    revenue: 150,
    ebitda: 30,
    dealSize: 200,
    irrProjected: 22.5,
    mom: 3.1,
    stage: 'DUE_DILIGENCE',
    status: 'ACTIVE',
    priority: 'HIGH',
    extractionConfidence: 85,
    needsReview: false,
    source: 'AI Ingest',
    createdAt: '2026-02-13T10:00:00Z',
    company: { name: 'Acme Corp Inc', industry: 'SaaS' },
  },
  {
    id: 'deal-2',
    name: 'Beta Health',
    industry: 'Healthcare',
    revenue: 80,
    ebitda: 16,
    dealSize: 120,
    irrProjected: 18.0,
    mom: 2.5,
    stage: 'INITIAL_REVIEW',
    status: 'ACTIVE',
    priority: 'MEDIUM',
    extractionConfidence: 72,
    needsReview: true,
    source: 'Manual',
    createdAt: '2026-02-12T09:00:00Z',
    company: { name: 'Beta Health Inc', industry: 'Healthcare' },
  },
  {
    id: 'deal-3',
    name: 'Gamma, "Logistics" LLC',
    industry: 'Logistics',
    revenue: null,
    ebitda: null,
    dealSize: 50,
    irrProjected: null,
    mom: null,
    stage: 'PASSED',
    status: 'PASSED',
    priority: 'LOW',
    extractionConfidence: null,
    needsReview: false,
    source: null,
    createdAt: '2026-02-11T08:00:00Z',
    company: { name: 'Gamma LLC', industry: 'Logistics' },
  },
];

/**
 * Build a chained supabase mock that the real exportRouter's query builder
 * pattern (`from('Deal').select(...).eq(...).order(...)` then optional
 * `.eq()` / `.ilike()` calls) can navigate without surprise.
 *
 * The handler awaits the query at the end of the chain. We make every
 * builder method return a thenable so it works regardless of how many
 * optional filter methods are tacked on.
 */
const installDealQueryMock = (rows: any[], error: any = null) => {
  const result = { data: rows, error };
  const chainable: any = {};
  chainable.select = vi.fn(() => chainable);
  chainable.eq = vi.fn(() => chainable);
  chainable.ilike = vi.fn(() => chainable);
  chainable.order = vi.fn(() => chainable);
  // The handler awaits the chain — make it thenable to resolve to `result`.
  chainable.then = (resolve: any) => resolve(result);
  mockSupabase.from.mockReturnValue(chainable);
};

// ───── Tests ─────────────────────────────────────────────────────

describe('Real /api/export/deals handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  // ── JSON format ────────────────────────────────────────────────
  describe('JSON format', () => {
    it('returns all deals as JSON by default', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(3);
      expect(res.body.deals).toHaveLength(3);
    });

    it('returns JSON when format=json explicitly', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=json');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deals).toHaveLength(3);
    });

    it('returns 400 when format is invalid (Zod enum)', async () => {
      // Validation fires before any supabase call.
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=xml');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid query parameters');
    });
  });

  // ── CSV format ─────────────────────────────────────────────────
  describe('CSV format', () => {
    it('returns CSV when format=csv with correct headers + filename', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=csv');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('deals-export-');
    });

    it('emits header row + 1-per-deal data rows', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=csv');
      const lines = res.text.split('\n');

      // Header row content
      expect(lines[0]).toContain('Name');
      expect(lines[0]).toContain('Revenue ($M)');
      expect(lines[0]).toContain('Stage');
      expect(lines[0]).toContain('Created');

      // 1 header + 3 data rows = 4 lines
      expect(lines).toHaveLength(4);
    });

    it('escapes CSV values with commas and embedded quotes', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=csv');

      // Deal 3 name: Gamma, "Logistics" LLC
      // RFC 4180: doubled quotes inside a quoted field.
      expect(res.text).toContain('"Gamma, ""Logistics"" LLC"');
    });

    it('renders needsReview as Yes/No in CSV', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=csv');

      // Yes for deal-2 (needsReview:true), No for deal-1 and deal-3.
      expect(res.text).toContain(',Yes,');
      expect(res.text).toContain(',No,');
    });

    it('includes joined company name in CSV', async () => {
      installDealQueryMock(sampleDeals);
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals?format=csv');

      expect(res.text).toContain('Acme Corp Inc');
      expect(res.text).toContain('Beta Health Inc');
    });
  });

  // ── Error handling ─────────────────────────────────────────────
  describe('error handling', () => {
    it('returns 500 when supabase query fails', async () => {
      installDealQueryMock([], { message: 'db down' });
      const app = await buildApp();
      const res = await request(app).get('/api/export/deals');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Export failed');
    });
  });

  // ── Audit logging ──────────────────────────────────────────────
  describe('audit logging', () => {
    it('records a BULK_EXPORT audit entry on success', async () => {
      installDealQueryMock(sampleDeals);
      const { AuditLog } = await import('../src/services/auditLog.js');
      const app = await buildApp();
      await request(app).get('/api/export/deals?format=csv');

      // Real handler calls AuditLog.log(req, { action: 'BULK_EXPORT', ... })
      expect(AuditLog.log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'BULK_EXPORT',
          resourceType: 'DEAL',
        })
      );
    });
  });
});
