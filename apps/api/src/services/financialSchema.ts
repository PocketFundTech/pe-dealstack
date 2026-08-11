/**
 * financialSchema.ts — Zod schemas for financial extraction validation.
 * Validates and normalizes GPT-4o output keys to prevent invented field names.
 */

import { z } from 'zod';

/** Nullable number — most line items are optional */
const num = z.number().nullable().optional();
/** Source citation string — optional */
const src = z.string().nullable().optional();

/** Income Statement line items */
export const incomeStatementSchema = z.object({
  revenue: num, revenue_source: src,
  cogs: num, cogs_source: src,
  gross_profit: num, gross_profit_source: src,
  gross_margin_pct: num, gross_margin_pct_source: src,
  sga: num, sga_source: src,
  rd: num, rd_source: src,
  other_opex: num, other_opex_source: src,
  total_opex: num, total_opex_source: src,
  ebitda: num, ebitda_source: src,
  ebitda_margin_pct: num, ebitda_margin_pct_source: src,
  da: num, da_source: src,
  ebit: num, ebit_source: src,
  interest_expense: num, interest_expense_source: src,
  ebt: num, ebt_source: src,
  tax: num, tax_source: src,
  net_income: num, net_income_source: src,
  sde: num, sde_source: src,
  depreciation: num, depreciation_source: src,
  tax_expense: num, tax_expense_source: src,
}).passthrough(); // Allow unknown keys but validate known ones

/** Balance Sheet line items */
export const balanceSheetSchema = z.object({
  cash: num, cash_source: src,
  accounts_receivable: num, accounts_receivable_source: src,
  inventory: num, inventory_source: src,
  other_current_assets: num, other_current_assets_source: src,
  total_current_assets: num, total_current_assets_source: src,
  ppe_net: num, ppe_net_source: src,
  goodwill: num, goodwill_source: src,
  intangibles: num, intangibles_source: src,
  total_assets: num, total_assets_source: src,
  accounts_payable: num, accounts_payable_source: src,
  short_term_debt: num, short_term_debt_source: src,
  other_current_liabilities: num, other_current_liabilities_source: src,
  total_current_liabilities: num, total_current_liabilities_source: src,
  long_term_debt: num, long_term_debt_source: src,
  total_liabilities: num, total_liabilities_source: src,
  total_equity: num, total_equity_source: src,
}).passthrough();

/** Cash Flow line items */
export const cashFlowSchema = z.object({
  operating_cf: num, operating_cf_source: src,
  operating_cash_flow: num, operating_cash_flow_source: src,
  capex: num, capex_source: src,
  fcf: num, fcf_source: src,
  free_cash_flow: num, free_cash_flow_source: src,
  acquisitions: num, acquisitions_source: src,
  debt_repayment: num, debt_repayment_source: src,
  dividends: num, dividends_source: src,
  net_change_cash: num, net_change_cash_source: src,
  investing_activities: num, investing_activities_source: src,
  financing_activities: num, financing_activities_source: src,
}).passthrough();

/** Map of statement type to its schema */
const schemaMap: Record<string, z.ZodObject<any>> = {
  INCOME_STATEMENT: incomeStatementSchema,
  BALANCE_SHEET: balanceSheetSchema,
  CASH_FLOW: cashFlowSchema,
};

/**
 * Common line-item name aliases → canonical name. Exported so other
 * extraction engines (e.g. the Claude structured-output engine in
 * services/extraction/) can dedupe against the same canonical set without
 * maintaining a second copy that could drift out of sync.
 */
export const LINE_ITEM_ALIASES: Record<string, string> = {
  total_revenue: 'revenue',
  net_revenue: 'revenue',
  net_sales: 'revenue',
  sales: 'revenue',
  operating_income: 'ebit',
  operating_profit: 'ebit',
  cost_of_revenue: 'cogs',
  cost_of_sales: 'cogs',
  cost_of_goods: 'cogs',
  selling_general_admin: 'sga',
  research_development: 'rd',
  depreciation_amortization: 'da',
  total_debt: 'long_term_debt',
  shareholders_equity: 'total_equity',
  stockholders_equity: 'total_equity',
};

/**
 * Validate and normalize line items for a given statement type.
 * Uses .passthrough() so unknown keys are kept (GPT-4o may return extras)
 * but known keys are type-checked.
 *
 * Also normalizes common aliases (see LINE_ITEM_ALIASES):
 * - "total_revenue" → "revenue"
 * - "net_revenue" → "revenue"
 * - "operating_income" → "ebit"
 * - "operating_profit" → "ebit"
 */
export function validateLineItems(
  statementType: string,
  lineItems: Record<string, any>,
): { valid: boolean; normalized: Record<string, any>; warnings: string[] } {
  const warnings: string[] = [];

  // Normalize common aliases before validation
  const aliases = LINE_ITEM_ALIASES;

  const normalized = { ...lineItems };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in normalized && !(canonical in normalized)) {
      normalized[canonical] = normalized[alias];
      // Also move _source if present
      if (`${alias}_source` in normalized) {
        normalized[`${canonical}_source`] = normalized[`${alias}_source`];
        delete normalized[`${alias}_source`];
      }
      delete normalized[alias];
      warnings.push(`Renamed "${alias}" to "${canonical}"`);
    }
  }

  const schema = schemaMap[statementType];
  if (!schema) {
    return { valid: true, normalized, warnings };
  }

  const result = schema.safeParse(normalized);
  if (!result.success) {
    // Log validation issues but don't reject — GPT-4o output is messy
    for (const issue of result.error.issues) {
      warnings.push(`lineItems validation: ${issue.path.join('.')} — ${issue.message}`);
    }
    return { valid: false, normalized, warnings };
  }

  return { valid: true, normalized: result.data, warnings };
}
