import { describe, it, expect } from 'vitest';
import { mergeStatementsBySameType } from '../src/services/financialPeriodNormalizer.js';
import { validateStatements } from '../src/services/financialValidator.js';
import { implausibleReturnsNote } from '../src/services/dealModel/scenarios.js';
import type { ClassifiedStatement, FinancialPeriod } from '../src/services/financialClassifier.js';

function annual(period: string, lineItems: Record<string, number | null>): FinancialPeriod {
  return { period, periodType: 'HISTORICAL', lineItems, confidence: 95 };
}

function incomeStatement(unitScale: ClassifiedStatement['unitScale'], periods: FinancialPeriod[]): ClassifiedStatement {
  return { statementType: 'INCOME_STATEMENT', unitScale, currency: 'USD', periods };
}

describe('mergeStatementsBySameType — mixed unit scales', () => {
  // Luktara regression: one sheet chunk came back in MILLIONS, the next in
  // THOUSANDS. First-wins kept MILLIONS for both, so 362,500 ($000s) was
  // stored as $362.5B.
  it('converts a THOUSANDS sibling into the MILLIONS scale it is merged under', () => {
    const merged = mergeStatementsBySameType([
      incomeStatement('MILLIONS', [annual('2013', { revenue: 331.0 })]),
      incomeStatement('THOUSANDS', [annual('2014', { revenue: 362_500 })]),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].unitScale).toBe('MILLIONS');
    const byPeriod = Object.fromEntries(merged[0].periods.map(p => [p.period, p.lineItems.revenue]));
    expect(byPeriod['2013']).toBe(331.0);
    expect(byPeriod['2014']).toBeCloseTo(362.5, 6);
  });

  it('leaves _pct ratios unscaled', () => {
    const merged = mergeStatementsBySameType([
      incomeStatement('MILLIONS', [annual('2013', { revenue: 331.0 })]),
      incomeStatement('THOUSANDS', [annual('2014', { revenue: 362_500, ebitda_margin_pct: 12.4 })]),
    ]);
    const y2014 = merged[0].periods.find(p => p.period === '2014')!;
    expect(y2014.lineItems.ebitda_margin_pct).toBe(12.4);
  });
});

describe('validateStatements — unit scale breaks between adjacent years', () => {
  const scaleBreaks = (stmt: ClassifiedStatement) =>
    validateStatements([stmt]).checks.filter(c => c.check === 'unit_scale_break');

  it('raises an error when revenue jumps ~1,000x between adjacent years', () => {
    const breaks = scaleBreaks(incomeStatement('MILLIONS', [
      annual('2013', { revenue: 331.0 }),
      annual('2014', { revenue: 362_511 }),
      annual('2015', { revenue: 399_500 }),
    ]));
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ passed: false, severity: 'error', period: '2014' });
    expect(breaks[0].message).toMatch(/2013.*2014/);
    expect(breaks[0].message).toMatch(/unit/i);
  });

  it('raises an error when revenue drops ~1,000x between adjacent years', () => {
    const breaks = scaleBreaks(incomeStatement('THOUSANDS', [
      annual('2020', { revenue: 540_000 }),
      annual('2021', { revenue: 583.0 }),
    ]));
    expect(breaks).toHaveLength(1);
    expect(breaks[0].period).toBe('2021');
  });

  it('does not flag strong but real growth', () => {
    expect(scaleBreaks(incomeStatement('MILLIONS', [
      annual('2020', { revenue: 10 }),
      annual('2021', { revenue: 45 }),
    ]))).toHaveLength(0);
  });

  it('does not flag a jump that is large but not near a power of 1,000', () => {
    expect(scaleBreaks(incomeStatement('ACTUALS', [
      annual('2020', { revenue: 10_000 }),
      annual('2021', { revenue: 4_000_000 }),
    ]))).toHaveLength(0);
  });
});

describe('implausibleReturnsNote — model sanity guard', () => {
  const summary = (irr: number | null, mom: number | null) => ({
    exitRevenue: 0, exitEbitda: 0, exitEv: 0, entryEv: 38, equity: 19, irr, mom,
  });

  it('warns on Luktara-style returns (942% IRR, 122,597x MoM)', () => {
    const note = implausibleReturnsNote(summary(9.416, 122_597.6));
    expect(note).not.toBeNull();
    expect(note).toMatch(/942%/);
    expect(note).toMatch(/122,598x|122,597\.6x/);
    expect(note).toMatch(/unit/i);
  });

  it('warns when only the multiple is implausible', () => {
    expect(implausibleReturnsNote(summary(0.6, 25))).not.toBeNull();
  });

  it('stays silent for normal PE returns (25% IRR, 2.8x)', () => {
    expect(implausibleReturnsNote(summary(0.25, 2.8))).toBeNull();
  });

  it('stays silent when returns cannot be computed', () => {
    expect(implausibleReturnsNote(summary(null, null))).toBeNull();
  });
});
