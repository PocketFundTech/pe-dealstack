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

  it('folds provenance into <name>_source strings and dedupes aliases', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(fixture());
    const li = result.statements[0].periods[0].lineItems as Record<string, unknown>;
    expect(li.revenue_source).toBe('p12: "Revenue of $45,200"');
    // total_revenue is an alias of revenue — canonical key wins, no duplicate
    expect(li.total_revenue).toBeUndefined();
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
});
