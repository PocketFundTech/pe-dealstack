/**
 * Strong Ready Mix-shaped P&L for the deal-model tests (no real file — the
 * shape, not the client's figures): FY2023 / FY2024 full years plus a
 * 9-month 2025 YTD, revenue 21.0 / 27.3 / 29.0, QuickBooks-style accounts
 * filed under their parents by #164 (cogs_cement, cogs_fly_ash, …), and no
 * printed EBITDA line (derived as EBIT + D&A).
 */
export const srmStatement = (period: string, lineItems: Record<string, number>) => ({
  statementType: 'INCOME_STATEMENT',
  period,
  periodType: 'HISTORICAL',
  unitScale: 'MILLIONS',
  currency: 'USD',
  isActive: true,
  lineItems,
});

export const SRM_STATEMENTS = [
  srmStatement('FY2023 (Jan - Dec 2023)', {
    revenue: 21.0, revenue_sales: 21.3, revenue_discounts: -0.3,
    cogs: 15.4, cogs_cement: 6.3, cogs_labour: 4.0, cogs_sand_cos: 2.8, cogs_fly_ash: 1.5,
    gross_profit: 5.6,
    total_opex: 3.4, total_opex_rent: 0.9, total_opex_insurance: 0.6,
    da: 0.6, ebit: 1.6, interest_expense: 0.4, other_income: 0.1, ebt: 1.3, tax: 0.3, net_income: 1.0,
  }),
  srmStatement('FY2024 (Jan - Dec 2024)', {
    revenue: 27.3, revenue_sales: 27.7, revenue_discounts: -0.4,
    cogs: 20.0, cogs_cement: 8.2, cogs_labour: 5.2, cogs_sand_cos: 3.6, cogs_fly_ash: 2.0,
    gross_profit: 7.3,
    total_opex: 4.5, total_opex_rent: 1.1, total_opex_insurance: 0.8,
    da: 0.7, ebit: 2.1, interest_expense: 0.5, other_income: 0.2, ebt: 1.8, tax: 0.45, net_income: 1.35,
  }),
  srmStatement('2025 YTD (Jan - Sep 2025)', {
    revenue: 29.0, revenue_sales: 29.4, revenue_discounts: -0.4,
    cogs: 21.0, cogs_cement: 8.9, cogs_labour: 5.6, cogs_sand_cos: 3.9, cogs_fly_ash: 2.2,
    gross_profit: 8.0,
    total_opex: 5.0, total_opex_rent: 0.9, total_opex_insurance: 0.7,
    da: 0.6, ebit: 2.4, net_income: 1.9,
  }),
];

/**
 * Balance sheets and cash flows for the same shape (fix plan E3): labelled
 * the way other documents label them ("FY2023", "2024", "YTD Sep 2025") so
 * they must match the P&L by canonical period. FY2023 capex is only the
 * split lines (no total); FY2024 prints a total, the split and total_debt
 * (#163); outflows are negative. The YTD figures are deliberately different
 * so tests can prove they are never used as a year.
 */
const srmSide = (statementType: string, period: string, lineItems: Record<string, number>) => ({
  ...srmStatement(period, lineItems), statementType,
});

export const SRM_BALANCE_STATEMENTS = [
  srmSide('BALANCE_SHEET', 'FY2023', {
    cash: 0.6, accounts_receivable: 2.9, inventory: 0.8, ppe_net: 6.0, total_assets: 10.3,
    accounts_payable: 1.7, short_term_debt: 0.5, long_term_debt: 3.5, total_equity: 4.6,
  }),
  srmSide('BALANCE_SHEET', '2024', {
    cash: 0.9, accounts_receivable: 3.6, inventory: 1.1, ppe_net: 7.0, total_assets: 12.6,
    accounts_payable: 2.2, short_term_debt: 0.6, long_term_debt: 4.0, total_debt: 4.6, total_equity: 5.8,
  }),
  srmSide('BALANCE_SHEET', 'YTD Sep 2025', {
    cash: 0.4, accounts_receivable: 4.4, inventory: 1.2, ppe_net: 7.8, accounts_payable: 2.5,
    short_term_debt: 0.7, long_term_debt: 4.5,
  }),
  srmSide('CASH_FLOW', 'FY2023', {
    operating_cf: 1.4, maintenance_capex: -0.5, replacement_capex_capitalized: -0.2, growth_capex: -0.6,
  }),
  srmSide('CASH_FLOW', '2024', {
    operating_cf: 1.5, capex: -1.6, maintenance_capex: -0.6, replacement_capex_capitalized: -0.3, growth_capex: -0.7,
  }),
  srmSide('CASH_FLOW', 'YTD Sep 2025', { operating_cf: 0.9, capex: -2.0, growth_capex: -1.2, maintenance_capex: -0.8 }),
];

export const SRM_FULL_STATEMENTS = [...SRM_STATEMENTS, ...SRM_BALANCE_STATEMENTS];

export const SRM_CONTEXT = {
  dealName: 'SRM', companyName: 'Strong Ready Mix', currency: 'USD', unitScale: 'MILLIONS' as const,
  sourceDocuments: ['SRM P&L.xlsx'], generatedAt: '2026-10-01T00:00:00Z', notes: [],
};
