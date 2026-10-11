import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * POST /api/ingest/:dealId/review renamed the deal's Company with
 * `.eq('id', deal.companyId)` only. Combined with a deal linked to a foreign
 * companyId (now also blocked in deals-mutate), that renamed another org's
 * company. Every write here is now bound to the caller's org.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => mock.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: (req: any) => req.user.organizationId }));
for (const sub of ['ingest-upload', 'ingest-drive', 'ingest-text', 'ingest-url', 'ingest-email']) {
  vi.doMock(`../src/routes/${sub}.js`, () => ({ default: Router() }));
}

async function buildApp() {
  const { default: router } = await import('../src/routes/ingest.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A' };
    next();
  });
  app.use('/api/ingest', router);
  return app;
}

beforeEach(() => {
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    if (op.table === 'Deal' && op.action === 'select') {
      return { data: { id: 'deal-a', organizationId: 'org-A', companyId: 'company-x' } };
    }
    if (op.table === 'Deal') return { data: { id: 'deal-a' } };
    return { data: null };
  };
});

describe('POST /api/ingest/:dealId/review — writes stay in the caller org', () => {
  it('scopes the Company rename and the Deal update to the caller org', async () => {
    const res = await request(await buildApp())
      .post('/api/ingest/deal-a/review')
      .send({ approved: true, companyName: 'Renamed', industry: 'SaaS' });
    expect(res.status).toBe(200);

    const companyUpdate = mock.calls.find((c) => c.table === 'Company' && c.action === 'update');
    expect(companyUpdate).toBeDefined();
    expect(filterValue(companyUpdate!, 'organizationId')).toBe('org-A');

    const dealUpdate = mock.calls.find((c) => c.table === 'Deal' && c.action === 'update');
    expect(filterValue(dealUpdate!, 'organizationId')).toBe('org-A');
  });
});
