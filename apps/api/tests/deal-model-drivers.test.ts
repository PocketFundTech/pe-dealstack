/**
 * Fix plan E1 — per-line drivers: seeding from full-year history, loading
 * assumptions saved before E1, and the shared calculator the panel preview
 * uses (margin × revenue, consistent with the workbook).
 */
import { describe, it, expect } from 'vitest';
import { projectModel } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults, resolveAssumptions } from '../src/services/dealModel/assumptions.js';
import { buildLineCatalogue, baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { SRM_STATEMENTS } from './helpers/srmModelFixture.js';

const history = normaliseStatements(SRM_STATEMENTS).rows;
const cat = buildLineCatalogue(history);
const baseValues = baseColumnValues(cat, history, selectBasePeriod(history)).values;
const avg = (...xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('seeding drivers from full fiscal years', () => {
  const d = deriveDefaults(history).lineDrivers;

  it('grows every revenue account at the revenue CAGR (FY2023 → FY2024, clamped at 30%)', () => {
    expect(d.revenue).toEqual({ method: 'SUBTOTAL', values: [] }); // sum of its accounts
    expect(d.revenue_sales).toEqual({ method: 'GROWTH', values: [30, 30, 30, 30, 30] });
    expect(d.revenue_discounts.method).toBe('GROWTH');
  });

  it('seeds each cost account at its average % of revenue — ignoring the 9-month YTD', () => {
    expect(d.cogs_cement.method).toBe('PCT_REVENUE');
    expect(d.cogs_cement.values[0]).toBeCloseTo(avg(6.3 / 21, 8.2 / 27.3) * 100, 2);
    // With the YTD it would have been ≈ 30.2%; prove it was excluded.
    expect(d.cogs_fly_ash.values[0]).toBeCloseTo(avg(1.5 / 21, 2.0 / 27.3) * 100, 2);
    expect(d.total_opex__other.values[0]).toBeCloseTo(avg(1.9 / 21, 2.6 / 27.3) * 100, 2);
  });

  it('seeds D&A as % of revenue and other income as a fixed amount', () => {
    expect(d.da.values[0]).toBeCloseTo(avg(0.6 / 21, 0.7 / 27.3) * 100, 2);
    expect(d.other_income).toEqual({ method: 'FIXED', values: [0.15, 0.15, 0.15, 0.15, 0.15] });
  });

  it('never makes a subtotal an input', () => {
    for (const k of ['cogs', 'gross_profit', 'total_opex', 'ebitda', 'ebit', 'ebt', 'net_income', 'interest_expense', 'tax']) {
      expect(d[k].method).toBe('SUBTOTAL');
    }
  });
});

describe('backward-compatible loading of assumptions saved before E1', () => {
  const legacy = {
    ...deriveDefaults(history),
    lineDrivers: undefined,
    revenueGrowthPct: [8, 8, 8, 8, 8],
    ebitdaMarginPct: [20, 20, 21, 21, 22],
    daPctRevenue: 4,
  };

  it('migrates growth onto every revenue account and the margin into a consistent cost split', () => {
    const a = resolveAssumptions(legacy, history, {}, cat);
    expect(a.lineDrivers.revenue_sales.values).toEqual([8, 8, 8, 8, 8]);
    expect(a.lineDrivers.revenue_discounts.values).toEqual([8, 8, 8, 8, 8]);
    expect(a.lineDrivers.da).toEqual({ method: 'PCT_REVENUE', values: [4, 4, 4, 4, 4] });
    // Projected EBITDA margin equals the saved margin, year by year.
    const p = projectModel(cat.lines, baseValues, a);
    p.ebitdaMarginPct.forEach((m, y) => expect(m).toBeCloseTo(legacy.ebitdaMarginPct[y], 3));
    // The split keeps the historical mix: cement stays the biggest cost.
    expect(a.lineDrivers.cogs_cement.values[0]).toBeGreaterThan(a.lineDrivers.cogs_fly_ash.values[0]);
    expect('revenueGrowthPct' in a).toBe(false);
  });

  it('loads a partial saved set over the derived defaults', () => {
    const a = resolveAssumptions({ entryMultiple: 7 }, history, {}, cat);
    expect(a.entryMultiple).toBe(7);
    expect(a.lineDrivers.cogs_cement.method).toBe('PCT_REVENUE');
  });

  it('repairs saved drivers that no longer fit the catalogue', () => {
    const a = resolveAssumptions({
      lineDrivers: {
        revenue_sales: { method: 'PCT_REVENUE', values: [5, 5, 5, 5, 5] }, // circular — not allowed
        cogs_cement: { method: 'FIXED', values: [9, 10] },                // too short — padded
        ebitda: { method: 'FIXED', values: [1, 1, 1, 1, 1] },             // a subtotal — forced back
        cogs_gone_account: { method: 'FIXED', values: [1, 1, 1, 1, 1] },  // left the catalogue
      },
    }, history, {}, cat);
    expect(a.lineDrivers.revenue_sales.method).toBe('GROWTH');
    expect(a.lineDrivers.cogs_cement).toEqual({ method: 'FIXED', values: [9, 10, 10, 10, 10] });
    expect(a.lineDrivers.ebitda.method).toBe('SUBTOTAL');
    expect(a.lineDrivers.cogs_gone_account).toBeUndefined();
  });
});

describe('projectModel (shared with the panel preview)', () => {
  it('derives EBITDA as revenue × margin — not base EBITDA grown at the revenue rate', () => {
    const a = deriveDefaults(history);
    const p = projectModel(cat.lines, baseValues, a);
    const costPct = cat.lines.filter((l) => l.kind === 'INPUT' && l.costLine)
      .reduce((t, l) => t + a.lineDrivers[l.key].values[0], 0);
    expect(p.revenue[0]).toBeCloseTo(27.3 * 1.3, 6);
    expect(p.ebitda[0]).toBeCloseTo(p.revenue[0] * (1 - costPct / 100), 6);
    expect(p.entryEbitda).toBeCloseTo(2.8, 6);
  });

  it('runs the debt schedule into interest, tax and net income', () => {
    const a = deriveDefaults(history);
    const p = projectModel(cat.lines, baseValues, a);
    expect(p.debt).toBeCloseTo(2.8 * a.debtQuantum, 6);
    // Interest on the average balance after scheduled amortisation (E3): opening − mandatory / 2.
    const mandatory = p.debt * a.amortPctPerYear / 100;
    expect(p.values.interest_expense[0]).toBeCloseTo((p.debt - mandatory / 2) * a.interestRate / 100, 6);
    const ebt = p.values.ebt[0];
    expect(p.values.tax[0]).toBeCloseTo(Math.max(0, ebt) * a.taxRate / 100, 6);
    expect(p.values.net_income[0]).toBeCloseTo(ebt - p.values.tax[0], 6);
    expect(p.irr).not.toBeNull();
    expect(p.mom!).toBeGreaterThan(0);
  });
});
