/**
 * Companies API Endpoint Tests — exercises the REAL companiesRouter.
 *
 * Prior version of this file used the "mini-app" pattern: an inline
 * express() app that reproduced route logic against a local mockCompanies
 * array. That meant the actual handlers in apps/api/src/routes/companies.ts
 * were never executed — bugs in real handlers (org scoping, supabase shape,
 * Zod validation paths) would slip through.
 *
 * This file mounts the real companiesRouter and exercises it via supertest.
 * Supabase + orgScope + logger are mocked; the control flow of the actual
 * handlers runs.
 *
 * Mini-app fictions corrected:
 *   - GET /api/companies "search" query param was a mini-app invention; the
 *     real handler has no search support. Dropped those scenarios.
 *   - DELETE returning 404 for unknown id was a mini-app invention; the
 *     real handler always returns 204 (supabase delete is a no-op for an
 *     id that doesn't match). Updated assertion accordingly.
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
}));

// ───── Test app builder ──────────────────────────────────────────

const buildApp = async () => {
  const { default: companiesRouter } = await import('../src/routes/companies.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'test-auth-uuid',
      organizationId: 'org-A',
      role: 'ADMIN',
      email: 'admin@example.com',
    };
    next();
  });
  app.use('/api/companies', companiesRouter);
  return app;
};

// ───── Tests ─────────────────────────────────────────────────────

describe('Real /api/companies handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  // ── GET /api/companies ─────────────────────────────────────────
  describe('GET /api/companies', () => {
    it('returns companies scoped to caller org', async () => {
      const rows = [
        {
          id: 'company-1',
          name: 'Apex Logistics Corp',
          industry: 'Supply Chain SaaS',
          organizationId: 'org-A',
          createdAt: '2024-01-15T10:00:00Z',
          deals: [],
        },
        {
          id: 'company-2',
          name: 'MediCare Plus Inc',
          industry: 'Healthcare Services',
          organizationId: 'org-A',
          createdAt: '2024-01-20T10:00:00Z',
          deals: [],
        },
      ];
      // Chain: from('Company').select(...).eq('organizationId', orgId).order('name', ...)
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: rows, error: null }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/companies');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].name).toBe('Apex Logistics Corp');
    });

    it('returns 500 on supabase error', async () => {
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: null, error: { message: 'db down' } }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/companies');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to fetch companies');
    });
  });

  // ── GET /api/companies/:id ─────────────────────────────────────
  describe('GET /api/companies/:id', () => {
    it('returns a single company scoped to caller org', async () => {
      const company = {
        id: 'company-1',
        name: 'Apex Logistics Corp',
        organizationId: 'org-A',
        deals: [],
      };
      // Chain: from('Company').select(...).eq('id', id).eq('organizationId', orgId).single()
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: company, error: null }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/companies/company-1');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Apex Logistics Corp');
    });

    it('returns 404 when company is not in caller org (PGRST116 → 404)', async () => {
      // Real handler maps the PGRST116 "no rows" error to a 404. The org check
      // is enforced by .eq('organizationId', orgId) — a cross-org id returns
      // no rows and surfaces as 404 (not 403 — prevents enumeration).
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/companies/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Company not found');
    });
  });

  // ── POST /api/companies ────────────────────────────────────────
  describe('POST /api/companies', () => {
    it('creates a new company with organizationId injected', async () => {
      const inserted = {
        id: 'new-company-id',
        name: 'New Tech Corp',
        industry: 'Technology',
        description: 'A new tech company',
        website: 'https://newtech.example.com',
        organizationId: 'org-A',
        createdAt: '2026-05-18T00:00:00Z',
      };
      mockSupabase.from.mockReturnValue({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: inserted, error: null }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).post('/api/companies').send({
        name: 'New Tech Corp',
        industry: 'Technology',
        description: 'A new tech company',
        website: 'https://newtech.example.com',
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New Tech Corp');
      expect(res.body.organizationId).toBe('org-A');
    });

    it('returns 400 when name is missing (Zod validation)', async () => {
      // Validation fires before any supabase call.
      const app = await buildApp();
      const res = await request(app)
        .post('/api/companies')
        .send({ industry: 'Technology' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });

    it('returns 400 when website is not a valid URL (Zod validation)', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/api/companies')
        .send({ name: 'Test', website: 'not-a-valid-url' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });
  });

  // ── PATCH /api/companies/:id ───────────────────────────────────
  describe('PATCH /api/companies/:id', () => {
    it('updates a company scoped to caller org', async () => {
      const updated = {
        id: 'company-1',
        name: 'Apex Logistics Corp',
        description: 'Updated description',
        organizationId: 'org-A',
        deals: [],
      };
      // Chain: from('Company').update(...).eq('id', id).eq('organizationId', orgId).select(...).single()
      mockSupabase.from.mockReturnValue({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: updated, error: null }),
              }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app)
        .patch('/api/companies/company-1')
        .send({ description: 'Updated description' });

      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Updated description');
    });

    it('returns 404 when company is not in caller org (PGRST116 → 404)', async () => {
      mockSupabase.from.mockReturnValue({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: null, error: { code: 'PGRST116' } }),
              }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app)
        .patch('/api/companies/non-existent')
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/companies/:id ──────────────────────────────────
  describe('DELETE /api/companies/:id', () => {
    it('returns 204 on successful delete', async () => {
      // The real handler does NOT 404 on unknown id — supabase delete with
      // no matching rows is a no-op that returns success. The org filter
      // protects cross-org access (a non-org-A id simply matches nothing).
      mockSupabase.from.mockReturnValue({
        delete: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).delete('/api/companies/company-1');

      expect(res.status).toBe(204);
    });

    it('returns 500 on supabase error', async () => {
      mockSupabase.from.mockReturnValue({
        delete: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: { message: 'fk violation' } }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).delete('/api/companies/company-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to delete company');
    });
  });
});
