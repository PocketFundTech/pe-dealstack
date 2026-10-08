/**
 * GET /api/companies/list and GET /api/companies/:id/overview — the Companies
 * page endpoints. Mounts the real companiesRouter; Supabase is a recording
 * query-builder mock so each test can assert the filters that were applied
 * (org scope, soft-deleted deals, has-deals / source / search, paging) and
 * that counts are batched rather than queried per row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

type Call = [string, ...unknown[]];
type Result = { data: unknown; error: unknown; count?: number | null };

interface Recorded {
  table: string;
  calls: Call[];
}

const recorded: Recorded[] = [];
let resolver: (table: string, calls: Call[]) => Result = () => ({ data: [], error: null });

function builder(table: string) {
  const rec: Recorded = { table, calls: [] };
  recorded.push(rec);
  const methods = ['select', 'eq', 'is', 'not', 'ilike', 'or', 'order', 'range', 'limit'];
  const b: Record<string, unknown> = {};
  for (const m of methods) {
    b[m] = (...args: unknown[]) => {
      rec.calls.push([m, ...args]);
      return b;
    };
  }
  b.single = () => {
    rec.calls.push(['single']);
    return Promise.resolve(resolver(table, rec.calls));
  };
  b.then = (onF: (r: Result) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolver(table, rec.calls)).then(onF, onR);
  return b;
}

const mockSupabase = { from: vi.fn((table: string) => builder(table)) };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));

const buildApp = async () => {
  const { default: companiesRouter } = await import('../src/routes/companies.js');
  const app = express();
  app.use(express.json());
  app.use('/api/companies', companiesRouter);
  return app;
};

const has = (rec: Recorded | undefined, ...call: unknown[]) =>
  !!rec?.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

const companyQuery = () => recorded.find((r) => r.table === 'Company');
const contactQueries = () => recorded.filter((r) => r.table === 'Contact');

const COMPANIES = [
  {
    id: 'c1', name: 'Acme, Inc.', industry: 'Logistics', website: 'https://acme.test',
    hubspotId: 'hs-1', createdAt: '2026-01-01', updatedAt: '2026-10-01',
    deals: [{ id: 'd1', name: 'Project Acme', stage: 'DUE_DILIGENCE', status: 'ACTIVE' }],
  },
  {
    id: 'c2', name: 'Bolt Labs', industry: null, website: null,
    hubspotId: null, createdAt: '2026-02-01', updatedAt: '2026-09-01',
    deals: [
      { id: 'd2', name: 'Bolt A', stage: 'INITIAL_REVIEW', status: 'ACTIVE' },
      { id: 'd3', name: 'Bolt B', stage: 'CLOSING', status: 'ACTIVE' },
    ],
  },
  {
    id: 'c3', name: 'Quiet Co', industry: 'SaaS', website: null,
    hubspotId: 'hs-3', createdAt: '2026-03-01', updatedAt: '2026-08-01',
    deals: [],
  },
];

beforeEach(() => {
  recorded.length = 0;
  mockSupabase.from.mockClear();
  resolver = (table) => {
    if (table === 'Company') return { data: COMPANIES, error: null, count: 3 };
    if (table === 'Contact') {
      return {
        data: [
          { company: 'acme, inc.' },
          { company: 'ACME, INC.' },
          { company: 'Bolt Labs' },
          { company: 'Bolt Labs Holdings' }, // not an exact match — ignored
        ],
        error: null,
      };
    }
    return { data: [], error: null };
  };
});

describe('GET /api/companies/list', () => {
  it('scopes to the caller org, excludes soft-deleted deals, and returns counts + source', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/companies/list');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);

    const q = companyQuery();
    expect(has(q, 'eq', 'organizationId', 'org-A')).toBe(true);
    expect(has(q, 'is', 'deals.deletedAt', null)).toBe(true);
    expect(has(q, 'range', 0, 24)).toBe(true);
    expect(has(q, 'order', 'name', { ascending: true, nullsFirst: false })).toBe(true);

    const [acme, bolt, quiet] = res.body.companies;
    expect(acme).toMatchObject({ id: 'c1', source: 'hubspot', dealCount: 1, contactCount: 2 });
    expect(acme.deals).toEqual([{ id: 'd1', name: 'Project Acme', stage: 'DUE_DILIGENCE', status: 'ACTIVE' }]);
    expect(bolt).toMatchObject({ id: 'c2', source: 'avise', dealCount: 2, contactCount: 1 });
    expect(quiet).toMatchObject({ id: 'c3', source: 'hubspot', dealCount: 0, contactCount: 0 });
  });

  it('counts contacts in a single org-scoped query for the whole page (no N+1)', async () => {
    const app = await buildApp();
    await request(app).get('/api/companies/list');

    const contacts = contactQueries();
    expect(contacts).toHaveLength(1);
    expect(has(contacts[0], 'eq', 'organizationId', 'org-A')).toBe(true);
    const orCall = contacts[0].calls.find((c) => c[0] === 'or');
    expect(orCall?.[1]).toBe(
      'company.ilike."Acme, Inc.",company.ilike."Bolt Labs",company.ilike."Quiet Co"',
    );
    // Only Company + Contact were queried — never one query per company.
    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
  });

  it('escapes LIKE wildcards and quotes in names used for contact matching', async () => {
    resolver = (table) =>
      table === 'Company'
        ? { data: [{ id: 'x', name: '100% "Real"_Co', hubspotId: null, deals: [] }], error: null, count: 1 }
        : { data: [{ company: '100% "real"_co' }], error: null };
    const app = await buildApp();
    const res = await request(app).get('/api/companies/list');
    const orCall = contactQueries()[0].calls.find((c) => c[0] === 'or');
    expect(orCall?.[1]).toBe('company.ilike."100\\\\% \\"Real\\"\\\\_Co"');
    expect(res.body.companies[0].contactCount).toBe(1);
  });

  it('skips the contact query when the page is empty', async () => {
    resolver = () => ({ data: [], error: null, count: 0 });
    const app = await buildApp();
    const res = await request(app).get('/api/companies/list?search=zzz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ companies: [], total: 0, limit: 25, offset: 0 });
    expect(contactQueries()).toHaveLength(0);
  });

  it('applies search, has-deals=yes, source=hubspot, sort and paging', async () => {
    const app = await buildApp();
    const res = await request(app).get(
      '/api/companies/list?search=ac_me&hasDeals=yes&source=hubspot&sortBy=updatedAt&limit=10&offset=20',
    );
    expect(res.status).toBe(200);
    const q = companyQuery();
    expect(has(q, 'ilike', 'name', '%ac\\_me%')).toBe(true);
    expect(has(q, 'not', 'deals', 'is', null)).toBe(true);
    expect(has(q, 'not', 'hubspotId', 'is', null)).toBe(true);
    expect(has(q, 'order', 'updatedAt', { ascending: false, nullsFirst: false })).toBe(true);
    expect(has(q, 'range', 20, 29)).toBe(true);
    expect(res.body).toMatchObject({ limit: 10, offset: 20 });
  });

  it('applies has-deals=no and source=avise', async () => {
    const app = await buildApp();
    await request(app).get('/api/companies/list?hasDeals=no&source=avise&sortBy=name&sortOrder=desc');
    const q = companyQuery();
    expect(has(q, 'is', 'deals', null)).toBe(true);
    expect(has(q, 'is', 'hubspotId', null)).toBe(true);
    expect(has(q, 'order', 'name', { ascending: false, nullsFirst: false })).toBe(true);
  });

  it('rejects bad query params', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/companies/list?limit=500')).status).toBe(400);
    expect((await request(app).get('/api/companies/list?hasDeals=maybe')).status).toBe(400);
    expect((await request(app).get('/api/companies/list?sortBy=revenue')).status).toBe(400);
  });

  it('returns 500 when the company query fails', async () => {
    resolver = () => ({ data: null, error: { message: 'db down' } });
    const app = await buildApp();
    const res = await request(app).get('/api/companies/list');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to list companies');
  });

  it('is routed before /:id (does not fall through to the single-company handler)', async () => {
    const app = await buildApp();
    await request(app).get('/api/companies/list');
    expect(has(companyQuery(), 'eq', 'id', 'list')).toBe(false);
  });
});

describe('GET /api/companies/:id/overview', () => {
  it('returns the company, its live deals and name-matched contacts, all org-scoped', async () => {
    resolver = (table, calls) => {
      if (table === 'Company' && calls.some((c) => c[0] === 'single')) {
        return { data: { id: 'c1', name: 'Acme, Inc.', hubspotId: 'hs-1' }, error: null };
      }
      if (table === 'Deal') return { data: [{ id: 'd1', name: 'Project Acme' }], error: null };
      if (table === 'Contact') return { data: [{ id: 'p1', firstName: 'Ann', lastName: 'Lee' }], error: null, count: 1 };
      return { data: [], error: null };
    };
    const app = await buildApp();
    const res = await request(app).get('/api/companies/c1/overview');

    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ id: 'c1', source: 'hubspot' });
    expect(res.body.deals).toEqual([{ id: 'd1', name: 'Project Acme' }]);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contactTotal).toBe(1);

    const company = recorded.find((r) => r.table === 'Company');
    expect(has(company, 'eq', 'organizationId', 'org-A')).toBe(true);
    const deal = recorded.find((r) => r.table === 'Deal');
    expect(has(deal, 'eq', 'companyId', 'c1')).toBe(true);
    expect(has(deal, 'eq', 'organizationId', 'org-A')).toBe(true);
    expect(has(deal, 'is', 'deletedAt', null)).toBe(true);
    const contact = recorded.find((r) => r.table === 'Contact');
    expect(has(contact, 'eq', 'organizationId', 'org-A')).toBe(true);
    expect(has(contact, 'ilike', 'company', 'Acme, Inc.')).toBe(true);
  });

  it('404s for a company outside the caller org', async () => {
    resolver = () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    const app = await buildApp();
    const res = await request(app).get('/api/companies/other-org-co/overview');
    expect(res.status).toBe(404);
    expect(recorded.some((r) => r.table === 'Deal' || r.table === 'Contact')).toBe(false);
  });
});
