/**
 * EBITDA derivation on the live Claude extraction path (fix plan A3).
 * Before: only the legacy engine derived EBITDA, so QuickBooks-style P&Ls
 * extracted by Claude stored no EBITDA at all.
 */
import { describe, it, expect } from 'vitest';
import type { ExtractionResponse } from '../src/services/extraction/extractionSchema.js';
import { toClassificationResult } from '../src/services/extraction/normalize.js';
import { computeSourceMatchAvg } from '../src/services/agents/financialAgent/nodes/storeNode.js';

const item = (name: string, value: number) => ({ name, value, sourcePage: 1, sourceQuote: `${name} ${value}` });

function incomeStatement(lineItems: ReturnType<typeof item>[], statementType: 'INCOME_STATEMENT' | 'CASH_FLOW' = 'INCOME_STATEMENT'): ExtractionResponse {
  return {
    statements: [{
      statementType, unitScale: 'MILLIONS', currency: 'USD',
      periods: [{ period: 'FY2024 (Jan - Dec 2024)', periodType: 'HISTORICAL', confidence: 90, lineItems }],
    }],
    overallConfidence: 90,
    warnings: [],
  };
}

const itemsOf = (raw: ExtractionResponse) => toClassificationResult(raw).statements[0].periods[0].lineItems as Record<string, unknown>;

describe('Claude path derives missing income-statement fields', () => {
  it('EBITDA = EBIT + D&A, tagged as derived, with margin', () => {
    const li = itemsOf(incomeStatement([item('revenue', 27.3), item('ebit', 2.1), item('da', 0.7)]));
    expect(li.ebitda).toBeCloseTo(2.8);
    expect(li.ebitda_source).toBe('derived: ebit + da');
    expect(li.ebitda_margin_pct).toBeCloseTo(10.26, 2);
  });

  it('EBITDA = GP − total OpEx when there is no EBIT', () => {
    const li = itemsOf(incomeStatement([item('revenue', 20), item('gross_profit', 6), item('total_opex', 4)]));
    expect(li.ebitda).toBe(2);
    expect(li.ebitda_source).toBe('derived: gross_profit - total_opex');
  });

  it('EBITDA built up from net income + interest + tax + D&A (QuickBooks style)', () => {
    const li = itemsOf(incomeStatement([item('revenue', 20), item('net_income', 1), item('interest_expense', 0.5), item('tax', 0.3), item('da', 0.7)]));
    expect(li.ebitda).toBeCloseTo(2.5);
    expect(li.ebitda_source).toBe('derived: net_income + interest_expense + tax + da');
  });

  it('bottom-up EBITDA strips other income / adds back other expense (one-offs are not operating)', () => {
    // Net income includes a 0.4 one-off gain (e.g. PPP forgiveness) and a 0.1 other expense.
    const li = itemsOf(incomeStatement([
      item('revenue', 20), item('net_income', 1.4), item('interest_expense', 0.5), item('tax', 0.3), item('da', 0.7),
      item('other_income', 0.4), item('other_expense', 0.1),
    ]));
    expect(li.ebitda).toBeCloseTo(2.6); // 1.4 + 0.5 + 0.3 + 0.7 − 0.4 + 0.1
    expect(li.ebitda_source).toBe('derived: net_income + interest_expense + tax + da - other_income + other_expense');
  });

  it('bottom-up EBITDA uses raw other-income sub-accounts when no total is printed', () => {
    const li = itemsOf(incomeStatement([
      item('revenue', 20), item('net_income', 1.4), item('interest_expense', 0.5), item('tax', 0.3), item('da', 0.7),
      { ...item('ppp_loan_forgiveness', 0.4), parent: 'other_income' } as ReturnType<typeof item>,
    ]));
    expect(li.ebitda).toBeCloseTo(2.5);
    expect(String(li.ebitda_source)).toContain('- other_income');
  });

  it('never overwrites a reported EBITDA', () => {
    const li = itemsOf(incomeStatement([item('revenue', 20), item('ebitda', 3), item('ebit', 2.1), item('da', 0.7)]));
    expect(li.ebitda).toBe(3);
    expect(li.ebitda_source).toBe('ebitda 3');
  });

  it('does not derive on cash-flow statements', () => {
    const li = itemsOf(incomeStatement([item('ebit', 2.1), item('da', 0.7)], 'CASH_FLOW'));
    expect(li.ebitda).toBeUndefined();
  });

  it('derived sources are skipped by source-match scoring', () => {
    const result = toClassificationResult(incomeStatement([item('revenue', 27.3), item('ebit', 2.1), item('da', 0.7)]));
    // Every real quote is in the text → 100; a derived marker must not drag it down.
    expect(computeSourceMatchAvg(result.statements, 'revenue 27.3 ebit 2.1 da 0.7')).toBe(100);
  });
});
