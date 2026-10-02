/**
 * Fix plan G9: one fiscal year stored twice. dedupePeriods grouped by its
 * own synonym table, which doesn't know range labels, so a document that
 * prints "2024" in a chart and "FY2024 (Jan - Dec 2024)" in its P&L kept
 * both — two columns for one year, with possibly different numbers.
 */
import { describe, it, expect } from 'vitest';
import { dedupePeriods } from '../src/services/financialPeriodNormalizer.js';

const p = (period: string, lineItems: Record<string, number | null>, confidence = 80) =>
  ({ period, periodType: 'HISTORICAL' as const, lineItems, confidence });

describe('dedupePeriods — canonical period keys', () => {
  it('collapses "2024" and "FY2024 (Jan - Dec 2024)" into one period', () => {
    const out = dedupePeriods([
      p('2024', { revenue: 27.3 }, 70),
      p('FY2024 (Jan - Dec 2024)', { revenue: 27.32, ebitda: 2.21 }, 90),
    ]);
    expect(out).toHaveLength(1);
    // The descriptive label is kept; the higher-confidence values win, gaps are filled.
    expect(out[0].period).toBe('FY2024 (Jan - Dec 2024)');
    expect(out[0].lineItems).toMatchObject({ revenue: 27.32, ebitda: 2.21 });
  });

  it('keeps a 9-month YTD apart from the full year', () => {
    const out = dedupePeriods([
      p('FY2025 (Jan - Dec 2025)', { revenue: 30 }),
      p('2025 YTD (Jan - Sep 2025)', { revenue: 21 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps quarters, LTM and estimates apart from the year', () => {
    const out = dedupePeriods([p('2026', { revenue: 1 }), p('Q1 2026', { revenue: 2 }), p('LTM Mar 2026', { revenue: 3 }), p('2026E', { revenue: 4 })]);
    expect(out).toHaveLength(4);
  });

  it('still folds labels it cannot date by their normalised text', () => {
    const out = dedupePeriods([p('Current', { revenue: 1 }), p('Current', { revenue: 1 })]);
    expect(out).toHaveLength(1);
  });
});
