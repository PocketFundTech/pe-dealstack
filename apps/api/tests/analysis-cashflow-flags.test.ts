/**
 * Fix plan F1 (part 1): negative free cash flow and debt-funded capex
 * surface as red flags and QoE flags — the SRM analyst found both by hand.
 */
import { describe, it, expect } from 'vitest';
import { analyzeFinancials } from '../src/services/analysis/index.js';
import { freeCashFlowOf, newBorrowingOf } from '../src/services/analysis/cashFlowFlags.js';

const row = (statementType: string, period: string, lineItems: Record<string, number>) =>
  ({ statementType, periodType: 'HISTORICAL', period, lineItems });

// SRM-like: capex outruns operating cash in both years, loans fund it.
const SRM = [
  row('INCOME_STATEMENT', 'FY2023 (Jan - Dec 2023)', { revenue: 21.0, ebitda: 2.5 }),
  row('INCOME_STATEMENT', 'FY2024 (Jan - Dec 2024)', { revenue: 27.3, ebitda: 2.2 }),
  row('CASH_FLOW', '2023', { operating_cf: 1.8, capex: -3.1, proceeds_from_term_loans: 2.4 }),
  row('CASH_FLOW', '2024', { operating_cf: 2.0, capex: -2.6, debt_repayment: -1.3, proceeds_from_debt: 1.0 }),
];

describe('cash-flow red flags', () => {
  it('flags negative FCF in both years as critical, with the numbers', async () => {
    const r = await analyzeFinancials('srm', SRM);
    const f = r.redFlags!.find((x) => x.id === 'negative_free_cash_flow')!;
    expect(f.severity).toBe('critical');
    expect(f.title).toBe('Negative Free Cash Flow in 2 Years');
    expect(f.evidence).toBe('2023: FCF −$1.3M · 2024: FCF −$0.6M');
  });

  it('flags capex funded with debt where borrowing covers at least half the cash shortfall', async () => {
    const r = await analyzeFinancials('srm', SRM);
    const f = r.redFlags!.find((x) => x.id === 'debt_funded_capex')!;
    // 2023: shortfall 1.3, borrowed 2.4 → flagged. 2024: shortfall 0.6, borrowed 1.0 → flagged.
    expect(f.title).toBe('Capex Funded with Debt (2023, 2024)');
    expect(f.evidence).toContain('new borrowing $2.4M (debt proceeds on the cash flow)');
  });

  it('feeds the Quality of Earnings flags (and so the score)', async () => {
    const r = await analyzeFinancials('srm', SRM);
    const ids = r.qoe.flags.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['negative_free_cash_flow', 'debt_funded_capex']));
  });

  it('does not call it debt-funded when borrowing covers little of the shortfall', async () => {
    const r = await analyzeFinancials('small-loan', [
      row('INCOME_STATEMENT', '2024', { revenue: 10 }),
      row('CASH_FLOW', '2024', { operating_cf: 1, capex: -5, proceeds_from_debt: 0.5 }),
    ]);
    expect(r.redFlags!.map((f) => f.id)).not.toContain('debt_funded_capex');
  });

  it('stays quiet for a cash-generative business', async () => {
    const r = await analyzeFinancials('ok', [
      row('INCOME_STATEMENT', '2023', { revenue: 10 }), row('INCOME_STATEMENT', '2024', { revenue: 11 }),
      row('CASH_FLOW', '2023', { operating_cf: 3, capex: -1 }), row('CASH_FLOW', '2024', { operating_cf: 3.2, capex: -1.1 }),
    ]);
    expect(r.redFlags!.map((f) => f.id)).not.toContain('negative_free_cash_flow');
    expect(r.redFlags!.map((f) => f.id)).not.toContain('debt_funded_capex');
  });

  it('ignores a partial YTD period', async () => {
    const r = await analyzeFinancials('ytd', [
      row('INCOME_STATEMENT', '2024', { revenue: 10 }),
      row('CASH_FLOW', '2024', { operating_cf: 3, capex: -1 }),
      row('CASH_FLOW', '2025 YTD (Jan - Sep 2025)', { operating_cf: 0.5, capex: -2 }),
    ]);
    expect(r.redFlags!.map((f) => f.id)).not.toContain('negative_free_cash_flow');
  });
});

describe('SRM cash flow as stored (split capex, new_debt_proceeds)', () => {
  it('flags both years negative and debt-funded', async () => {
    const r = await analyzeFinancials('srm-real', [
      row('INCOME_STATEMENT', '2024', { revenue: 27.3 }), row('INCOME_STATEMENT', '2025', { revenue: 38 }),
      row('CASH_FLOW', '2024', { operating_cf: 2.2798, growth_capex: 0.232, maintenance_capex: 1.2098, replacement_capex_capitalized: 2.4883, new_debt_proceeds: 1.8977, debt_repayment: -0.692 }),
      row('CASH_FLOW', '2025', { operating_cf: 3.2581, growth_capex: 4.0638, maintenance_capex: 0.4972, replacement_capex_capitalized: 0.4879, new_debt_proceeds: 3.1783, debt_repayment: -0.9298 }),
    ]);
    const ids = r.redFlags!.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['negative_free_cash_flow', 'debt_funded_capex']));
    expect(r.redFlags!.find((f) => f.id === 'debt_funded_capex')!.title).toBe('Capex Funded with Debt (2024, 2025)');
  });
});

describe('helpers', () => {
  it('FCF: reported fcf wins, else OCF − |capex| (sign-safe for old positive capex rows)', () => {
    expect(freeCashFlowOf({ fcf: 1, operating_cf: 5, capex: -2 })).toBe(1);
    expect(freeCashFlowOf({ operating_cf: 5, capex: 2 })).toBe(3);
    expect(freeCashFlowOf({ operating_cf: 5 })).toBeNull();
  });

  it('borrowing: cash-flow proceeds first, else the balance-sheet debt increase', () => {
    expect(newBorrowingOf({ borrowings: 2 }, undefined, undefined)).toEqual({ amount: 2, basis: 'debt proceeds on the cash flow' });
    expect(newBorrowingOf({}, { long_term_debt: 5 }, { long_term_debt: 3 })).toEqual({ amount: 2, basis: 'increase in balance-sheet debt' });
    expect(newBorrowingOf({ proceeds_from_sale_of_equipment: 4 }, undefined, undefined)).toBeNull();
    expect(newBorrowingOf({ new_debt_proceeds: 1.9 }, undefined, undefined)?.amount).toBe(1.9);
    expect(newBorrowingOf({ debt_repayment_proceeds_adj: 1 }, undefined, undefined)).toBeNull();
  });
});
