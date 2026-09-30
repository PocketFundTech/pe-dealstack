/**
 * Fix plan B2 (sheet scoring) and B4 (cash-flow signs, statement checks).
 */
import { describe, it, expect } from 'vitest';
import type { ExtractionResponse } from '../src/services/extraction/extractionSchema.js';
import { toClassificationResult } from '../src/services/extraction/normalize.js';
import { isCashOutflowKey } from '../src/services/financialDerivations.js';
import { scoreSheet } from '../src/services/excelFinancialExtractor.js';
import { validateLineItems } from '../src/services/financialSchema.js';
import { validateStatements } from '../src/services/financialValidator.js';

const item = (name: string, value: number) => ({ name, value, sourcePage: 1, sourceQuote: `${name} ${value}` });

function cashFlow(lineItems: ReturnType<typeof item>[]): ExtractionResponse {
  return {
    statements: [{
      statementType: 'CASH_FLOW', unitScale: 'MILLIONS', currency: 'USD',
      periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems }],
    }],
    overallConfidence: 90,
    warnings: [],
  };
}

describe('cash-flow sign pass (B4)', () => {
  it('stores outflows negative (SRM: owner distributions +1.27 → −1.27)', () => {
    const r = toClassificationResult(cashFlow([
      item('operating_cf', 2.0), item('capex', 0.9), item('owner_distributions', 1.27),
      item('debt_repayment', -1.3), item('proceeds_from_debt', 1.1),
    ]));
    const li = r.statements[0].periods[0].lineItems;
    expect(li.capex).toBe(-0.9);
    expect(li.owner_distributions).toBe(-1.27);
    expect(li.debt_repayment).toBe(-1.3);     // already negative — unchanged
    expect(li.proceeds_from_debt).toBe(1.1);  // inflow — unchanged
    expect(li.operating_cf).toBe(2.0);
    expect(r.warnings.some(w => w.includes('owner_distributions stored as an outflow'))).toBe(true);
  });

  it.each([
    ['capex', true], ['capex_maintenance', true], ['dividends_paid', true], ['distributions', true],
    ['acquisitions', true], ['share_repurchases', true], ['purchase_of_equipment', true],
    ['capex_source', false], ['proceeds_from_sale_of_equipment', false], ['net_change_cash', false],
    ['operating_cf', false], ['capex_pct', false],
  ])('isCashOutflowKey(%s) = %s', (key, expected) => {
    expect(isCashOutflowKey(key)).toBe(expected);
  });
});

describe('total_debt has its own key (B4)', () => {
  it('is no longer renamed to long_term_debt', () => {
    const { normalized } = validateLineItems('BALANCE_SHEET', { total_debt: 5 });
    expect(normalized.total_debt).toBe(5);
    expect(normalized.long_term_debt).toBeUndefined();
  });
});

describe('statement checks (B4)', () => {
  const stmt = (statementType: 'BALANCE_SHEET' | 'CASH_FLOW', lineItems: Record<string, number>) => ({
    statementType, unitScale: 'MILLIONS' as const, currency: 'USD',
    periods: [{ period: '2024', periodType: 'HISTORICAL' as const, confidence: 90, lineItems }],
  });

  it('flags CFO + CFI + CFF ≠ net change in cash as an error', () => {
    const res = validateStatements([stmt('CASH_FLOW', {
      operating_cf: 2, investing_activities: -1, financing_activities: 1.27, net_change_cash: -0.27,
    })]);
    const all = JSON.stringify(res);
    expect(all).toContain('cf_sections_sum');
    expect(all).toContain("Cash flow sections don't sum");
  });

  it('warns when a balance sheet has no totals', () => {
    const res = validateStatements([stmt('BALANCE_SHEET', { cash: 1, accounts_receivable: 2, long_term_debt: 3, ppe_net: 4 })]);
    expect(JSON.stringify(res)).toContain('bs_has_totals');
  });
});

describe('sheet scoring (B2)', () => {
  it('scores "CFS Source" / "BS Source" as statements, above the valuation summary', () => {
    expect(scoreSheet('CFS Source')).toBeGreaterThanOrEqual(90);
    expect(scoreSheet('BS Source')).toBeGreaterThanOrEqual(90);
    expect(scoreSheet('Valuation Summary')).toBeLessThanOrEqual(40);
    expect(scoreSheet('Returns')).toBeLessThanOrEqual(40);
    expect(scoreSheet('Historical Balance Sheet')).toBeGreaterThan(scoreSheet('Balance Sheet'));
    expect(scoreSheet('BS')).toBe(70);
  });
});
