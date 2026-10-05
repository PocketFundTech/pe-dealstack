/**
 * Fix plan G10: statements in different currencies were added together.
 * Growth, CAGR and every ratio blended e.g. USD and INR figures as if they
 * were one series, with no sign anything was off. The analysis now uses
 * one currency and says which statements it left out.
 */
import { describe, it, expect } from 'vitest';
import { analyzeFinancials } from '../src/services/analysis/index.js';
import { pickAnalysisCurrency } from '../src/services/analysis/helpers.js';

const row = (statementType: string, period: string, currency: string, lineItems: Record<string, number>) =>
  ({ statementType, periodType: 'HISTORICAL', period, currency, lineItems });

const MIXED = [
  row('INCOME_STATEMENT', '2023', 'USD', { revenue: 20, ebitda: 2 }),
  row('INCOME_STATEMENT', '2024', 'USD', { revenue: 22, ebitda: 2.4 }),
  // A subsidiary's P&L in INR for an overlapping year.
  row('INCOME_STATEMENT', '2024', 'INR', { revenue: 1800, ebitda: 150 }),
];

describe('mixed-currency financials', () => {
  it('analyses the main currency only and names what it left out', async () => {
    const r = await analyzeFinancials('mixed', MIXED);
    expect(r.currency).toBe('USD');
    expect(r.currencyNote).toContain('USD and INR');
    expect(r.currencyNote).toContain('not converted');
    // 2024 revenue stays USD 22 — not 22 merged with INR 1,800.
    const growth = r.revenueQuality!.organicGrowthRates.find((g) => g.rate !== null)!;
    expect(growth.rate).toBeCloseTo(10, 5);
  });

  it('says nothing when everything is in one currency', async () => {
    const r = await analyzeFinancials('usd', MIXED.slice(0, 2));
    expect(r.currencyNote).toBeUndefined();
  });

  it('picks the currency with the most income-statement periods, USD on a tie', () => {
    expect(pickAnalysisCurrency(MIXED).currency).toBe('USD');
    expect(pickAnalysisCurrency([MIXED[1], MIXED[2]]).currency).toBe('USD');
    expect(pickAnalysisCurrency([
      row('INCOME_STATEMENT', '2023', 'EUR', { revenue: 1 }), row('INCOME_STATEMENT', '2024', 'EUR', { revenue: 1 }), MIXED[0],
    ]).currency).toBe('EUR');
  });
});
