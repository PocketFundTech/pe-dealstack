/**
 * Revenue per employee divides by real headcount. It used to return the
 * plain revenue series under the revenuePerEmployee label, so every company
 * "earned" its whole revenue per employee.
 */
import { describe, it, expect } from 'vitest';
import { analyzeFinancials } from '../src/services/analysis/index.js';

const income = (period: string, lineItems: Record<string, number>) =>
  ({ statementType: 'INCOME_STATEMENT', periodType: 'HISTORICAL', period, lineItems });

describe('workforce metrics', () => {
  it('is revenue ÷ headcount, per period that has both', async () => {
    const r = await analyzeFinancials('w', [
      income('2023', { revenue: 20, employees: 100 }),
      income('2024', { revenue: 27.3, employees: 120 }),
    ]);
    const series = r.workforceMetrics!.revenuePerEmployee;
    expect(series.map((p) => p.value)).toEqual([0.2, 0.2275]);
  });

  it('leaves a period without headcount empty instead of showing revenue', async () => {
    const r = await analyzeFinancials('w', [
      income('2023', { revenue: 20 }),
      income('2024', { revenue: 27.3, employees: 120 }),
    ]);
    expect(r.workforceMetrics!.revenuePerEmployee.map((p) => p.value)).toEqual([null, 0.2275]);
  });

  it('is omitted entirely when no period has headcount', async () => {
    const r = await analyzeFinancials('w', [income('2023', { revenue: 20 }), income('2024', { revenue: 27.3 })]);
    expect(r.workforceMetrics).toBeUndefined();
  });
});
