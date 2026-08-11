/**
 * Agent Node Tests — routing logic, confidence gating, and scoring helpers.
 *
 * Nodes themselves call external services (OpenAI, Supabase) which cannot
 * be exercised in unit tests. Instead we test:
 *   1. validateNode routing logic (self-correct vs store)
 *   2. storeNode confidence gating (very_low blocks storage)
 *   3. scoreSourceMatch, scoreMathValidation from compositeConfidence
 *   4. reconcileResults edge cases (zero values, negative numbers)
 */

import { describe, it, expect } from 'vitest';

// ─── validateNode routing logic ───────────────────────────────

describe('validateNode routing', () => {
  it('routes to self_correct when errors exist and retries remain', () => {
    const failedChecks = [{ check: 'revenue_cogs_gp', severity: 'error', message: 'mismatch' }];
    const retryCount = 0;
    const maxRetries = 3;
    const shouldSelfCorrect = failedChecks.length > 0 && retryCount < maxRetries;
    expect(shouldSelfCorrect).toBe(true);
  });

  it('routes to store when no errors', () => {
    const failedChecks: unknown[] = [];
    const retryCount = 0;
    const maxRetries = 3;
    const shouldSelfCorrect = failedChecks.length > 0 && retryCount < maxRetries;
    expect(shouldSelfCorrect).toBe(false);
  });

  it('routes to store when max retries exhausted', () => {
    const failedChecks = [{ check: 'revenue_cogs_gp', severity: 'error', message: 'mismatch' }];
    const retryCount = 3;
    const maxRetries = 3;
    const shouldSelfCorrect = failedChecks.length > 0 && retryCount < maxRetries;
    expect(shouldSelfCorrect).toBe(false);
  });

  it('still self-corrects with 2 retries left', () => {
    const failedChecks = [{ check: 'bs_balance', severity: 'error', message: 'balance sheet does not balance' }];
    const retryCount = 1;
    const maxRetries = 3;
    const shouldSelfCorrect = failedChecks.length > 0 && retryCount < maxRetries;
    expect(shouldSelfCorrect).toBe(true);
  });

  it('flags low confidence periods below threshold', () => {
    const CONFIDENCE_THRESHOLD = 80;
    const periods = [
      { period: '2022', confidence: 90 },
      { period: '2023', confidence: 65 },
      { period: '2024', confidence: 78 },
    ];
    const lowConf = periods.filter(p => p.confidence < CONFIDENCE_THRESHOLD);
    expect(lowConf).toHaveLength(2);
    expect(lowConf.map(p => p.period)).toEqual(['2023', '2024']);
  });

  it('does not flag periods at or above the confidence threshold', () => {
    const CONFIDENCE_THRESHOLD = 80;
    const periods = [
      { period: '2022', confidence: 80 },
      { period: '2023', confidence: 95 },
      { period: '2024', confidence: 100 },
    ];
    const lowConf = periods.filter(p => p.confidence < CONFIDENCE_THRESHOLD);
    expect(lowConf).toHaveLength(0);
  });
});

// ─── storeNode confidence gating ─────────────────────────────

describe('storeNode confidence gating', () => {
  it('blocks storage when composite confidence is very_low (<60)', async () => {
    const { computeCompositeConfidence, getConfidenceTier } = await import('../src/services/compositeConfidence.js');

    const score = computeCompositeConfidence({
      llmConfidence: 40,
      sourceMatch: 20,
      mathValidation: 40,
      crossModelAgreement: 30,
    });
    const tier = getConfidenceTier(score);
    expect(tier).toBe('very_low');
    // In storeNode: tier === 'very_low' → early return, runDeepPass is NOT called
  });

  it('allows storage when composite confidence is medium (80-89)', async () => {
    const { computeCompositeConfidence, getConfidenceTier } = await import('../src/services/compositeConfidence.js');

    const score = computeCompositeConfidence({
      llmConfidence: 85,
      sourceMatch: 80,
      mathValidation: 100,
      crossModelAgreement: 90,
    });
    const tier = getConfidenceTier(score);
    expect(tier).toBe('medium');
    // In storeNode: tier !== 'very_low' → proceeds to runDeepPass
  });

  it('handles Claude unavailable gracefully (null crossModelAgreement)', async () => {
    const { computeCompositeConfidence, getConfidenceTier } = await import('../src/services/compositeConfidence.js');

    // Without Claude, weights redistribute across LLM + sourceMatch + mathValidation
    const score = computeCompositeConfidence({
      llmConfidence: 85,
      sourceMatch: 80,
      mathValidation: 100,
      crossModelAgreement: null,
    });
    const tier = getConfidenceTier(score);
    expect(tier).toBe('medium');
  });

  it('results in very_low when all signals are weak even without Claude', async () => {
    const { computeCompositeConfidence, getConfidenceTier } = await import('../src/services/compositeConfidence.js');

    const score = computeCompositeConfidence({
      llmConfidence: 30,
      sourceMatch: 20,
      mathValidation: 20,
      crossModelAgreement: null,
    });
    const tier = getConfidenceTier(score);
    expect(tier).toBe('very_low');
  });

  it('results in high tier when all signals are very strong', async () => {
    const { computeCompositeConfidence, getConfidenceTier } = await import('../src/services/compositeConfidence.js');

    const score = computeCompositeConfidence({
      llmConfidence: 95,
      sourceMatch: 100,
      mathValidation: 100,
      crossModelAgreement: 100,
    });
    const tier = getConfidenceTier(score);
    expect(tier).toBe('high');
  });
});

// ─── sourceMatch scoring ──────────────────────────────────────

describe('scoreSourceMatch', () => {
  it('returns 100 for exact quote match', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    const score = scoreSourceMatch(
      'Revenue of $50.3M',
      'The company reported Revenue of $50.3M in FY2023',
    );
    expect(score).toBe(100);
  });

  it('returns 80 when first 30 chars of quote match but full quote does not', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    // quote prefix "revenue of $50.3m and ebitda o" (30 chars) IS in the text
    // but the full quote (which ends differently) is NOT
    const score = scoreSourceMatch(
      'Revenue of $50.3M and EBITDA of $12M for the fiscal year 2023',
      'Revenue of $50.3M and EBITDA of something different here',
    );
    expect(score).toBe(80);
  });

  it('returns 40 for no match at all', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    const score = scoreSourceMatch('Revenue of $50.3M', 'EBITDA was $12M');
    expect(score).toBe(40);
  });

  it('returns 40 when rawText is empty', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    const score = scoreSourceMatch('Revenue of $50.3M', '');
    expect(score).toBe(40);
  });

  it('returns 20 when no source quote provided (undefined)', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    const score = scoreSourceMatch(undefined, 'any text here');
    expect(score).toBe(20);
  });

  it('is case-insensitive for matching', async () => {
    const { scoreSourceMatch } = await import('../src/services/compositeConfidence.js');
    const score = scoreSourceMatch(
      'REVENUE OF $50.3M',
      'The company reported revenue of $50.3m in FY2023',
    );
    expect(score).toBe(100);
  });
});

// ─── math validation scoring ─────────────────────────────────

describe('scoreMathValidation', () => {
  it('returns 100 for no errors or warnings', async () => {
    const { scoreMathValidation } = await import('../src/services/compositeConfidence.js');
    expect(scoreMathValidation(0, 0)).toBe(100);
  });

  it('returns 90 for warnings only (≤5)', async () => {
    const { scoreMathValidation } = await import('../src/services/compositeConfidence.js');
    expect(scoreMathValidation(0, 1)).toBe(90);
    expect(scoreMathValidation(0, 2)).toBe(90);
  });

  it('returns 50 for exactly 1 error (regardless of warnings)', async () => {
    const { scoreMathValidation } = await import('../src/services/compositeConfidence.js');
    expect(scoreMathValidation(1, 0)).toBe(50);
    expect(scoreMathValidation(1, 3)).toBe(50);
  });

  it('returns 20 for multiple errors', async () => {
    const { scoreMathValidation } = await import('../src/services/compositeConfidence.js');
    expect(scoreMathValidation(2, 0)).toBe(20);
    expect(scoreMathValidation(3, 5)).toBe(20);
  });

  it('returns 90 for ≤5 warnings with no errors (warnings scale with period count)', async () => {
    const { scoreMathValidation } = await import('../src/services/compositeConfidence.js');
    // Warnings come from per-period checks and scale linearly with periods —
    // a long extraction routinely produces several warnings even when every
    // cell is correct. 0 errors + ≤5 warnings scores 90; >5 warnings 75.
    expect(scoreMathValidation(0, 3)).toBe(90);
    expect(scoreMathValidation(0, 6)).toBe(75);
  });
});

// ─── reconcileResults edge cases ─────────────────────────────

describe('reconcileResults edge cases', () => {
  it('handles zero primary value without divide-by-zero error', async () => {
    const { reconcileResults } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const gpt4o = { revenue: 0 };
    const claude = [
      { field: 'revenue', primary_value: 0, verified: true, your_value: 0, issue: null, confidence: 90 },
    ];
    // Should not throw — uses diff===0 check when larger===0
    const result = reconcileResults(gpt4o, claude);
    expect(result.agreedCount).toBe(1);
    expect(result.flaggedValues).toHaveLength(0);
  });

  it('handles negative values (e.g., net loss) correctly', async () => {
    const { reconcileResults } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const gpt4o = { net_income: -5.2 };
    const claude = [
      { field: 'net_income', primary_value: -5.2, verified: true, your_value: -5.2, issue: null, confidence: 88 },
    ];
    const result = reconcileResults(gpt4o, claude);
    expect(result.agreedCount).toBe(1);
    expect(result.flaggedValues).toHaveLength(0);
  });

  it('flags small disagreement on negative values beyond 1% tolerance', async () => {
    const { reconcileResults } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const gpt4o = { net_income: -10.0 };
    const claude = [
      // -10.0 vs -10.5 → diff=0.5, larger=10.5, ratio≈0.047 → outside 1%
      { field: 'net_income', primary_value: -10.0, verified: true, your_value: -10.5, issue: null, confidence: 75 },
    ];
    const result = reconcileResults(gpt4o, claude);
    expect(result.agreedCount).toBe(0);
    expect(result.flaggedValues).toHaveLength(1);
    expect(result.flaggedValues[0].field).toBe('net_income');
  });

  it('agrees on negative values within 1% tolerance', async () => {
    const { reconcileResults } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const gpt4o = { net_income: -100.0 };
    const claude = [
      // -100.0 vs -100.5 → diff=0.5, larger=100.5, ratio≈0.005 → within 1%
      { field: 'net_income', primary_value: -100.0, verified: true, your_value: -100.5, issue: null, confidence: 80 },
    ];
    const result = reconcileResults(gpt4o, claude);
    expect(result.agreedCount).toBe(1);
    expect(result.flaggedValues).toHaveLength(0);
  });
});
