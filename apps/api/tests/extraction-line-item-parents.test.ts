/**
 * Fix plan C1: the live extraction records each raw account's parent, so
 * QuickBooks lines nest under the right section instead of trailing after
 * Net Income; contra-revenue is negative; children are checked against
 * their parent.
 */
import { describe, it, expect } from 'vitest';
import type { ExtractionResponse } from '../src/services/extraction/extractionSchema.js';
import { extractionResponseZod } from '../src/services/extraction/extractionSchema.js';
import { toClassificationResult } from '../src/services/extraction/normalize.js';
import { validateStatements } from '../src/services/financialValidator.js';

const item = (name: string, value: number, parent: string | null = null) =>
  ({ name, value, sourcePage: 1, sourceQuote: `${name} ${value}`, parent });

function pl(lineItems: ReturnType<typeof item>[]): ExtractionResponse {
  return {
    statements: [{
      statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD', sheetName: 'P&L', sourceKind: 'source_statement',
      periods: [{ period: 'FY2024 (Jan - Dec 2024)', periodType: 'HISTORICAL', confidence: 90, lineItems }],
    }],
    overallConfidence: 90,
    warnings: [],
  } as ExtractionResponse;
}

const itemsOf = (raw: ExtractionResponse) => toClassificationResult(raw).statements[0].periods[0].lineItems as Record<string, unknown>;

describe('parent nesting', () => {
  const li = itemsOf(pl([
    item('revenue', 27.3), item('gross_sales', 27.6, 'revenue'), item('discounts', 0.0126, 'revenue'), item('sales', 27.0, 'revenue'),
    item('cogs', 18), item('sand_cos', 3, 'cogs'), item('fly_ash_cos', 2, 'cogs'), item('cogs_cement', 13, 'cogs'),
    item('goodwill_amortization_754', 0.1, 'da'), item('net_other_income', 0.2, 'other_income'),
  ]));

  it('renames raw accounts to <parent>_<label>', () => {
    expect(li).toHaveProperty('revenue_gross_sales', 27.6);
    expect(li).toHaveProperty('cogs_sand_cos', 3);
    expect(li).toHaveProperty('cogs_fly_ash_cos', 2);
    expect(li).toHaveProperty('da_goodwill_amortization_754', 0.1);
    expect(li).toHaveProperty('other_income_net_other_income', 0.2);
    expect(li).not.toHaveProperty('sand_cos');
  });

  it('keeps already-prefixed and standard keys as they are', () => {
    expect(li).toHaveProperty('cogs_cement', 13);
    expect(li).toHaveProperty('revenue', 27.3);
    expect(li).toHaveProperty('cogs', 18);
  });

  it('a "Sales" account under revenue is kept, not dropped as a revenue alias', () => {
    expect(li).toHaveProperty('revenue_sales', 27.0);
  });

  it('stores contra-revenue negative', () => {
    expect(li.revenue_discounts).toBe(-0.0126);
  });

  it('keeps the source quote with the renamed key', () => {
    expect(li.cogs_sand_cos_source).toBe('sand_cos 3');
  });
});

describe('schema', () => {
  it('still parses pre-v4 output without parent / sheetName / sourceKind', () => {
    const old = {
      statements: [{ statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD',
        periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: [{ name: 'revenue', value: 1, sourcePage: 1, sourceQuote: null }] }] }],
      overallConfidence: 90, warnings: [],
    };
    expect(extractionResponseZod.safeParse(old).success).toBe(true);
  });

  it('rejects a parent outside the standard list', () => {
    const bad = pl([item('x', 1, 'made_up_parent')]);
    expect(extractionResponseZod.safeParse(bad).success).toBe(false);
  });
});

describe('children vs parent check', () => {
  const stmt = (lineItems: Record<string, number>) => [{
    statementType: 'INCOME_STATEMENT' as const, unitScale: 'MILLIONS' as const, currency: 'USD',
    periods: [{ period: '2024', periodType: 'HISTORICAL' as const, confidence: 90, lineItems }],
  }];

  it('warns when itemised accounts do not add up to the parent', () => {
    expect(JSON.stringify(validateStatements(stmt({ cogs: 18, cogs_sand: 3, cogs_cement: 5 })))).toContain('children_sum');
  });

  it('is quiet when they do', () => {
    expect(JSON.stringify(validateStatements(stmt({ cogs: 18, cogs_sand: 5, cogs_cement: 13 })))).not.toContain('children_sum');
  });
});
