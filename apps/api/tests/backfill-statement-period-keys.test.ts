/**
 * Backfill for financials-source-period-migration.sql (fix plan A4): fills
 * periodKey / periodKind / periodMonths / periodEndDate on rows stored
 * before the migration, with exactly the values new extractions write.
 */
import { describe, it, expect } from 'vitest';
import { planPeriodKeyBackfill } from '../scripts/backfill-statement-period-keys.js';

describe('planPeriodKeyBackfill', () => {
  it('computes the same canonical period columns the extraction writes', () => {
    const updates = planPeriodKeyBackfill([
      { id: 'a', period: 'FY2024 (Jan - Dec 2024)', periodKey: null },
      { id: 'b', period: '2024', periodKey: null },
      { id: 'c', period: '2025 YTD (Jan - Sep 2025)', periodKey: null },
    ]);
    expect(updates.find((u) => u.id === 'a')).toMatchObject({ periodKey: '2024', periodKind: 'FY', periodMonths: 12 });
    expect(updates.find((u) => u.id === 'b')).toMatchObject({ periodKey: '2024', periodKind: 'FY' });
    expect(updates.find((u) => u.id === 'c')).toMatchObject({ periodKind: 'YTD', periodMonths: 9 });
  });

  it('leaves rows that already have a periodKey alone', () => {
    expect(planPeriodKeyBackfill([{ id: 'a', period: '2024', periodKey: '2024' }])).toEqual([]);
  });
});
