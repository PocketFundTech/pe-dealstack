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

  it('cleans reciprocal-multiply float noise without a fixed-decimal cutoff', async () => {
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
    // 99999 * (1/1_000_000) = 0.09999899999999999 raw; cleaned to the exact
    // value. (The old round-to-4-decimals rule returned 0.1 here — a $1
    // error that becomes a total loss for smaller values; see Northwind below.)
    expect(result.statements[0].periods[0].lineItems.revenue).toBe(0.099999);
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

// ─── Regression: Northwind-Model-QA.xlsx (prod, 2026-09-30) ───────────
// One "P&L" sheet titled "Northwind Cold Chain — P&L (INR crore)", FY2023-
// FY2025. The raw scale enum had no crore/lakh option, so the model had to
// describe an "INR crore" table as UNITS (values "as printed"). normalize
// then multiplied by 1e-6 and round4()'d: 182.4 → 0.0002 (shown as 200),
// 251.3 → 0.0003 (300), gross profit → 0.0001 (100), EBITDA/OpEx → 0.
const NORTHWIND_ROWS: Array<[string, string, [number, number, number]]> = [
  ['revenue', 'Revenue', [182.4, 214.9, 251.3]],
  ['cogs', 'COGS', [118.6, 137.5, 158.4]],
  ['gross_profit', 'Gross profit', [63.8, 77.4, 92.9]],
  ['total_opex', 'Opex', [34.7, 40.9, 48.7]],
  ['ebitda', 'EBITDA', [29.1, 36.5, 44.2]],
];

function northwind(unitScale: ExtractionResponse['statements'][number]['unitScale']): ExtractionResponse {
  const cols = ['B', 'C', 'D'];
  return {
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale,
        currency: 'INR',
        periods: ['FY2023', 'FY2024', 'FY2025'].map((period, i) => ({
          period,
          periodType: 'HISTORICAL' as const,
          confidence: 88,
          lineItems: NORTHWIND_ROWS.map(([name, label, values], r) => ({
            name,
            value: values[i],
            sourcePage: 1,
            sourceQuote: `P&L!${cols[i]}${r + 3}: ${values[i]} (${label})`,
          })),
        })),
      },
    ],
    overallConfidence: 88,
    warnings: [],
  };
}

describe('toClassificationResult — Indian crore/lakh scales (Northwind regression)', () => {
  it('accepts CRORES/LAKHS in the raw schema (zod + JSON schema) and names them in both prompts', async () => {
    const schema = await import('../src/services/extraction/extractionSchema.js');
    expect(schema.extractionResponseZod.safeParse(northwind('CRORES')).success).toBe(true);
    const lakhs = northwind('LAKHS');
    expect(schema.extractionResponseZod.safeParse(lakhs).success).toBe(true);
    const enumValues = schema.EXTRACTION_JSON_SCHEMA.properties.statements.items.properties.unitScale.enum as readonly string[];
    expect(enumValues).toContain('CRORES');
    expect(enumValues).toContain('LAKHS');
    expect(schema.buildExtractionSystemPrompt('2026-09-30')).toMatch(/CRORES/);
    expect(schema.buildExcelContainerInstruction('2026-09-30')).toMatch(/CRORES/);
  });

  it('converts an INR-crore P&L to INR millions (1 crore = 10 million) without losing any value', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(northwind('CRORES'));
    const stmt = result.statements[0];
    expect(stmt.unitScale).toBe('MILLIONS');
    expect(stmt.currency).toBe('INR');
    const byPeriod = Object.fromEntries(stmt.periods.map((p) => [p.period, p.lineItems]));
    expect(byPeriod.FY2023.revenue).toBe(1824);
    expect(byPeriod.FY2024.revenue).toBe(2149);
    expect(byPeriod.FY2025.revenue).toBe(2513);
    expect(byPeriod.FY2023.ebitda).toBe(291);
    expect(byPeriod.FY2025.ebitda).toBe(442);
    expect(byPeriod.FY2024.gross_profit).toBe(774);
    expect(byPeriod.FY2025.total_opex).toBe(487);
    expect(byPeriod.FY2025.cogs).toBe(1584);
    // Provenance stays next to the numeric key, untouched.
    expect((byPeriod.FY2023 as Record<string, unknown>).revenue_source).toBe('P&L!B3: 182.4 (Revenue)');
  });

  it('converts LAKHS at 0.1 million per lakh', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(northwind('LAKHS'));
    expect(result.statements[0].periods[0].lineItems.revenue).toBe(18.24);
    expect(result.statements[0].periods[2].lineItems.ebitda).toBe(4.42);
  });

  it('never rounds a scaled value to zero — UNITS-scale small values keep full precision', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(northwind('UNITS'));
    const [fy23, , fy25] = result.statements[0].periods.map((p) => p.lineItems);
    // Previously 0.0002 / 0.0003 / 0 — the exact wrong numbers seen in prod.
    expect(fy23.revenue).toBe(0.0001824);
    expect(fy25.revenue).toBe(0.0002513);
    expect(fy23.ebitda).toBe(0.0000291);
    expect(fy25.total_opex).toBe(0.0000487);
    for (const li of result.statements[0].periods.map((p) => p.lineItems)) {
      for (const key of ['revenue', 'cogs', 'gross_profit', 'total_opex', 'ebitda']) {
        expect(li[key]).not.toBe(0);
      }
    }
  });
});
