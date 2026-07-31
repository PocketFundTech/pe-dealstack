import { describe, it, expect } from 'vitest';
import { computeCompositeConfidence, getConfidenceTier, scoreSourceMatch } from '../src/services/compositeConfidence.js';

describe('scoreSourceMatch', () => {
  it('scores a whitespace-only quote the same as an empty one (no real citation)', () => {
    // Regression: normalizing before the falsy check matters — a truthy
    // whitespace-only string previously slipped past `!sourceQuote` and then
    // matched via `''.includes('')`, scoring a perfect 100 for zero citation.
    expect(scoreSourceMatch('   ', 'The company reported revenue of $45.2M.')).toBe(20);
    expect(scoreSourceMatch('\n\t', 'The company reported revenue of $45.2M.')).toBe(20);
    expect(scoreSourceMatch('', 'The company reported revenue of $45.2M.')).toBe(20);
    expect(scoreSourceMatch(undefined, 'The company reported revenue of $45.2M.')).toBe(20);
  });

  it('still scores a real verbatim quote as a full match', () => {
    expect(scoreSourceMatch('revenue of $45.2M', 'The company reported revenue of $45.2M.')).toBe(100);
  });
});

describe('computeCompositeConfidence', () => {
  it('returns high confidence when all signals agree', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 95, sourceMatch: 100, mathValidation: 100, crossModelAgreement: 100,
    });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('returns low confidence when models disagree', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 90, sourceMatch: 80, mathValidation: 100, crossModelAgreement: 30,
    });
    expect(score).toBeLessThan(80);
  });

  it('redistributes weight when Claude is unavailable', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 90, sourceMatch: 90, mathValidation: 100, crossModelAgreement: null,
    });
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('getConfidenceTier', () => {
  it('returns "high" for 90-100', () => { expect(getConfidenceTier(95)).toBe('high'); });
  it('returns "medium" for 80-89', () => { expect(getConfidenceTier(85)).toBe('medium'); });
  it('returns "low" for 60-79', () => { expect(getConfidenceTier(70)).toBe('low'); });
  it('returns "very_low" for <60', () => { expect(getConfidenceTier(45)).toBe('very_low'); });
});
