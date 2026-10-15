/**
 * QuickBooks tabs print "Total for 4000 Recurring Mgmt Fees" next to the
 * accounts it sums. Extracted as `revenue_total_recurring_mgmt_fees` it was
 * counted as one more account: CSP's 2026 YTD showed "revenue: 10 itemised
 * accounts sum to $10.5M, but revenue is $5.8M" — the leaves sum to exactly
 * $5.795M (15 Oct 2026, real rows from the paid run).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { validateStatements } from '../src/services/financialValidator.js';
import { normaliseStatements } from '../src/services/dealModel/assumptions.js';

const rows = JSON.parse(readFileSync(new URL('./fixtures/csp-paid-run-statements.json', import.meta.url), 'utf8'));
const ytd = rows.find((r: { period: string }) => r.period.startsWith('2026 YTD'));

describe('printed subtotal lines are not extra accounts', () => {
  it('the validator does not flag the 2026 YTD revenue / opex account sums', () => {
    const result = validateStatements([{ statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD', periods: [{ period: ytd.period, periodType: 'HISTORICAL', confidence: 90, lineItems: ytd.lineItems }] }] as any);
    const sums = result.checks.filter((c: any) => c.check === 'children_sum' && !c.passed);
    expect(sums.map((c: any) => c.message)).toEqual([]);
  });

  it('the model does not carry subtotal lines as accounts', () => {
    const { rows: history } = normaliseStatements(rows);
    const y = history.find((r) => r.period.startsWith('2026 YTD'))!;
    expect(Object.keys(y.lines ?? {}).filter((k) => /_total_/.test(k) && k !== 'total_opex')).toEqual([]);
  });
});
