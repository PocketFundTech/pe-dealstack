/**
 * A printed subtotal of sibling accounts, e.g. QuickBooks "Total for 4000
 * Recurring Mgmt Fees" extracted as `revenue_total_recurring_mgmt_fees`, or
 * `total_opex_total_salaries_and_wages`. Counting it as one more account
 * double-counts its children (CSP 2026 YTD: "10 accounts sum to $10.5M, but
 * revenue is $5.8M" while the accounts sum to exactly $5.795M, 15 Oct 2026).
 */
export function isPrintedSubtotalKey(key: string, parent: string): boolean {
  return key.startsWith(`${parent}_total_`) || key.startsWith(`${parent}_subtotal_`);
}
