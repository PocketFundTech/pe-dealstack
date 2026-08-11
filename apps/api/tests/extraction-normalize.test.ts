/**
 * Normalizer tests: raw as-printed extraction → ClassificationResult in
 * canonical millions, with _source provenance strings.
 */
import { describe, it, expect } from 'vitest';
import type { ExtractionResponse } from '../src/services/extraction/extractionSchema.js';

async function getNormalize() {
  const mod = await import('../src/services/extraction/normalize.js');
  return mod.toClassificationResult;
}

function fixture(overrides: Partial<ExtractionResponse> = {}): ExtractionResponse {
  return {
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale: 'THOUSANDS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 92,
            lineItems: [
              { name: 'revenue', value: 45200, sourcePage: 12, sourceQuote: 'Revenue of $45,200' },
              { name: 'total_revenue', value: 45200, sourcePage: 12, sourceQuote: 'Total revenue $45,200' },
              { name: 'ebitda_margin_pct', value: 18.5, sourcePage: 13, sourceQuote: 'EBITDA margin 18.5%' },
              { name: 'ebitda', value: 8362, sourcePage: 13, sourceQuote: 'EBITDA $8,362' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 90,
    warnings: [],
    ...overrides,
  };
}

describe('toClassificationResult', () => {
  it('converts THOUSANDS to millions and leaves _pct fields unscaled', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(fixture());
    const li = result.statements[0].periods[0].lineItems;
    expect(li.revenue).toBeCloseTo(45.2);
    expect(li.ebitda).toBeCloseTo(8.362);
    expect(li.ebitda_margin_pct).toBeCloseTo(18.5); // percentages never scaled
    expect(result.statements[0].unitScale).toBe('MILLIONS'); // post-conversion
  });

  it('folds provenance into <name>_source strings (bare quote, not wrapped) and dedupes aliases', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(fixture());
    const li = result.statements[0].periods[0].lineItems as Record<string, unknown>;
    // Bare verbatim quote — must be substring-matchable against real document
    // text by storeNode.ts's scoreSourceMatch(), which a wrapped/prefixed
    // string like `p12: "..."` would never match.
    expect(li.revenue_source).toBe('Revenue of $45,200');
    // total_revenue is an alias of revenue — canonical key wins, no duplicate
    expect(li.total_revenue).toBeUndefined();
  });

  it('falls back to a bare page marker when no source quote was captured', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'MILLIONS',
            currency: 'USD',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 70,
                lineItems: [{ name: 'revenue', value: 45.2, sourcePage: 9, sourceQuote: null }],
              },
            ],
          },
        ],
      }),
    );
    const li = result.statements[0].periods[0].lineItems as Record<string, unknown>;
    expect(li.revenue_source).toBe('p9');
  });

  it('prefers a later non-null value over an earlier null for the same name', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'MILLIONS',
            currency: 'USD',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 70,
                lineItems: [
                  { name: 'revenue', value: null, sourcePage: null, sourceQuote: null },
                  { name: 'revenue', value: 45.2, sourcePage: 9, sourceQuote: 'Revenue $45.2M' },
                ],
              },
            ],
          },
        ],
      }),
    );
    const li = result.statements[0].periods[0].lineItems as Record<string, unknown>;
    expect(li.revenue).toBe(45.2);
    expect(li.revenue_source).toBe('Revenue $45.2M');
  });

  it('rounds converted values to 4 decimals to avoid reciprocal-multiply float noise', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'UNITS',
            currency: 'USD',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 70,
                lineItems: [{ name: 'revenue', value: 99999, sourcePage: null, sourceQuote: null }],
              },
            ],
          },
        ],
      }),
    );
    // 99999 * (1/1_000_000) has float noise past 4 decimals without rounding.
    expect(result.statements[0].periods[0].lineItems.revenue).toBe(0.1);
  });

  it('adds a warning for non-USD currency and for BILLIONS scale conversion', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'BILLIONS',
            currency: 'EUR',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 80,
                lineItems: [{ name: 'revenue', value: 1.2, sourcePage: 3, sourceQuote: '€1.2bn revenue' }],
              },
            ],
          },
        ],
      }),
    );
    expect(result.statements[0].periods[0].lineItems.revenue).toBeCloseTo(1200);
    expect(result.warnings.some((w) => w.includes('EUR'))).toBe(true);
  });

  it('leaves invented _ratio/_multiple fields unscaled, same as _pct', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'THOUSANDS',
            currency: 'USD',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 70,
                lineItems: [
                  { name: 'tax_rate_pct', value: 21, sourcePage: null, sourceQuote: null },
                  { name: 'debt_to_ebitda_ratio', value: 3.2, sourcePage: null, sourceQuote: null },
                  { name: 'ev_multiple', value: 8.5, sourcePage: null, sourceQuote: null },
                ],
              },
            ],
          },
        ],
      }),
    );
    const li = result.statements[0].periods[0].lineItems;
    expect(li.tax_rate_pct).toBe(21);
    expect(li.debt_to_ebitda_ratio).toBe(3.2);
    expect(li.ev_multiple).toBe(8.5);
  });
});
