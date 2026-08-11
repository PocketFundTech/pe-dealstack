/**
 * Golden case: InstateMe (EdTech, in-state tuition residency).
 * ===========================================================
 *
 * Source: InstateMe_Financials.xlsx (P&L, 2023-2025 annual actuals) +
 * InstateMe_CIM.docx (2026 cohort revenue projection). Ground truth taken
 * from the P&L (Indian-grouped figures de-grouped, e.g. $3,90,558 = 390558).
 *
 * This case pins the CORRECT extraction and the defects observed in the live
 * 2026-07-03 run (captured in `INSTATEME_BUGGY_OUTPUT`), which the scorer must
 * flag: 4 cohort-labels-as-periods, FY/bare-year duplicates, and a spurious
 * "2026" HISTORICAL that double-counts the "2026E" projection.
 */
import type { GoldenCase, ScoredPeriod } from '../types.js';

export const INSTATEME_GOLDEN: GoldenCase = {
  id: 'instateme-income-statement',
  description:
    'InstateMe P&L (2023-2025 actuals) + CIM 2026 cohort projection. Cohorts are revenue channels, not periods; 2026 is a single PROJECTED period.',
  todayIso: '2026-07-03',
  statementType: 'INCOME_STATEMENT',
  valueTolerance: 0.02,
  // Enrollment/cohort labels must never appear as their own fiscal period.
  forbiddenPeriodPatterns: [/^(fall|spring|summer|winter)\s+\d{4}$/i],
  expected: [
    {
      period: '2023',
      periodType: 'HISTORICAL',
      lineItems: {
        revenue: 64819,
        revenue_affiliate_fee: 1550,
        revenue_onboarding_fee: 10200,
        revenue_savings_fee: 53069,
        net_income: 17446,
      },
    },
    {
      period: '2024',
      periodType: 'HISTORICAL',
      lineItems: {
        revenue: 390558,
        revenue_affiliate_fee: 950,
        revenue_onboarding_fee: 56980,
        revenue_savings_fee: 332628,
        net_income: 319641,
      },
    },
    {
      period: '2025',
      periodType: 'HISTORICAL',
      lineItems: {
        revenue: 388642,
        revenue_affiliate_fee: 1350,
        revenue_onboarding_fee: 59000,
        revenue_savings_fee: 328292,
        net_income: 287248,
      },
    },
    {
      // 2026 full year ends after today (2026-07-03) → PROJECTED, and it is a
      // SINGLE period. The cohort figures are revenue channels within it.
      period: '2026E',
      periodType: 'PROJECTED',
      lineItems: {
        revenue: 476600,
        revenue_onboarding_pipeline: 68000,
      },
    },
  ],
};

/**
 * The ACTUAL output from the 2026-07-03 run (WhatsApp Extraction July 3 2026),
 * flattened to INCOME_STATEMENT periods. Used by the scorer test to prove the
 * harness catches the real defects. 14 statements for 4 real periods.
 */
export const INSTATEME_BUGGY_OUTPUT: ScoredPeriod[] = [
  { period: '2023', periodType: 'HISTORICAL', lineItems: { revenue: 64819, revenue_affiliate_fee: 1550, revenue_onboarding_fee: 10200, revenue_savings_fee: 53069, net_income: 17446 } },
  { period: '2024', periodType: 'HISTORICAL', lineItems: { revenue: 390558, revenue_affiliate_fee: 950, revenue_onboarding_fee: 56980, revenue_savings_fee: 332628, net_income: 319641 } },
  { period: '2024', periodType: 'HISTORICAL', lineItems: { revenue: 390558, revenue_affiliate_fee: 950, revenue_onboarding_fee: 56980, revenue_savings_fee: 332628 } },
  { period: '2025', periodType: 'HISTORICAL', lineItems: { revenue: 388642, revenue_affiliate_fee: 1350, revenue_onboarding_fee: 59000, revenue_savings_fee: 328292 } },
  { period: '2025', periodType: 'HISTORICAL', lineItems: { revenue: 388642, revenue_affiliate_fee: 1350, revenue_onboarding_fee: 59000, revenue_savings_fee: 328292, net_income: 287248 } },
  { period: '2026', periodType: 'HISTORICAL', lineItems: { revenue: 476600, revenue_onboarding_pipeline: 68000 } },
  { period: '2026E', periodType: 'PROJECTED', lineItems: { revenue: 476600, revenue_onboarding_pipeline: 68000 } },
  { period: 'Fall 2026', periodType: 'HISTORICAL', lineItems: { revenue: 429000 } },
  { period: 'Fall 2027', periodType: 'HISTORICAL', lineItems: { revenue: 49500 } },
  { period: 'FY2023', periodType: 'HISTORICAL', lineItems: { revenue: 64769 } },
  { period: 'FY2024', periodType: 'HISTORICAL', lineItems: { revenue: 390558 } },
  { period: 'FY2025', periodType: 'HISTORICAL', lineItems: { revenue: 389000 } },
  { period: 'Spring 2026', periodType: 'HISTORICAL', lineItems: { revenue: 99000 } },
  { period: 'Spring 2027', periodType: 'HISTORICAL', lineItems: { revenue: 99000 } },
];
