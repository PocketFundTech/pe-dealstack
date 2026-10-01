import { describe, it, expect } from 'vitest';
import { parsePeriod, comparePeriods, isFullYear } from '@ai-crm/shared';

describe('parsePeriod', () => {
  it.each([
    ['2024', 'FY', 2024, 12, '2024-12-31', '2024'],
    ['FY2023 (Jan - Dec 2023)', 'FY', 2023, 12, '2023-12-31', '2023'],
    ['FY2024 (Jan–Dec 2024)', 'FY', 2024, 12, '2024-12-31', '2024'],
    ['2025 YTD (Jan - Sep 2025)', 'YTD', 2025, 9, '2025-09-30', 'YTD Sep 2025'],
    ['YTD 2026', 'YTD', 2026, null, '2026-12-31', 'YTD 2026'],
    ['FY2025 (Apr 2024 - Mar 2025)', 'FY', 2025, 12, '2025-03-31', '2025'],
    ['FY26', 'FY', 2026, 12, '2026-12-31', '2026'],
    ['2026E', 'EST', 2026, 12, '2026-12-31', '2026E'],
    ['FY26 Est', 'EST', 2026, 12, '2026-12-31', '2026E'],
    ['LTM Sep-25', 'LTM', 2025, 12, '2025-09-30', 'LTM Sep 2025'],
    ['Q1 2026', 'Q', 2026, 3, '2026-03-31', 'Q1 2026'],
    ["Q3'25", 'Q', 2025, 3, '2025-09-30', 'Q3 2025'],
    ['H1 2026', 'H', 2026, 6, '2026-06-30', 'H1 2026'],
    ['Apr 2026', 'M', 2026, 1, '2026-04-30', 'Apr 2026'],
    ['Sep-25', 'M', 2025, 1, '2025-09-30', 'Sep 2025'],
    ['Dec 31, 2024', 'M', 2024, 1, '2024-12-31', 'Dec 2024'],
  ])('%s', (label, kind, fiscalYear, months, endDate, canonicalKey) => {
    expect(parsePeriod(label)).toMatchObject({ label, kind, fiscalYear, months, endDate, canonicalKey });
  });

  it('returns null for labels without a date', () => {
    expect(parsePeriod('Current')).toBeNull();
    expect(parsePeriod('')).toBeNull();
    expect(parsePeriod(null)).toBeNull();
  });

  it('recognises "FY2024 (Jan–Dec 2024)" and "2024" as the same year', () => {
    expect(parsePeriod('FY2024 (Jan–Dec 2024)')!.canonicalKey).toBe(parsePeriod('2024')!.canonicalKey);
  });

  it('isFullYear is true only for 12-month fiscal years', () => {
    expect(isFullYear(parsePeriod('FY2023 (Jan - Dec 2023)'))).toBe(true);
    expect(isFullYear(parsePeriod('2025 YTD (Jan - Sep 2025)'))).toBe(false);
    expect(isFullYear(parsePeriod('2026E'))).toBe(false);
  });
});

describe('comparePeriods', () => {
  it('orders the SRM labels chronologically', () => {
    const labels = ['2025 YTD (Jan - Sep 2025)', 'FY2024 (Jan - Dec 2024)', '2021', 'FY2023 (Jan - Dec 2023)'];
    expect([...labels].sort(comparePeriods)).toEqual([
      '2021', 'FY2023 (Jan - Dec 2023)', 'FY2024 (Jan - Dec 2024)', '2025 YTD (Jan - Sep 2025)',
    ]);
  });

  it('orders months, quarters, YTD, LTM, FY and estimates', () => {
    const labels = ['2026E', 'FY2025', 'Dec 2025', 'Q4 2025', 'LTM Dec 2025', 'Feb 2025', 'Jan 2025', 'Current'];
    expect([...labels].sort(comparePeriods)).toEqual([
      'Jan 2025', 'Feb 2025', 'Dec 2025', 'Q4 2025', 'LTM Dec 2025', 'FY2025', '2026E', 'Current',
    ]);
  });
});
