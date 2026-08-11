/**
 * Extraction eval harness — scorer tests.
 *
 * Proves the scorer flags the real InstateMe defects (captured buggy output)
 * and passes a known-correct extraction — all without calling the LLM, so it
 * runs in CI. The live runner (runner.ts) exercises the model separately.
 */
import { describe, it, expect } from 'vitest';
import { scoreCase } from '../src/services/extraction-evals/score.js';
import {
  INSTATEME_GOLDEN,
  INSTATEME_BUGGY_OUTPUT,
} from '../src/services/extraction-evals/cases/instateme.js';
import type { ScoredPeriod } from '../src/services/extraction-evals/types.js';

describe('extraction eval scorer — InstateMe', () => {
  it('flags the real 2026-07-03 buggy output', () => {
    const r = scoreCase(INSTATEME_GOLDEN, INSTATEME_BUGGY_OUTPUT);

    expect(r.passed).toBe(false);
    // 4 cohort labels emitted as periods.
    expect(r.metrics.phantomPeriods).toBe(4);
    // 2024×2 + FY2024, 2025×2 + FY2025, 2023 + FY2023  → 5 extra collapses.
    expect(r.metrics.duplicatePeriods).toBe(5);
    // Spurious "2026" HISTORICAL double-counting the "2026E" projection.
    expect(r.metrics.extraPeriods).toBe(1);
    // Composite is dragged down hard by the polluted period axis.
    expect(r.score).toBeLessThan(0.2);

    // The correct values ARE present — the failure is the period axis, not
    // the numbers: every expected period is still matched.
    expect(r.metrics.periodRecall).toBe(1);
  });

  it('passes a known-correct extraction (golden fed back in)', () => {
    const perfect: ScoredPeriod[] = INSTATEME_GOLDEN.expected.map((e) => ({
      period: e.period,
      periodType: e.periodType,
      lineItems: { ...e.lineItems },
    }));
    const r = scoreCase(INSTATEME_GOLDEN, perfect);

    expect(r.passed).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.metrics.phantomPeriods).toBe(0);
    expect(r.metrics.duplicatePeriods).toBe(0);
    expect(r.metrics.extraPeriods).toBe(0);
    expect(r.score).toBeGreaterThan(0.98);
  });

  it('FY-year duplicates collapse via the normalizer (regression guard)', () => {
    // After the FY/CY→bare-year fix, "FY2024" and "2024" share a canonical
    // key, so they register as a duplicate rather than two distinct periods.
    const twoRows: ScoredPeriod[] = [
      { period: '2024', periodType: 'HISTORICAL', lineItems: { revenue: 390558 } },
      { period: 'FY2024', periodType: 'HISTORICAL', lineItems: { revenue: 390558 } },
    ];
    const r = scoreCase(INSTATEME_GOLDEN, twoRows);
    expect(r.metrics.duplicatePeriods).toBe(1);
  });
});
