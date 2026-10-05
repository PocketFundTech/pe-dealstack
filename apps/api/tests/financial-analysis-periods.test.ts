import { describe, it, expect } from 'vitest';
import { analyzeFinancials } from '../src/services/analysis/index.js';
import { prepareData } from '../src/services/analysis/helpers.js';

// Shape of the Strong Ready Mix test deal (USD millions): a revenue-only 2021
// from a CIM chart, QuickBooks FY2023/FY2024 with date-range labels, a 9-month
// 2025 YTD, and a bare "2024" from a derived valuation summary.
const is = (period: string, lineItems: Record<string, number>) =>
  ({ statementType: 'INCOME_STATEMENT', periodType: 'HISTORICAL', period, lineItems });

const SRM_ROWS = [
  is('2021', { revenue: 12.0 }),
  is('2024', { revenue: 27.3, ebitda: 3.0 }),
  is('2025 YTD (Jan - Sep 2025)', { revenue: 29.0, ebit: 3.2, da: 0.8, net_income: 1.9 }),
  is('FY2023 (Jan - Dec 2023)', { revenue: 21.0, ebit: 1.6, da: 0.6, net_income: 0.4 }),
  is('FY2024 (Jan - Dec 2024)', { revenue: 27.3, ebit: 2.1, da: 0.7, net_income: -0.12 }),
];

describe('analysis period handling (SRM regression)', () => {
  it('orders periods chronologically and merges "2024" with "FY2024 (…)"', () => {
    const data = prepareData(SRM_ROWS);
    expect(data.periods).toEqual(['2021', '2023', '2024', 'YTD Sep 2025']);
    expect(data.annualPeriods).toEqual(['2021', '2023', '2024']);
    // The richer QuickBooks row is the base; the valuation file only fills gaps.
    expect(data.income.get('2024')).toMatchObject({ revenue: 27.3, ebit: 2.1, ebitda: 3.0 });
  });

  it('computes growth on full years and shows the YTD separately', async () => {
    const result = await analyzeFinancials('deal-srm', SRM_ROWS);
    const rq = result.revenueQuality!;

    const growth = Object.fromEntries(rq.organicGrowthRates.map(g => [g.period, g.rate]));
    expect(growth['2024']).toBeCloseTo(30, 0);           // FY2023 → FY2024
    expect(growth['2023']).toBeCloseTo(32.29, 1);        // 2021 → 2023, annualised over the gap
    expect(rq.organicGrowthRates.some(g => g.rate != null && g.rate < 0)).toBe(false); // no false −27.7%

    // CAGR over 3 real years (2021 → 2024), not "3 columns"
    expect(rq.revenueCAGR).toBeCloseTo(31.5, 0);

    expect(rq.ytd).toMatchObject({ period: 'YTD Sep 2025', months: 9, basis: 'annualised_estimate', comparedTo: '2024' });
    expect(rq.ytd!.annualisedRevenue).toBeCloseTo(38.67, 1);
    expect(rq.ytd!.growthPct).toBeCloseTo(41.6, 0);

    const flagIds = result.qoe.flags.map(f => f.id);
    expect(flagIds).not.toContain('revenue_volatility');
    expect(flagIds).not.toContain('revenue_decline');
  });

  it('falls back to EBIT + D&A for EBITDA margin when EBITDA is not printed', async () => {
    const result = await analyzeFinancials('deal-srm', SRM_ROWS);
    const margin = result.ratios.flatMap(g => g.ratios).find(r => r.key === 'ebitda_margin')!;
    const byPeriod = Object.fromEntries(margin.periods.map(p => [p.period, p.value]));
    expect(byPeriod['2023']).toBeCloseTo((2.2 / 21.0) * 100, 1);
    expect(byPeriod['YTD Sep 2025']).toBeCloseTo((4.0 / 29.0) * 100, 1);
  });
});

describe('balance-sheet-only years (real SRM shape)', () => {
  // The valuation summary contributes BS/CF rows labelled "2024" / "2025" but
  // no income statement. "2025" must not appear as an empty revenue year.
  const rows = [
    is('2021', { revenue: 12.4954 }),
    is('FY2023 (Jan - Dec 2023)', { revenue: 20.9597 }),
    is('FY2024 (Jan - Dec 2024)', { revenue: 27.3214 }),
    is('2025 YTD (Jan - Sep 2025)', { revenue: 28.9823 }),
    { statementType: 'BALANCE_SHEET', periodType: 'HISTORICAL', period: '2025', lineItems: { cash: 1 } },
    { statementType: 'CASH_FLOW', periodType: 'HISTORICAL', period: '2025', lineItems: { capex: -1 } },
  ];

  it('keeps the revenue series to income-statement years and still reports the YTD', async () => {
    const rq = (await analyzeFinancials('deal-srm', rows)).revenueQuality!;
    expect(rq.organicGrowthRates.map(g => g.period)).toEqual(['2023', '2024']);
    expect(rq.revenueCAGR).toBeCloseTo(29.79, 1);
    expect(rq.ytd).toMatchObject({ period: 'YTD Sep 2025', comparedTo: '2024', basis: 'annualised_estimate' });
    expect(rq.ytd!.growthPct).toBeCloseTo(41.44, 1);
  });
});
