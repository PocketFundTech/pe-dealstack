/**
 * Fix plan B1 (real statements beat derived models) + A4 (canonical period
 * matching), through runDeepPass against an in-memory FinancialStatement table.
 * SRM scenario: the valuation summary wrote "2024" first; the LBO workbook's
 * reported "BS Source" tab must take the active slot for FY2024 anyway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassificationResult } from '../src/services/financialClassifier.js';

type Row = Record<string, any>;
const db: { FinancialStatement: Row[]; Document: Row[] } = { FinancialStatement: [], Document: [] };
let failOnExtendedColumns = false;
let nextId = 1;

/** Minimal chainable PostgREST-ish builder over the arrays above. */
function from(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: { kind: 'select' } | { kind: 'update'; patch: Row } | { kind: 'upsert'; row: Row } = { kind: 'select' };
  const run = () => {
    if (op.kind === 'select') return { data: db[table].filter((r) => filters.every((f) => f(r))), error: null };
    if (op.kind === 'update') {
      for (const r of db[table]) if (filters.every((f) => f(r))) Object.assign(r, (op as any).patch);
      return { data: null, error: null };
    }
    const row = (op as any).row as Row;
    if (failOnExtendedColumns && 'periodKey' in row) {
      return { data: null, error: { code: 'PGRST204', message: "Could not find the 'periodKey' column in the schema cache" } };
    }
    const existing = db[table].find((r) => ['dealId', 'statementType', 'period', 'documentId'].every((k) => r[k] === row[k]));
    if (existing) { Object.assign(existing, row); return { data: { id: existing.id }, error: null }; }
    const created = { id: `row-${nextId++}`, ...row };
    db[table].push(created);
    return { data: { id: created.id }, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
    limit: () => b,
    order: () => b,
    update: (patch: Row) => { op = { kind: 'update', patch }; return b; },
    upsert: (row: Row) => { op = { kind: 'upsert', row }; return b; },
    single: () => Promise.resolve(run()),
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: any) => from(t) } }));
vi.mock('../src/services/dealCacheWriteback.js', () => ({ refreshDealCache: async () => {} }));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));

const { runDeepPass } = await import('../src/services/financialExtractionOrchestrator.js');
const { resetExtendedColumnsProbe } = await import('../src/services/financialStatementStore.js');

const bs = (period: string, lineItems: Record<string, number>, extra: Record<string, unknown> = {}): ClassificationResult => ({
  statements: [{
    statementType: 'BALANCE_SHEET', unitScale: 'MILLIONS', currency: 'USD',
    periods: [{ period, periodType: 'HISTORICAL', confidence: 90, lineItems }],
    ...extra,
  }],
  overallConfidence: 90,
  warnings: [],
} as ClassificationResult);

const active = () => db.FinancialStatement.filter((r) => r.isActive);

beforeEach(() => {
  db.FinancialStatement = [];
  db.Document = [
    { id: 'doc-val', dealId: 'd1', name: 'SRM_Valuation_Summary_.xlsx', type: 'FINANCIALS' },
    { id: 'doc-lbo', dealId: 'd1', name: 'SRM LBO.xlsx', type: 'FINANCIALS' },
    { id: 'doc-cim', dealId: 'd1', name: 'SRM CIM.pdf', type: 'CIM' },
  ];
  failOnExtendedColumns = false;
  resetExtendedColumnsProbe();
});

describe('runDeepPass source selection (B1 + A4)', () => {
  it('the reported statement takes over from the valuation summary even though it wrote second', async () => {
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-val', classification: bs('2024', { cash: 1, long_term_debt: 2 }) });
    await runDeepPass({
      text: '', dealId: 'd1', documentId: 'doc-lbo',
      classification: bs('FY2024 (Jan - Dec 2024)', { cash: 1.1, total_assets: 20, total_liabilities: 12, total_equity: 8 },
        { sheetName: 'BS Source', sourceKind: 'source_statement' }),
    });
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({ documentId: 'doc-lbo', period: 'FY2024 (Jan - Dec 2024)', periodKey: '2024', sourceKind: 'source_statement', sheetName: 'BS Source' });
    expect(db.FinancialStatement.find((r) => r.documentId === 'doc-val')).toMatchObject({ isActive: false });
  });

  it('a valuation summary arriving later does not displace the reported statement', async () => {
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-lbo', classification: bs('2024', { cash: 1.1, total_assets: 20 }, { sourceKind: 'source_statement' }) });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-val', classification: bs('2024', { cash: 9, total_assets: 99, long_term_debt: 1, inventory: 2 }) });
    expect(active()).toHaveLength(1);
    expect(active()[0].documentId).toBe('doc-lbo');
    expect(db.FinancialStatement.find((r) => r.documentId === 'doc-val')).toMatchObject({ isActive: false, mergeStatus: 'auto', sourceKind: 'model_derived' });
  });

  it('a reported statement in a CIM beats a model-derived spreadsheet', async () => {
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-val', classification: bs('2024', { cash: 1 }) });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-cim', classification: bs('FY 2024', { cash: 1.2 }) });
    expect(active()[0].documentId).toBe('doc-cim');
  });

  it('equal sources: the more complete statement wins regardless of order', async () => {
    db.Document.push({ id: 'doc-a', dealId: 'd1', name: 'BS part.xlsx', type: 'FINANCIALS' });
    db.Document.push({ id: 'doc-b', dealId: 'd1', name: 'BS full.xlsx', type: 'FINANCIALS' });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-b', classification: bs('2024', { cash: 1, total_assets: 20, total_liabilities: 12, total_equity: 8 }) });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-a', classification: bs('2024', { cash: 1 }) });
    expect(active()[0].documentId).toBe('doc-b');
  });

  it('a genuine tie keeps the existing row and flags needs_review', async () => {
    db.Document.push({ id: 'doc-a', dealId: 'd1', name: 'A.xlsx', type: 'FINANCIALS' });
    db.Document.push({ id: 'doc-b', dealId: 'd1', name: 'B.xlsx', type: 'FINANCIALS' });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-a', classification: bs('2024', { cash: 1 }) });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-b', classification: bs('2024', { cash: 2 }) });
    expect(active()[0].documentId).toBe('doc-a');
    expect(db.FinancialStatement.find((r) => r.documentId === 'doc-b')).toMatchObject({ isActive: false, mergeStatus: 'needs_review' });
  });

  it('drops a model-derived statement when the same document also has the reported one', async () => {
    const classification: ClassificationResult = {
      statements: [
        { statementType: 'BALANCE_SHEET', unitScale: 'MILLIONS', currency: 'USD', sheetName: 'Valuation', sourceKind: 'model_derived',
          periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { goodwill: 50 } }] },
        { statementType: 'BALANCE_SHEET', unitScale: 'MILLIONS', currency: 'USD', sheetName: 'BS Source', sourceKind: 'source_statement',
          periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { cash: 1, total_assets: 20 } }] },
      ],
      overallConfidence: 90, warnings: [],
    } as ClassificationResult;
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-lbo', classification });
    expect(active()).toHaveLength(1);
    expect(active()[0].lineItems).toEqual({ cash: 1, total_assets: 20 });
  });

  it('works before the migration: retries without the new columns', async () => {
    failOnExtendedColumns = true;
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-lbo', classification: bs('2024', { cash: 1 }) });
    expect(active()).toHaveLength(1);
    expect(active()[0].periodKey).toBeUndefined();
    // Matching still works by parsing labels.
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-val', classification: bs('FY2024 (Jan - Dec 2024)', { cash: 9 }) });
    expect(active()).toHaveLength(1);
    expect(active()[0].documentId).toBe('doc-lbo');
  });

  it('re-extracting a document under a new label replaces its own old row', async () => {
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-lbo', classification: bs('2024', { cash: 1 }) });
    await runDeepPass({ text: '', dealId: 'd1', documentId: 'doc-lbo', classification: bs('FY2024 (Jan - Dec 2024)', { cash: 1.5 }) });
    expect(active()).toHaveLength(1);
    expect(active()[0].period).toBe('FY2024 (Jan - Dec 2024)');
  });
});

describe('restatements beat the figures they correct (G14)', () => {
  it('ranks a restated period or document above an original of equal kind', async () => {
    const { compareSources } = await import('../src/services/financialSourceSelection.js');
    const base = { sourceKind: 'source_statement' as const, statementType: 'INCOME_STATEMENT' as const };
    const original = { ...base, doc: { name: 'FS 2023.xlsx', type: 'FINANCIALS' }, lineItems: { revenue: 20, cogs: 12, sga: 3, net_income: 2 }, period: 'FY2023' };
    const restatedLabel = { ...base, doc: { name: 'Audit.pdf', type: 'OTHER' }, lineItems: { revenue: 19.4 }, period: 'FY2023 (Restated)' };
    const restatedDoc = { ...base, doc: { name: 'Restated_FS_2023.pdf', type: 'OTHER' }, lineItems: { revenue: 19.4 }, period: 'FY2023' };
    expect(compareSources(restatedLabel as never, original as never)).toBeGreaterThan(0);
    expect(compareSources(restatedDoc as never, original as never)).toBeGreaterThan(0);
    // Reported still beats model-derived, restated or not.
    expect(compareSources({ ...restatedLabel, sourceKind: 'model_derived' } as never, original as never)).toBeLessThan(0);
  });
});
