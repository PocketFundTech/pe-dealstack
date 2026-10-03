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

// Columns Deal actually has in production (verified against the live schema
// 2026-08-18). companyName and evMultiple are NOT among them.
const DEAL_COLUMNS = [
  'id', 'name', 'stage', 'industry', 'description', 'dealSize', 'revenue',
  'ebitda', 'currency', 'companyId', 'organizationId', 'scorecard',
  'passReason', 'passedAt', 'revisitAt', 'lastRescoredAt', 'scorecardHistory',
];
/** Reject a select naming a column Deal does not have, like PostgREST does. */
function badColumns(sel: string): string[] {
  return sel.split(',').map((s) => s.trim())
    .filter((s) => s && !s.includes('(') && !DEAL_COLUMNS.includes(s));
}

let dealRow: any;
let statements: any[] = [];
let modelRow: any = null;
/** Several saved cases; overrides modelRow when set. */
let modelRows: any[] | null = null;
let upserted: any = null;
let documents: any[] = [];

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return {
        select: (sel: string) => {
          const bad = badColumns(sel);
          return { eq: () => ({ eq: () => ({ single: async () =>
            bad.length
              ? { data: null, error: { message: `column Deal.${bad[0]} does not exist` } }
              : { data: dealRow, error: null } }) }) };
        },
      };
    }
    if (table === 'FinancialStatement') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: any) => resolve(statementsError ? { data: null, error: statementsError } : { data: statements, error: null }),
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
        then: (resolve: any) => resolve({ data: modelRows ?? (modelRow ? [modelRow] : []), error: null }),
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

let statementsError: { message: string; code?: string } | null = null;

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
  // dealSize/ebitda give an implied 5.5x entry multiple; company name
  // comes from the relation join, not a Deal column.
  dealRow = { id: 'deal-1', name: 'Project Neptune', currency: 'USD',
    dealSize: 11, ebitda: 2, company: { name: 'NeptuneCo' } };
  statements = [stmt('2023', 9, 1.5), stmt('2024', 10, 2)];
  documents = [{ id: 'doc-1', name: 'CIM.pdf' }];
  modelRow = null;
  modelRows = null;
  upserted = null;
  statementsError = null;
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

  it('ignores the deal-record multiple when its EBITDA disagrees with the statements (SRM: 6.1 vs 2.21)', async () => {
    // Deal record: size 33.55 / EBITDA 6.1 → 5.5x. Statements: EBITDA 2.21.
    // 5.5x on 2.21 would be a different deal than the one on the record, so
    // the default falls back to 5x and both figures are named.
    dealRow = { ...dealRow, dealSize: 33.55, ebitda: 6.1 };
    statements = [stmt('2023', 20.9, 1.9), stmt('2024', 27.3, 2.21)];
    const app = await buildApp();
    for (const path of ['/api/deals/deal-1/model', '/api/deals/deal-1/model/cases']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      const a = path.endsWith('cases') ? res.body.cases.find((c: { case: string }) => c.case === 'Base').assumptions : res.body.assumptions;
      expect(a.entryMultiple).toBe(5);
      const text = res.body.warnings.join(' ');
      expect(text).toContain('2.21');
      expect(text).toContain('6.10');
      expect(text).toContain('5.0x');
    }
  });

  it('warns when a unit-scale break in the history produces unrealistic returns (Luktara: 942% IRR)', async () => {
    // As on Luktara: the base year has no EBITDA, so entry uses the deal
    // record's small figure while projections run off revenue read 1,000x too big.
    statements = [stmt('2023', 9, 1.5), stmt('2024', 10_000, null as unknown as number)];
    const app = await buildApp();
    for (const path of ['/api/deals/deal-1/model', '/api/deals/deal-1/model/cases']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.warnings.join(' ')).toMatch(/not realistic for a buyout/);
    }
  });

  it('keeps the deal-record multiple and warns nothing when the two EBITDAs agree', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');
    expect(res.body.assumptions.entryMultiple).toBe(5.5);
    expect(res.body.warnings).toEqual([]);
  });

  it('a failed statements read is a 503 with the reason — not an empty "no financials" model', async () => {
    statementsError = { message: 'connection terminated', code: '08006' };
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model/cases');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MODEL_DB_ERROR');
    expect(res.body.error).toContain("financial statements");
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

  it('returns the line catalogue, base values and a driver per line (E1)', async () => {
    statements = [stmt('2023', 9, 1.5, { lineItems: { revenue: 9, cogs: 5, cogs_cement: 3, ebitda: 1.5 } }),
      stmt('2024', 10, 2, { lineItems: { revenue: 10, cogs: 6, cogs_cement: 3.5, ebitda: 2 } })];
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');
    const keys = res.body.lines.map((l: { key: string }) => l.key);
    expect(keys).toEqual(expect.arrayContaining(['revenue', 'cogs', 'cogs_cement', 'cogs__other', 'gross_profit', 'ebitda']));
    expect(res.body.baseValues.cogs_cement).toBe(3.5);
    expect(res.body.base).toMatchObject({ revenue: 10, ebitda: 2, entrySource: 'base' });
    expect(res.body.assumptions.lineDrivers.cogs_cement.method).toBe('PCT_REVENUE');
  });

  it('loads a pre-E1 saved row by migrating growth / margin into line drivers', async () => {
    modelRow = { id: 'model-1', name: 'Base case', assumptions: { entryMultiple: 7, revenueGrowthPct: [6, 6, 6, 6, 6], ebitdaMarginPct: [25, 25, 25, 25, 25] } };
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');
    expect(res.body.assumptions.entryMultiple).toBe(7);
    expect(res.body.assumptions.lineDrivers.revenue).toEqual({ method: 'GROWTH', values: [6, 6, 6, 6, 6] });
    expect(res.body.assumptions.lineDrivers.total_opex.values[0]).toBeCloseTo(75, 6);
    expect(res.body.assumptions.revenueGrowthPct).toBeUndefined();
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

  it('saves per-line drivers', async () => {
    const { revenueGrowthPct: _g, ebitdaMarginPct: _m, daPctRevenue: _d, ...rest } = valid;
    const body = { ...rest, lineDrivers: { revenue: { method: 'GROWTH', values: [5, 5, 5, 5, 5] }, ebitda: { method: 'SUBTOTAL', values: [] } } };
    const app = await buildApp();
    const res = await request(app).put('/api/deals/deal-1/model').send(body);
    expect(res.status).toBe(200);
    expect(upserted.assumptions.lineDrivers.revenue.values).toEqual([5, 5, 5, 5, 5]);
  });

  it('rejects a line driver with the wrong number of years, or an absurd %', async () => {
    const app = await buildApp();
    const short = await request(app).put('/api/deals/deal-1/model')
      .send({ ...valid, lineDrivers: { revenue: { method: 'GROWTH', values: [5] } } });
    expect(short.status).toBe(400);
    const absurd = await request(app).put('/api/deals/deal-1/model')
      .send({ ...valid, lineDrivers: { cogs: { method: 'PCT_REVENUE', values: [900, 9, 9, 9, 9] } } });
    expect(absurd.status).toBe(400);
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

  it('explains on the Notes sheet why the default multiple is not the deal record\'s', async () => {
    dealRow = { ...dealRow, dealSize: 33.55, ebitda: 6.1 };
    statements = [stmt('2023', 20.9, 1.9), stmt('2024', 27.3, 2.21)];
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/model/export').send({}).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    const notes = JSON.stringify(wb.getWorksheet('Notes')!.getSheetValues());
    expect(notes).toContain('not the deal record');
    expect(notes).toContain('the deal record says 6.10');
  });

  it('puts the unrealistic-returns warning on the Notes sheet', async () => {
    statements = [stmt('2023', 9, 1.5), stmt('2024', 10_000, null as unknown as number)];
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/model/export').send({}).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    expect(JSON.stringify(wb.getWorksheet('Notes')!.getSheetValues())).toContain('not realistic for a buyout');
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

describe('Low / Base / High cases (fix plan E2)', () => {
  it('GET ?case=Low seeds Low from the saved Base when Low was never saved', async () => {
    modelRow = { id: 'model-1', name: 'Base case', assumptions: { exitMultiple: 6 } };
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model?case=Low');
    expect(res.status).toBe(200);
    expect(res.body.case).toBe('Low');
    expect(res.body.seededFromBase).toBe(true);
    expect(res.body.isDerived).toBe(true);
    expect(res.body.assumptions.exitMultiple).toBe(5); // 6 − 1.0x
  });

  it('GET ?case=High returns the saved High row', async () => {
    modelRows = [
      { name: 'Base case', assumptions: { exitMultiple: 6 } },
      { name: 'High case', assumptions: { exitMultiple: 9 } },
    ];
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model?case=high');
    expect(res.body.assumptions.exitMultiple).toBe(9);
    expect(res.body.isDerived).toBe(false);
    expect(res.body.seededFromBase).toBe(false);
  });

  it('400s an unknown case', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model?case=Upside');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CASE');
  });

  it('PUT ?case=High saves under "High case"; no case still saves Base', async () => {
    const app = await buildApp();
    const body = {
      entryMultiple: 6, entryBasis: 'EBITDA', transactionFeesPct: 2, debtQuantumMode: 'MULTIPLE', debtQuantum: 3,
      interestRate: 9, amortPctPerYear: 5, cashSweepPct: 50, projectionYears: 5, capexPctRevenue: 3,
      nwcPctRevenue: 10, taxRate: 25, exitMultiple: 7, exitYear: 5, wacc: 12, dscrTarget: 1.25,
      unitScale: 'MILLIONS', currency: 'USD',
    };
    await request(app).put('/api/deals/deal-1/model?case=High').send(body);
    expect(upserted.name).toBe('High case');
    await request(app).put('/api/deals/deal-1/model').send(body);
    expect(upserted.name).toBe('Base case');
    const bad = await request(app).put('/api/deals/deal-1/model?case=Upside').send(body);
    expect(bad.status).toBe(400);
  });

  it('GET /model/cases returns all three cases with saved flags and summaries', async () => {
    modelRows = [{ name: 'Low case', assumptions: { exitMultiple: 3 } }];
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model/cases');
    expect(res.status).toBe(200);
    expect(res.body.cases.map((c: any) => [c.case, c.name, c.saved])).toEqual([
      ['Low', 'Low case', true], ['Base', 'Base case', false], ['High', 'High case', false],
    ]);
    const [low, base, high] = res.body.cases;
    expect(low.assumptions.exitMultiple).toBe(3);
    expect(high.assumptions.exitMultiple).toBe(base.assumptions.exitMultiple + 1);
    expect(low.summary.exitEv).toBeLessThan(base.summary.exitEv);
    expect(high.summary.irr).toBeGreaterThan(base.summary.irr);
    expect(res.body.deltas.High).toEqual({ revenueGrowthPp: 3, ebitdaMarginPp: 2, exitMultipleX: 1 });
    expect(res.body.lines.length).toBeGreaterThan(5);
  });

  it('export carries all three cases and opens on the requested one', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/model/export?case=Base')
      .send({ cases: { High: { exitMultiple: 12 } }, activeCase: 'High' })
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const a = wb.getWorksheet('Assumptions')!;
    expect(a.getCell('B4').value).toBe('High');
    let exitRow = 0;
    a.eachRow((row, n) => { if (row.getCell(1).value === 'Exit multiple') exitRow = n; });
    expect(a.getCell(exitRow, 4).value).toBe(12); // High column
    expect(wb.getWorksheet('Scenarios')).toBeTruthy();
  });
});

describe('balance sheet + cash flow (fix plan E3)', () => {
  const side = (statementType: string, period: string, lineItems: Record<string, number>) =>
    ({ ...stmt(period, 0, 0), statementType, lineItems });
  const withBalance = () => [
    stmt('2023', 9, 1.5, { lineItems: { revenue: 9, cogs: 5, ebitda: 1.5 } }),
    stmt('2024', 10, 2, { lineItems: { revenue: 10, cogs: 6, ebitda: 2 } }),
    side('BALANCE_SHEET', '2024', { accounts_receivable: 1.5, inventory: 0.6, accounts_payable: 0.9, cash: 0.4, total_debt: 3 }),
    side('CASH_FLOW', '2024', { capex: -0.5 }),
  ];

  it('GET /model/cases returns the opening balances and seeds days + capex from them', async () => {
    statements = withBalance();
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model/cases');
    expect(res.status).toBe(200);
    expect(res.body.opening).toEqual({ period: '2024', ar: 1.5, inventory: 0.6, ap: 0.9, cash: 0.4, debt: 3 });
    const bd = res.body.cases[1].assumptions.balanceDrivers;
    expect(bd.nwcMethod).toBe('DAYS');
    expect(bd.dso[0]).toBeCloseTo(54.8, 6); // 1.5 / 10 × 365
    expect(bd.capexPct[0]).toBe(5);
    expect(res.body.cases[0].assumptions.balanceDrivers).toEqual(bd); // Low starts equal to Base
    expect(res.body.cases[1].summary.irr).not.toBeNull();
  });

  it('loads a pre-E3 saved row: scalar NWC / capex become % of revenue drivers', async () => {
    statements = withBalance();
    modelRow = { id: 'model-1', name: 'Base case', assumptions: { nwcPctRevenue: 8, capexPctRevenue: 2 } };
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/model');
    expect(res.body.assumptions.balanceDrivers).toMatchObject({ nwcMethod: 'PCT_REVENUE', nwcPct: [8, 8, 8, 8, 8], capexMethod: 'TOTAL', capexPct: [2, 2, 2, 2, 2] });
    expect(res.body.assumptions.nwcPctRevenue).toBeUndefined();
    expect(res.body.assumptions.debt2Quantum).toBe(0);
  });

  it('PUT accepts balance drivers and tranches, and rejects a series of the wrong length', async () => {
    statements = withBalance();
    const app = await buildApp();
    const { body: got } = await request(app).get('/api/deals/deal-1/model');
    const ok = await request(app).put('/api/deals/deal-1/model').send({ ...got.assumptions, debt2Quantum: 1, minCash: 0.3 });
    expect(ok.status).toBe(200);
    expect(upserted.assumptions.balanceDrivers.dso).toHaveLength(5);
    expect(upserted.assumptions.minCash).toBe(0.3);
    const bad = await request(app).put('/api/deals/deal-1/model').send({
      ...got.assumptions, balanceDrivers: { ...got.assumptions.balanceDrivers, dso: [40, 40] },
    });
    expect(bad.status).toBe(400);
  });
});

describe('modelErrorResponse', () => {
  it('an unknown failure says it is on our side and carries a reference', async () => {
    const { modelErrorResponse } = await import('../src/routes/deals-model.js');
    const { status, body } = modelErrorResponse(new TypeError("Cannot read properties of undefined (reading 'values')"));
    expect(status).toBe(500);
    expect(body.code).toBe('MODEL_BUILD_FAILED');
    expect(body.error).toContain('not a problem with your data');
    expect(body.error).toContain(body.ref!);
  });
});

describe('deal-record units (G15)', () => {
  it('reads whole-dollar records as whole dollars, using the deal size as a hint', async () => {
    const { dealEbitdaMillions } = await import('../src/routes/deals-model.js');
    expect(dealEbitdaMillions(2.21)).toBe(2.21);
    expect(dealEbitdaMillions(150)).toBe(150);                 // $150M, in millions
    expect(dealEbitdaMillions(150_000)).toBe(0.15);            // $150K in whole dollars
    expect(dealEbitdaMillions(50_000, 400_000)).toBe(0.05);    // both whole dollars
    expect(dealEbitdaMillions(50_000, 400)).toBe(50_000);      // deal size in millions: unchanged
  });

  it('ignores an implied multiple that is not believable', async () => {
    const { impliedEvMultiple } = await import('../src/routes/deals-model.js');
    expect(impliedEvMultiple(11, 2)).toBe(5.5);
    expect(impliedEvMultiple(11, 150_000)).toBeNull();         // millions over whole dollars
    expect(impliedEvMultiple(5_000, 2)).toBeNull();            // 2,500x
  });

  it('forces the model to millions whatever a saved case says', async () => {
    const { resolveAssumptions } = await import('../src/services/dealModel/assumptions.js');
    const a = resolveAssumptions({ unitScale: 'THOUSANDS' }, [{ period: '2024', revenue: 10, ebitda: 2 }]);
    expect(a.unitScale).toBe('MILLIONS');
  });
});
