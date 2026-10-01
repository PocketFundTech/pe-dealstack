/**
 * Deal model — unit normalisation and assumption defaults (spec §6.5, §6.7).
 *
 * The unit tests here guard the trap that matters most: AGENTS.md says
 * values are stored in millions, but FinancialStatement carries a
 * `unitScale` column and a billions migration shipped. A model that
 * silently mixes THOUSANDS and MILLIONS rows is worse than no model — it
 * looks right and is wrong by 1000x.
 */
import { describe, it, expect } from 'vitest';
import {
  normaliseStatements,
  deriveDefaults,
  assumptionsSchema,
  UnitMismatchError,
} from '../src/services/dealModel/assumptions.js';

function stmt(overrides: Record<string, unknown> = {}) {
  return {
    statementType: 'INCOME_STATEMENT',
    period: '2024',
    periodType: 'HISTORICAL',
    currency: 'USD',
    unitScale: 'MILLIONS',
    isActive: true,
    lineItems: { revenue: 10, cogs: 4, ebitda: 2, net_income: 1 },
    extractionConfidence: 90,
    ...overrides,
  };
}

describe('normaliseStatements — units', () => {
  it('leaves a millions-scale statement alone', () => {
    const { rows, unitScale } = normaliseStatements([stmt()]);
    expect(unitScale).toBe('MILLIONS');
    expect(rows[0].revenue).toBe(10);
  });

  it('rescales THOUSANDS onto the same basis as MILLIONS', () => {
    // 10,000 thousands === 10 millions. If this ever fails, every model
    // built from a thousands-scale extraction is off by 1000x.
    const { rows } = normaliseStatements([
      stmt({ unitScale: 'THOUSANDS', lineItems: { revenue: 10_000, ebitda: 2_000 } }),
    ]);
    expect(rows[0].revenue).toBe(10);
    expect(rows[0].ebitda).toBe(2);
  });

  it('rescales ACTUALS onto millions', () => {
    const { rows } = normaliseStatements([
      stmt({ unitScale: 'ACTUALS', lineItems: { revenue: 10_000_000, ebitda: 2_000_000 } }),
    ]);
    expect(rows[0].revenue).toBe(10);
    expect(rows[0].ebitda).toBe(2);
  });

  it('produces identical figures from THOUSANDS and MILLIONS inputs', () => {
    const fromMillions = normaliseStatements([stmt({ lineItems: { revenue: 10, ebitda: 2 } })]);
    const fromThousands = normaliseStatements([
      stmt({ unitScale: 'THOUSANDS', lineItems: { revenue: 10_000, ebitda: 2_000 } }),
    ]);
    expect(fromThousands.rows[0]).toEqual(fromMillions.rows[0]);
  });

  it('normalises a mixed-scale set rather than mixing them', () => {
    const { rows, unitScale } = normaliseStatements([
      stmt({ period: '2023', lineItems: { revenue: 8, ebitda: 1.5 } }),
      stmt({ period: '2024', unitScale: 'THOUSANDS', lineItems: { revenue: 10_000, ebitda: 2_000 } }),
    ]);
    expect(unitScale).toBe('MILLIONS');
    expect(rows.map((r) => r.revenue)).toEqual([8, 10]);
  });
});

describe('normaliseStatements — currency and period hygiene', () => {
  it('refuses to mix currencies instead of quietly adding them up', () => {
    expect(() =>
      normaliseStatements([
        stmt({ period: '2023', currency: 'USD' }),
        stmt({ period: '2024', currency: 'EUR' }),
      ]),
    ).toThrow(UnitMismatchError);
  });

  it('keeps the currency it was given', () => {
    const { currency } = normaliseStatements([stmt({ currency: 'GBP' })]);
    expect(currency).toBe('GBP');
  });

  it('excludes PROJECTED rows from historicals', () => {
    // Feeding someone else's forecast in as history would compound our
    // projection on top of theirs.
    const { rows } = normaliseStatements([
      stmt({ period: '2024' }),
      stmt({ period: '2025E', periodType: 'PROJECTED' }),
    ]);
    expect(rows.map((r) => r.period)).toEqual(['2024']);
  });

  it('keeps LTM alongside historicals', () => {
    const { rows } = normaliseStatements([
      stmt({ period: '2024' }),
      stmt({ period: 'LTM', periodType: 'LTM' }),
    ]);
    expect(rows.map((r) => r.period)).toEqual(['2024', 'LTM']);
  });

  it('ignores balance sheets and cash flows for the P&L build', () => {
    const { rows } = normaliseStatements([
      stmt({ period: '2024' }),
      stmt({ period: '2024', statementType: 'BALANCE_SHEET' }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('orders periods chronologically', () => {
    const { rows } = normaliseStatements([
      stmt({ period: '2024' }),
      stmt({ period: '2022' }),
      stmt({ period: '2023' }),
    ]);
    expect(rows.map((r) => r.period)).toEqual(['2022', '2023', '2024']);
  });
});

describe('deriveDefaults', () => {
  const history = [
    { period: '2022', revenue: 8, ebitda: 1.2 },
    { period: '2023', revenue: 9, ebitda: 1.5 },
    { period: '2024', revenue: 10, ebitda: 2 },
  ];
  const growth = (d: ReturnType<typeof deriveDefaults>) => d.lineDrivers.revenue.values;
  /** Implied EBITDA margin = 100 − every operating cost line's % of revenue. */
  const margin = (d: ReturnType<typeof deriveDefaults>, y = 0) =>
    100 - (d.lineDrivers.total_opex?.values[y] ?? 0) - (d.lineDrivers.cogs?.values[y] ?? 0);

  it('produces assumptions that satisfy the schema', () => {
    expect(() => assumptionsSchema.parse(deriveDefaults(history))).not.toThrow();
  });

  it('seeds growth from the historical CAGR', () => {
    // 8 -> 10 over two years is ~11.8% CAGR.
    const d = deriveDefaults(history);
    expect(d.lineDrivers.revenue.method).toBe('GROWTH');
    expect(growth(d)[0]).toBeGreaterThan(10);
    expect(growth(d)[0]).toBeLessThan(13);
  });

  it('caps an implausible CAGR rather than projecting a hockey stick', () => {
    const explosive = [
      { period: '2023', revenue: 1, ebitda: 0.1 },
      { period: '2024', revenue: 20, ebitda: 4 },
    ];
    expect(growth(deriveDefaults(explosive))[0]).toBeLessThanOrEqual(30);
  });

  it('never seeds a negative growth spiral from one bad year', () => {
    const declining = [
      { period: '2023', revenue: 20, ebitda: 4 },
      { period: '2024', revenue: 10, ebitda: 1 },
    ];
    expect(growth(deriveDefaults(declining))[0]).toBeGreaterThanOrEqual(-15);
  });

  it('holds costs at their historical average % of revenue, flat across the projection', () => {
    const d = deriveDefaults(history);
    // Costs implied as revenue − EBITDA: 85%, 83.3%, 80% → average 82.8%.
    expect(d.lineDrivers.total_opex.method).toBe('PCT_REVENUE');
    expect(margin(d)).toBeCloseTo(100 - (85 + 83.333 + 80) / 3, 1);
    expect(new Set(d.lineDrivers.total_opex.values).size).toBe(1);
  });

  it('gives every input line one value per projected year, and subtotals none', () => {
    const d = deriveDefaults(history);
    for (const [key, drv] of Object.entries(d.lineDrivers)) {
      if (['ebitda', 'ebit', 'ebt', 'net_income', 'interest_expense', 'tax'].includes(key)) {
        expect(drv).toEqual({ method: 'SUBTOTAL', values: [] });
      } else {
        expect(drv.values).toHaveLength(d.projectionYears);
      }
    }
  });

  it('defaults the exit multiple to the entry multiple — no free arbitrage', () => {
    // Assuming multiple expansion by default would flatter every return.
    const d = deriveDefaults(history);
    expect(d.exitMultiple).toBe(d.entryMultiple);
  });

  it('exits within the projection window', () => {
    const d = deriveDefaults(history);
    expect(d.exitYear).toBeLessThanOrEqual(d.projectionYears);
    expect(d.exitYear).toBeGreaterThan(0);
  });

  it('copes with a single year of history', () => {
    const d = deriveDefaults([{ period: '2024', revenue: 10, ebitda: 2 }]);
    expect(() => assumptionsSchema.parse(d)).not.toThrow();
    expect(growth(d)).toHaveLength(d.projectionYears);
  });

  it('copes with no usable history at all — holds a default 15% margin', () => {
    const d = deriveDefaults([]);
    expect(() => assumptionsSchema.parse(d)).not.toThrow();
    expect(margin(d)).toBe(15);
  });

  it('seeds the entry multiple from the deal when one is known', () => {
    const d = deriveDefaults(history, { evMultiple: 6.5 });
    expect(d.entryMultiple).toBe(6.5);
  });
});
