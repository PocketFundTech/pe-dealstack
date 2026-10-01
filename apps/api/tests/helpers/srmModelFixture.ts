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

export const SRM_CONTEXT = {
  dealName: 'SRM', companyName: 'Strong Ready Mix', currency: 'USD', unitScale: 'MILLIONS' as const,
  sourceDocuments: ['SRM P&L.xlsx'], generatedAt: '2026-10-01T00:00:00Z', notes: [],
};
