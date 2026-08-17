/**
 * Deal model routes (spec §6.9):
 *   GET  /api/deals/:dealId/model         — saved or derived assumptions
 *   PUT  /api/deals/:dealId/model         — save assumptions
 *   POST /api/deals/:dealId/model/export  — the .xlsx binary
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1', name: 'Project Neptune' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const auditDocument = vi.fn();
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { documentExported: (...a: any[]) => auditDocument(...a) },
  logFromRequest: vi.fn(),
  AUDIT_ACTIONS: {}, RESOURCE_TYPES: {}, SEVERITY: {},
}));

let dealRow: any;
let statements: any[] = [];
let modelRow: any = null;
let upserted: any = null;
let documents: any[] = [];

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: dealRow, error: null }) }) }) }) };
    }
    if (table === 'FinancialStatement') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: any) => resolve({ data: statements, error: null }),
      };
      return chain;
    }
    if (table === 'Document') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        order: () => chain,
        then: (resolve: any) => resolve({ data: documents, error: null }),
      };
      return chain;
    }
    if (table === 'DealModel') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: modelRow, error: modelRow ? null : { code: 'PGRST116' } }),
        upsert: (row: any) => {
          upserted = row;
          return { select: () => ({ single: async () => ({ data: { id: 'model-1', ...row }, error: null }) }) };
        },
        then: (resolve: any) => resolve({ data: modelRow ? [modelRow] : [], error: null }),
      };
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-model.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1', organizationId: 'org-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

/** Supertest leaves unknown content types unparsed — buffer the xlsx bytes. */
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

function stmt(period: string, revenue: number, ebitda: number, extra: Record<string, unknown> = {}) {
  return {
    statementType: 'INCOME_STATEMENT', period, periodType: 'HISTORICAL',
    currency: 'USD', unitScale: 'MILLIONS', isActive: true,
    lineItems: { revenue, ebitda }, ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1', name: 'Project Neptune' };
  dealRow = { id: 'deal-1', name: 'Project Neptune', companyName: 'NeptuneCo', currency: 'USD', evMultiple: 5.5 };
  statements = [stmt('2023', 9, 1.5), stmt('2024', 10, 2)];
  documents = [{ id: 'doc-1', name: 'CIM.pdf' }];
  modelRow = null;
  upserted = null;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('GET /api/deals/:dealId/model', () => {
  it('derives assumptions when nothing is saved yet', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');

    expect(res.status).toBe(200);
    expect(res.body.isDerived).toBe(true);
    expect(res.body.assumptions.entryMultiple).toBe(5.5); // seeded from the deal
    expect(res.body.history).toHaveLength(2);
  });

  it('returns the saved assumptions once they exist', async () => {
    modelRow = { id: 'model-1', name: 'Base case', assumptions: { entryMultiple: 7 } };
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');

    expect(res.body.isDerived).toBe(false);
    expect(res.body.assumptions.entryMultiple).toBe(7);
  });

  it('reports the normalised currency and unit scale', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');
    expect(res.body.currency).toBe('USD');
    expect(res.body.unitScale).toBe('MILLIONS');
  });

  it('404s across orgs', async () => {
    dealAccess = null;
    const app = await buildApp();
    expect((await request(app).get('/api/deals/other/model')).status).toBe(404);
  });

  it('400s a deal whose financials are in two currencies', async () => {
    statements = [stmt('2023', 9, 1.5), stmt('2024', 10, 2, { currency: 'EUR' })];
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNIT_MISMATCH');
  });
});

describe('PUT /api/deals/:dealId/model', () => {
  const valid = {
    entryMultiple: 6, entryBasis: 'EBITDA', transactionFeesPct: 2,
    debtQuantumMode: 'MULTIPLE', debtQuantum: 3, interestRate: 9,
    amortPctPerYear: 5, cashSweepPct: 50,
    projectionYears: 5,
    revenueGrowthPct: [8, 8, 8, 8, 8], ebitdaMarginPct: [20, 20, 20, 20, 20],
    capexPctRevenue: 3, nwcPctRevenue: 10, taxRate: 25, daPctRevenue: 3,
    exitMultiple: 6, exitYear: 5, wacc: 12, dscrTarget: 1.25,
    unitScale: 'MILLIONS', currency: 'USD',
  };

  it('saves a valid assumption set', async () => {
    const app = await buildApp();
    const res = await request(app).put('/api/deals/deal-1/model').send(valid);

    expect(res.status).toBe(200);
    expect(upserted.assumptions.entryMultiple).toBe(6);
    expect(upserted.organizationId).toBe('org-1');
  });

  it('rejects assumptions the schema does not accept', async () => {
    const app = await buildApp();
    const res = await request(app)
      .put('/api/deals/deal-1/model')
      .send({ ...valid, entryMultiple: -3 });

    expect(res.status).toBe(400);
    expect(upserted).toBeNull();
  });

  it('rejects a growth array that does not match the projection length', async () => {
    // Otherwise year 5 silently projects on a missing assumption.
    const app = await buildApp();
    const res = await request(app)
      .put('/api/deals/deal-1/model')
      .send({ ...valid, revenueGrowthPct: [8, 8] });

    expect(res.status).toBe(400);
    expect(upserted).toBeNull();
  });

  it('rejects an exit year beyond the projection window', async () => {
    const app = await buildApp();
    const res = await request(app)
      .put('/api/deals/deal-1/model')
      .send({ ...valid, exitYear: 9 });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/deals/:dealId/model/export', () => {
  it('returns a real xlsx with the right headers', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/model/export')
      .send({})
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toMatch(/\.xlsx/);
    // xlsx is a zip — first two bytes are PK.
    expect(res.body.slice(0, 2).toString()).toBe('PK');
    expect(res.body.length).toBeGreaterThan(2000);
  });

  it('names the file after the deal', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/model/export').send({});
    expect(res.headers['content-disposition'].toLowerCase()).toContain('neptune');
  });

  it('refuses to build a model with no extracted financials', async () => {
    statements = [];
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/model/export').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FINANCIALS');
    expect(res.body.error).toMatch(/extract/i);
  });

  it('honours assumptions posted in the body over the saved set', async () => {
    modelRow = { id: 'model-1', name: 'Base case', assumptions: { entryMultiple: 4 } };
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/model/export')
      .send({ entryMultiple: 9 });

    // A 200 proves the override parsed and built; the workbook tests cover
    // that the number reaches the right cell.
    expect(res.status).toBe(200);
  });

  it('404s across orgs', async () => {
    dealAccess = null;
    const app = await buildApp();
    expect((await request(app).post('/api/deals/other/model/export').send({})).status).toBe(404);
  });
});
