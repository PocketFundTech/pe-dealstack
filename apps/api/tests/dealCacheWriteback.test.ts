/**
 * Deal Cache Writeback — Unit Tests
 * =================================
 *
 * Coverage for the Phase 2 canonical-cache writeback module
 * (apps/api/src/services/dealCacheWriteback.ts).
 *
 * Tests the pure functions directly (pickLatestForCache,
 * buildCacheRecord, toActualDollars) and exercises the end-to-end
 * refreshDealCache with a mocked Supabase client to verify the
 * fetch → pick → build → write chain.
 *
 * Coverage matrix:
 *   - latest-period selection (HISTORICAL preferred over PROJECTED,
 *     newest year+month wins, fallback to whatever has revenue when
 *     no row has both)
 *   - unitScale → ACTUALS conversion (THOUSANDS, MILLIONS, BILLIONS,
 *     ACTUALS, undefined)
 *   - margin: explicit ebitda_margin_pct preferred when revenue is 0
 *     or missing; computed otherwise
 *   - idempotency: refreshing twice produces an identical cache
 *     record for an unchanged dataset
 *   - clears cache when no income statement exists
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase BEFORE importing the module under test, so the import
// chain picks up the mock. The shared tests/setup.ts mock is too
// generic for this test (it doesn't let us set per-test responses for
// different .from('Deal').update vs .from('FinancialStatement').select
// chains), so we override here.

const fsRowsResponse: { value: { data: unknown[] | null; error: unknown } } = {
  value: { data: [], error: null },
};
const dealUpdateResponse: { value: { data: unknown; error: unknown } } = {
  value: { data: null, error: null },
};
const lastUpdatePayload: { value: unknown } = { value: null };
const lastUpdateDealId: { value: unknown } = { value: null };

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'FinancialStatement') {
        // Build a chain that resolves to fsRowsResponse on the final
        // .eq('isActive', true) call. supabase-js returns the data
        // when you await any thenable in the chain after the filters.
        const chain: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation(function (this: any) {
            return this;
          }),
          then: (onFulfilled: (v: any) => any) => Promise.resolve(fsRowsResponse.value).then(onFulfilled),
        };
        return chain;
      }
      if (table === 'Deal') {
        const chain: any = {
          update: vi.fn().mockImplementation(function (this: any, payload: any) {
            lastUpdatePayload.value = payload;
            return this;
          }),
          eq: vi.fn().mockImplementation(function (this: any, _col: string, value: any) {
            lastUpdateDealId.value = value;
            return this;
          }),
          then: (onFulfilled: (v: any) => any) => Promise.resolve(dealUpdateResponse.value).then(onFulfilled),
        };
        return chain;
      }
      return {};
    }),
  },
}));

import {
  pickLatestForCache,
  buildCacheRecord,
  toActualDollars,
  refreshDealCache,
  type IncomeStatementRow,
} from '../src/services/dealCacheWriteback.js';

beforeEach(() => {
  fsRowsResponse.value = { data: [], error: null };
  dealUpdateResponse.value = { data: null, error: null };
  lastUpdatePayload.value = null;
  lastUpdateDealId.value = null;
});

// ─── toActualDollars ─────────────────────────────────────────────

describe('toActualDollars — unitScale conversion', () => {
  it('THOUSANDS: 21.5 → 21,500 (the headline bug — $21.5K stored as 21.5 with THOUSANDS scale)', () => {
    expect(toActualDollars(21.5, 'THOUSANDS')).toBe(21_500);
  });

  it('MILLIONS: 21.5 → 21,500,000', () => {
    expect(toActualDollars(21.5, 'MILLIONS')).toBe(21_500_000);
  });

  it('BILLIONS: 1.5 → 1,500,000,000', () => {
    expect(toActualDollars(1.5, 'BILLIONS')).toBe(1_500_000_000);
  });

  it('ACTUALS: passes through unchanged', () => {
    expect(toActualDollars(21_500, 'ACTUALS')).toBe(21_500);
  });

  it('null/undefined input → null', () => {
    expect(toActualDollars(null, 'MILLIONS')).toBeNull();
    expect(toActualDollars(undefined, 'MILLIONS')).toBeNull();
  });

  it('NaN input → null (defensive against malformed line items)', () => {
    expect(toActualDollars(Number.NaN, 'MILLIONS')).toBeNull();
  });

  it('null unitScale → defaults to ACTUALS (no multiplication)', () => {
    expect(toActualDollars(21_500, null)).toBe(21_500);
    expect(toActualDollars(21_500, undefined)).toBe(21_500);
  });

  it('negative values convert correctly (loss/deficit rows)', () => {
    expect(toActualDollars(-5, 'MILLIONS')).toBe(-5_000_000);
  });
});

// ─── pickLatestForCache ──────────────────────────────────────────

const baseRow = (overrides: Partial<IncomeStatementRow>): IncomeStatementRow => ({
  period: 'FY25',
  periodType: 'HISTORICAL',
  unitScale: 'MILLIONS',
  currency: 'USD',
  lineItems: { revenue: 100, ebitda: 20 },
  ...overrides,
});

describe('pickLatestForCache — period selection', () => {
  // Note: the chronological comparator (comparePeriodChronologically)
  // currently doesn't extract a year from bare 2-digit FY labels like
  // "FY25" because \b doesn't match between word-chars Y and 2. We use
  // 4-digit annual labels ("2024", "2025") and "FY 2025"-style labels
  // here, which is what the live extraction LLM emits today (after the
  // financialPeriodNormalizer runs). The picker inherits the same
  // ordering rules as the bulk-summaries endpoint by design.

  it('picks the chronologically-latest historical period when multiple have both revenue+ebitda', () => {
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2023' }),
      baseRow({ period: '2025' }),
      baseRow({ period: '2024' }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2025');
  });

  it('prefers HISTORICAL over PROJECTED even when PROJECTED is later', () => {
    // 2026 PROJECTED is "later" by year, but the cache should reflect
    // actuals, not forecasts.
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2025', periodType: 'HISTORICAL' }),
      baseRow({ period: '2026', periodType: 'PROJECTED' }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2025');
  });

  it('falls back to PROJECTED when ALL rows are projected (no actuals exist yet)', () => {
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2026', periodType: 'PROJECTED' }),
      baseRow({ period: '2027', periodType: 'PROJECTED' }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2027');
  });

  it('picks LTM when LTM is the latest historical-class row', () => {
    // periodChronoKey ranks LTM (1.20) below YTD (1.10) within a year;
    // 2024 annual is sub=1.50 in year 2024 vs LTM 2025 sub=1.20 in
    // year 2025 — so LTM 2025 wins on year.
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2024', periodType: 'HISTORICAL' }),
      baseRow({ period: 'LTM 2025', periodType: 'LTM' }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('LTM 2025');
  });

  it('FALLBACK: when NO row has both revenue+ebitda, picks the latest with REVENUE', () => {
    // Neither 2024 nor 2025 has both. With "latest-with-both" empty,
    // the picker falls through to "latest-with-revenue" and 2025 wins.
    // (The picker's preference order — both > revenue-only > ebitda-only
    // — mirrors deals-financial-summaries.ts so the bulk endpoint and
    // the cached column stay in lock-step.)
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2024', lineItems: { revenue: 100, ebitda: null } }),
      baseRow({ period: '2025', lineItems: { revenue: 110, ebitda: null } }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2025');
    expect(picked?.lineItems?.revenue).toBe(110);
  });

  it('PRIORITY: latest-with-BOTH beats a fresher row that has only revenue', () => {
    // Mirrors the picker's first-priority pass: a row with BOTH
    // revenue+ebitda always wins over a fresher row missing one.
    // This guarantees revenue and EBITDA in the cache come from the
    // SAME period (the implied margin always makes sense).
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2024', lineItems: { revenue: 100, ebitda: 20 } }),
      baseRow({ period: '2025', lineItems: { revenue: 110, ebitda: null } }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2024');
    expect(picked?.lineItems?.ebitda).toBe(20);
  });

  it('FALLBACK: when no row has revenue, picks latest with ebitda', () => {
    const rows: IncomeStatementRow[] = [
      baseRow({ period: '2024', lineItems: { revenue: null, ebitda: 18 } }),
      baseRow({ period: '2025', lineItems: { revenue: null, ebitda: 22 } }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('2025');
  });

  it('returns null when given an empty list', () => {
    expect(pickLatestForCache([])).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    // @ts-expect-error — exercising defensive handling
    expect(pickLatestForCache(null)).toBeNull();
  });

  it('picks the latest month when periods are monthly labels', () => {
    const rows: IncomeStatementRow[] = [
      baseRow({ period: 'Jan 2026' }),
      baseRow({ period: 'Mar 2026' }),
      baseRow({ period: 'Feb 2026' }),
    ];
    const picked = pickLatestForCache(rows);
    expect(picked?.period).toBe('Mar 2026');
  });
});

// ─── buildCacheRecord ────────────────────────────────────────────

describe('buildCacheRecord — converts to ACTUAL DOLLARS', () => {
  const NOW = '2026-05-08T00:00:00.000Z';

  it('headline scenario: THOUSANDS-scale 21.5 EBITDA → 21,500 in cache (the original bug)', () => {
    const row: IncomeStatementRow = {
      period: 'Mar 2026',
      periodType: 'HISTORICAL',
      unitScale: 'THOUSANDS',
      currency: 'USD',
      lineItems: { revenue: 100, ebitda: 21.5 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedRevenue).toBe(100_000);
    expect(rec.cachedEbitda).toBe(21_500);
    expect(rec.cachedEbitdaMargin).toBeCloseTo(21.5, 1);
    expect(rec.cachedPeriod).toBe('Mar 2026');
    expect(rec.cachedCurrency).toBe('USD');
    expect(rec.cachedAt).toBe(NOW);
  });

  it('MILLIONS scale: 100M revenue → 100,000,000 in cache', () => {
    const row: IncomeStatementRow = {
      period: 'FY25',
      periodType: 'HISTORICAL',
      unitScale: 'MILLIONS',
      currency: 'USD',
      lineItems: { revenue: 100, ebitda: 20 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedRevenue).toBe(100_000_000);
    expect(rec.cachedEbitda).toBe(20_000_000);
    expect(rec.cachedEbitdaMargin).toBe(20);
  });

  it('null row → all-nulls record (cache cleared)', () => {
    const rec = buildCacheRecord(null, NOW);
    expect(rec.cachedRevenue).toBeNull();
    expect(rec.cachedEbitda).toBeNull();
    expect(rec.cachedEbitdaMargin).toBeNull();
    expect(rec.cachedPeriod).toBeNull();
    expect(rec.cachedCurrency).toBeNull();
    expect(rec.cachedAt).toBe(NOW);
  });

  it('uses explicit ebitda_margin_pct when revenue is missing', () => {
    const row: IncomeStatementRow = {
      period: 'FY25',
      periodType: 'HISTORICAL',
      unitScale: 'MILLIONS',
      currency: 'USD',
      lineItems: { revenue: null, ebitda: 20, ebitda_margin_pct: 18.5 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedEbitdaMargin).toBe(18.5);
  });

  it('uses explicit ebitda_margin_pct when revenue is zero (avoids divide-by-zero)', () => {
    const row: IncomeStatementRow = {
      period: 'FY25',
      periodType: 'HISTORICAL',
      unitScale: 'MILLIONS',
      currency: 'USD',
      lineItems: { revenue: 0, ebitda: 20, ebitda_margin_pct: 25 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedEbitdaMargin).toBe(25);
  });

  it('handles a row with no unitScale tag (defaults to ACTUALS)', () => {
    const row: IncomeStatementRow = {
      period: 'FY25',
      periodType: 'HISTORICAL',
      unitScale: null,
      currency: 'USD',
      lineItems: { revenue: 1_500_000, ebitda: 300_000 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedRevenue).toBe(1_500_000);
    expect(rec.cachedEbitda).toBe(300_000);
  });

  it('preserves currency code from the source row', () => {
    const row: IncomeStatementRow = {
      period: 'FY25',
      periodType: 'HISTORICAL',
      unitScale: 'MILLIONS',
      currency: 'INR',
      lineItems: { revenue: 100, ebitda: 20 },
    };
    const rec = buildCacheRecord(row, NOW);
    expect(rec.cachedCurrency).toBe('INR');
  });
});

// ─── refreshDealCache (integration with mocked supabase) ────────

describe('refreshDealCache — fetch + pick + write chain', () => {
  const NOW = '2026-05-08T00:00:00.000Z';

  it('writes cache columns to the Deal row when income statements exist', async () => {
    fsRowsResponse.value = {
      data: [
        {
          period: 'Mar 2026',
          periodType: 'HISTORICAL',
          unitScale: 'THOUSANDS',
          currency: 'USD',
          lineItems: { revenue: 100, ebitda: 21.5 },
        },
        {
          period: 'Feb 2026',
          periodType: 'HISTORICAL',
          unitScale: 'THOUSANDS',
          currency: 'USD',
          lineItems: { revenue: 95, ebitda: 19 },
        },
      ],
      error: null,
    };

    const result = await refreshDealCache('deal-123', NOW);

    expect(result).not.toBeNull();
    expect(result?.cachedRevenue).toBe(100_000);
    expect(result?.cachedEbitda).toBe(21_500);
    expect(result?.cachedPeriod).toBe('Mar 2026');
    expect(result?.cachedAt).toBe(NOW);

    // Verify the writeback hit the Deal table with the expected payload.
    expect(lastUpdateDealId.value).toBe('deal-123');
    expect(lastUpdatePayload.value).toMatchObject({
      cachedRevenue: 100_000,
      cachedEbitda: 21_500,
      cachedPeriod: 'Mar 2026',
      cachedCurrency: 'USD',
      cachedAt: NOW,
    });
  });

  it('idempotency: two refreshes against the same data produce byte-identical cache records', async () => {
    fsRowsResponse.value = {
      data: [
        {
          period: 'Mar 2026',
          periodType: 'HISTORICAL',
          unitScale: 'THOUSANDS',
          currency: 'USD',
          lineItems: { revenue: 100, ebitda: 21.5 },
        },
      ],
      error: null,
    };

    const a = await refreshDealCache('deal-123', NOW);
    const b = await refreshDealCache('deal-123', NOW);

    expect(a).toEqual(b);
  });

  it('clears the cache (writes nulls) when the deal has no income statements', async () => {
    fsRowsResponse.value = { data: [], error: null };

    const result = await refreshDealCache('deal-no-financials', NOW);

    expect(result?.cachedRevenue).toBeNull();
    expect(result?.cachedEbitda).toBeNull();
    expect(result?.cachedEbitdaMargin).toBeNull();
    expect(result?.cachedPeriod).toBeNull();
    expect(lastUpdatePayload.value).toMatchObject({
      cachedRevenue: null,
      cachedEbitda: null,
      cachedPeriod: null,
    });
  });

  it('returns a null-cache record (rather than throwing) when the fetch errors', async () => {
    fsRowsResponse.value = { data: null, error: { message: 'boom' } };

    const result = await refreshDealCache('deal-broken', NOW);

    // Fetch failed → nothing to pick → cache cleared. We never throw.
    expect(result).not.toBeNull();
    expect(result?.cachedRevenue).toBeNull();
  });
});
