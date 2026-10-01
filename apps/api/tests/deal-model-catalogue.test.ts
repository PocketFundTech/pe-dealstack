/**
 * Fix plan E1 — the line catalogue: every P&L line becomes a model line,
 * raw accounts (#164 `<parent>_<label>` keys) nest under their parent, and
 * parents that don't tie to their accounts get an "Other (unallocated)" line.
 */
import { describe, it, expect } from 'vitest';
import { normaliseStatements, type HistoricalRow } from '../src/services/dealModel/assumptions.js';
import { buildLineCatalogue, baseColumnValues, evaluateLine } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { SRM_STATEMENTS } from './helpers/srmModelFixture.js';

const history = normaliseStatements(SRM_STATEMENTS).rows;
const cat = buildLineCatalogue(history);
const keys = cat.lines.map((l) => l.key);
const line = (k: string) => cat.lines.find((l) => l.key === k)!;

describe('buildLineCatalogue — SRM shape', () => {
  it('keeps every standard line, in statement order', () => {
    const top = cat.lines.filter((l) => l.level === 0).map((l) => l.key);
    expect(top).toEqual([
      'revenue', 'cogs', 'gross_profit', 'total_opex', 'ebitda', 'da', 'ebit',
      'interest_expense', 'other_income', 'ebt', 'tax', 'net_income',
    ]);
  });

  it('nests raw accounts under their parent, biggest first', () => {
    const cogsChildren = cat.lines.filter((l) => l.parent === 'cogs').map((l) => l.key);
    expect(cogsChildren).toEqual(['cogs_cement', 'cogs_labour', 'cogs_sand_cos', 'cogs_fly_ash', 'cogs__other']);
    expect(line('cogs_fly_ash')).toMatchObject({ kind: 'INPUT', level: 1, label: 'Fly ash', costLine: true });
    expect(line('cogs_sand_cos').label).toBe('Sand COS');
    expect(cat.lines.filter((l) => l.parent === 'revenue').map((l) => l.key)).toEqual(['revenue_sales', 'revenue_discounts']);
  });

  it('makes parents the sum of their accounts and subtotals signed formulas', () => {
    expect(line('cogs').kind).toBe('SUM');
    expect(line('cogs').components!.map((c) => c.key)).toContain('cogs__other');
    expect(line('gross_profit')).toMatchObject({ kind: 'SUBTOTAL', components: [{ key: 'revenue', sign: 1 }, { key: 'cogs', sign: -1 }] });
    expect(line('ebitda').components).toEqual([{ key: 'gross_profit', sign: 1 }, { key: 'total_opex', sign: -1 }]);
    expect(line('ebt').components).toEqual([
      { key: 'ebit', sign: 1 }, { key: 'interest_expense', sign: -1 }, { key: 'other_income', sign: 1 },
    ]);
    expect(line('interest_expense')).toMatchObject({ kind: 'COMPUTED', computed: 'INTEREST' });
    expect(line('tax')).toMatchObject({ kind: 'COMPUTED', computed: 'TAX' });
  });

  it('adds an unallocated line only where accounts do not add up to the printed total', () => {
    // Revenue: 21.3 − 0.3 = 21.0 ties → no remainder.
    expect(keys).not.toContain('revenue__other');
    const fy24 = cat.periods[1].values;
    expect(fy24.cogs__other).toBeCloseTo(20.0 - (8.2 + 5.2 + 3.6 + 2.0), 3);
    expect(fy24.total_opex__other).toBeCloseTo(4.5 - 1.9, 3);
    expect(line('total_opex__other').label).toBe('Other (unallocated)');
  });

  it('every parent and subtotal reproduces the printed figure', () => {
    const fy24 = cat.periods[1].values;
    expect(evaluateLine(cat.lines, fy24, 'cogs')).toBeCloseTo(20.0, 3);
    expect(evaluateLine(cat.lines, fy24, 'ebitda')).toBeCloseTo(2.8, 3);
    expect(evaluateLine(cat.lines, fy24, 'net_income')).toBeCloseTo(1.35, 3);
  });
});

describe('buildLineCatalogue — gaps and implied figures', () => {
  const rows = (lines: Array<Record<string, number>>): HistoricalRow[] =>
    lines.map((l, i) => ({ period: String(2022 + i), lines: l }));

  it('implies COGS from revenue − gross profit and operating costs from GP − EBITDA', () => {
    const c = buildLineCatalogue(rows([{ revenue: 10, gross_profit: 4, ebitda: 1.5 }]));
    expect(c.periods[0].values.cogs).toBe(6);
    expect(c.periods[0].values.total_opex).toBe(2.5);
    expect(c.periods[0].implied).toEqual(expect.arrayContaining(['cogs', 'total_opex']));
  });

  it('always has an operating cost line so EBITDA is never just revenue', () => {
    const c = buildLineCatalogue(rows([{ revenue: 10, ebitda: 2 }]));
    expect(c.lines.map((l) => l.key)).toContain('total_opex');
    expect(c.lines.find((l) => l.key === 'ebitda')!.components).toEqual([
      { key: 'revenue', sign: 1 }, { key: 'total_opex', sign: -1 },
    ]);
    expect(c.periods[0].values.total_opex).toBe(8);
  });

  it('lists accounts it cannot place instead of guessing', () => {
    const c = buildLineCatalogue(rows([{ revenue: 10, ebitda: 2, sand_cos: 1 }]));
    expect(c.unclassified).toEqual(['sand_cos']);
  });

  it('shows accounts of interest and tax in history only', () => {
    const c = buildLineCatalogue(rows([{ revenue: 10, ebitda: 2, interest_expense: 0.5, interest_expense_bank_loan: 0.5 }]));
    expect(c.lines.find((l) => l.key === 'interest_expense_bank_loan')).toMatchObject({ historicalOnly: true, level: 1 });
  });
});

describe('baseColumnValues', () => {
  it('uses the last full year — never the YTD — as the base', () => {
    const base = selectBasePeriod(history);
    const col = baseColumnValues(cat, history, base);
    expect(col.entrySource).toBe('base');
    expect(col.values.cogs_cement).toBe(8.2);
    expect(evaluateLine(cat.lines, col.values, 'ebitda')).toBeCloseTo(2.8, 3);
  });

  it("enters the deal's EBITDA through an implied cost when the base has none", () => {
    const h: HistoricalRow[] = [{ period: '2024', revenue: 10 }];
    const c = buildLineCatalogue(h);
    const col = baseColumnValues(c, h, selectBasePeriod(h), 1.5);
    expect(col.entrySource).toBe('deal');
    expect(evaluateLine(c.lines, col.values, 'ebitda')).toBeCloseTo(1.5, 6);
    const none = baseColumnValues(c, h, selectBasePeriod(h), null);
    expect(none.entrySource).toBe('missing');
    expect(evaluateLine(c.lines, none.values, 'ebitda')).toBe(0);
  });
});
