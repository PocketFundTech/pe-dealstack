/**
 * Financial Cross-Verify — Unit Tests
 *
 * Covers the pure-function pieces of the cross-verify path: diff
 * computation, agreement tolerance, and graceful fall-through when the
 * Anthropic key is unset.
 *
 * The full GPT+Claude+reconciler integration is exercised in the e2e
 * harness (apps/api/scripts/test-extraction.ts) — these unit tests pin
 * the contract between the classifiers without burning Anthropic /
 * OpenAI quota.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Force the GPT classifier off so the env-flag fall-through test doesn't
// hit a real OpenAI / OpenRouter endpoint. The repo's tests/setup.ts
// declares an identical mock but vitest.config.ts doesn't wire setupFiles,
// so the mock has to be in-file.
vi.mock('../src/openai.js', () => ({
  openai: null,
  isAIEnabled: () => false,
  trackedChatCompletion: vi.fn(),
}));

import { computeDiffs, classifyFinancialsCrossVerified } from '../src/services/financialCrossVerify.js';
import type { ClassificationResult } from '../src/services/financialClassifier.js';

function stmt(overrides: Partial<ClassificationResult>): ClassificationResult {
  return {
    statements: [],
    overallConfidence: 90,
    warnings: [],
    ...overrides,
  };
}

describe('computeDiffs', () => {
  it('reports no diffs when both extractions are byte-identical', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { revenue: 100, ebitda: 25 },
        }],
      }],
    });
    expect(computeDiffs(a, a)).toEqual([]);
  });

  it('treats values within 0.5% relative tolerance as agreement', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { revenue: 100, ebitda: 25 },
        }],
      }],
    });
    // GPT: revenue 100, Claude: revenue 100.4 → 0.4% diff → no diff
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 88,
          lineItems: { revenue: 100.4, ebitda: 25.1 },
        }],
      }],
    });
    expect(computeDiffs(a, b)).toEqual([]);
  });

  it('flags values that exceed the agreement tolerance', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { revenue: 100 },
        }],
      }],
    });
    // 100 vs 110 → 10% diff → flagged
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 88,
          lineItems: { revenue: 110 },
        }],
      }],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('lineItem:revenue');
    expect(diffs[0].gptValue).toBe(100);
    expect(diffs[0].claudeValue).toBe(110);
  });

  it('flags unitScale and currency mismatches at the statement level', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [],
      }],
    });
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'THOUSANDS', // 1000× off — must be flagged
        currency: 'EUR',
        periods: [],
      }],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs.map((d) => d.field).sort()).toEqual(['currency', 'unitScale']);
  });

  it('flags missing-statement when one side has a statement type the other lacks', () => {
    const a = stmt({
      statements: [
        { statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD', periods: [] },
        { statementType: 'BALANCE_SHEET',    unitScale: 'MILLIONS', currency: 'USD', periods: [] },
      ],
    });
    const b = stmt({
      statements: [
        { statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD', periods: [] },
      ],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('missing-statement');
    expect(diffs[0].statementType).toBe('BALANCE_SHEET');
    expect(diffs[0].gptValue).toBe('present');
    expect(diffs[0].claudeValue).toBe('missing');
  });

  it('flags missing-period when one side has a period the other lacks', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          { period: '2023', periodType: 'HISTORICAL', confidence: 90, lineItems: { revenue: 80 } },
          { period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { revenue: 100 } },
        ],
      }],
    });
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          { period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { revenue: 100 } },
        ],
      }],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('missing-period');
    expect(diffs[0].period).toBe('2023');
  });

  it('flags one-side-null vs present line items', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { revenue: 100, ebitda: 25 }, // ebitda extracted
        }],
      }],
    });
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { revenue: 100, ebitda: null }, // ebitda missed
        }],
      }],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('lineItem:ebitda');
    expect(diffs[0].gptValue).toBe(25);
    expect(diffs[0].claudeValue).toBeNull();
  });

  it('ignores _source citation strings (text wording differences are not value disagreements)', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: {
            revenue: 100,
            // @ts-expect-error _source field is a string by convention, stored alongside numeric values
            revenue_source: 'Revenue of $100M (page 12)',
          },
        }],
      }],
    });
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: {
            revenue: 100,
            // @ts-expect-error _source field
            revenue_source: 'Revenue: $100 million per the income statement',
          },
        }],
      }],
    });
    expect(computeDiffs(a, b)).toEqual([]);
  });

  it('flags zero-vs-nonzero as disagreement (avoids div-by-zero false positives)', () => {
    const a = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'ACTUALS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { ebitda: 0 },
        }],
      }],
    });
    const b = stmt({
      statements: [{
        statementType: 'INCOME_STATEMENT',
        unitScale: 'ACTUALS',
        currency: 'USD',
        periods: [{
          period: '2024',
          periodType: 'HISTORICAL',
          confidence: 90,
          lineItems: { ebitda: 100 },
        }],
      }],
    });
    const diffs = computeDiffs(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('lineItem:ebitda');
  });
});

describe('classifyFinancialsCrossVerified — env-flag fall-through', () => {
  // Save and restore the env so we don't leak state across tests in this
  // file or to other files in the same vitest worker.
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('falls through to GPT-only when ANTHROPIC_API_KEY is unset', async () => {
    // The setup.ts mock already has openai disabled, so classifyFinancials
    // returns null for any input. We just verify that cross-verify doesn't
    // throw, doesn't try to reach the SDK, and returns whatever the GPT
    // path returns (null in the mock).
    const result = await classifyFinancialsCrossVerified('a sample financial document with enough text to pass the 100-char minimum so the classifier actually attempts the call rather than short-circuiting on length.');
    expect(result).toBeNull();
  });
});
