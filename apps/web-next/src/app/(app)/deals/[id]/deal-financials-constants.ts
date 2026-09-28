// Constants and shared types for the deal-financials panel.
// Ported from legacy financials-helpers.js — see deal-financials.tsx for usage.

// Shared useApiQuery cache key for GET /deals/:id/financials. Both
// FinancialMetricsRow and FinancialStatusBadge (deal-layout.tsx) read
// through this key so they share a single request instead of firing two
// independent fetches on every deal-page load. deal-financials.tsx
// invalidates it whenever financials change (extract / remove-by-document /
// auto-resolve) so those two header widgets stay in sync. A leaf module
// (no React, no other local imports) so both sides can import it without a
// cycle.
export function financialsKey(dealId: string): string {
  return `/deals/${dealId}/financials`;
}

export const LINE_ITEM_LABELS: Record<string, string> = {
  revenue: "Revenue", cogs: "Cost of Goods Sold", gross_profit: "Gross Profit",
  gross_margin_pct: "Gross Margin %", sga: "SG&A", rd: "R&D",
  other_opex: "Other OpEx", total_opex: "Total OpEx", ebitda: "EBITDA",
  ebitda_margin_pct: "EBITDA Margin %", da: "D&A", ebit: "EBIT",
  interest_expense: "Interest Expense", ebt: "EBT", tax: "Tax",
  net_income: "Net Income", sde: "SDE", depreciation: "D&A", tax_expense: "Tax Expense",
  cash: "Cash & Equivalents", accounts_receivable: "Accounts Receivable",
  inventory: "Inventory", other_current_assets: "Other Current Assets",
  total_current_assets: "Total Current Assets", ppe_net: "PP&E (Net)",
  goodwill: "Goodwill", intangibles: "Intangibles", total_assets: "Total Assets",
  accounts_payable: "Accounts Payable", short_term_debt: "Short-term Debt",
  other_current_liabilities: "Other Current Liabilities",
  total_current_liabilities: "Total Current Liabilities",
  long_term_debt: "Long-term Debt", total_liabilities: "Total Liabilities",
  total_equity: "Total Equity", total_debt: "Total Debt",
  operating_cf: "Operating Cash Flow", operating_cash_flow: "Operating Cash Flow",
  capex: "CapEx", fcf: "Free Cash Flow", free_cash_flow: "Free Cash Flow",
  acquisitions: "Acquisitions", debt_repayment: "Debt Repayment",
  dividends: "Dividends", net_change_cash: "Net Change in Cash",
  investing_activities: "Investing Activities", financing_activities: "Financing Activities",
};

export const SUBTOTAL_KEYS = new Set([
  "revenue", "gross_profit", "ebitda", "ebit", "net_income", "sde",
  "total_current_assets", "total_assets", "total_current_liabilities",
  "total_liabilities", "total_equity", "fcf", "free_cash_flow",
  "operating_cf", "operating_cash_flow", "net_change_cash",
]);

export const ORDERED_LINE_ITEMS = [
  "revenue", "cogs", "gross_profit", "gross_margin_pct",
  "sga", "rd", "other_opex", "total_opex",
  "ebitda", "ebitda_margin_pct", "da", "ebit",
  "interest_expense", "ebt", "tax", "net_income", "sde",
  "cash", "accounts_receivable", "inventory", "other_current_assets", "total_current_assets",
  "ppe_net", "goodwill", "intangibles", "total_assets",
  "accounts_payable", "short_term_debt", "other_current_liabilities", "total_current_liabilities",
  "long_term_debt", "total_liabilities", "total_equity",
  "operating_cf", "operating_cash_flow", "capex", "fcf", "free_cash_flow",
  "acquisitions", "debt_repayment", "dividends", "net_change_cash",
  "investing_activities", "financing_activities",
];

export type StatementType = "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";
export type ChartType = "revenue" | "growth" | "composition";

export const TAB_CONFIG: { key: StatementType; label: string; icon: string }[] = [
  { key: "INCOME_STATEMENT", label: "Income Statement", icon: "receipt_long" },
  { key: "BALANCE_SHEET", label: "Balance Sheet", icon: "account_balance" },
  { key: "CASH_FLOW", label: "Cash Flow", icon: "payments" },
];
