// Deal canonical-cache writeback.
//
// Phase 2 of the unitScale fix. The legacy Deal.revenue / Deal.ebitda
// columns carry no unit tag, so consumers (memos, AI chat, ingest
// loggers) that read them assume MILLIONS and silently mis-render
// THOUSANDS-scale data as MILLIONS. This module computes a canonical
// "latest period" cache in ACTUAL DOLLARS from the FinancialStatement
// rows the extraction pipeline just wrote, and pushes it into the new
// Deal.cached* columns added by deal-cache-migration.sql.
//
// Canonical scale = ACTUALS. We convert unitScale → ACTUALS at write
// time so downstream consumers don't have to track a per-row unit field
// (that was the original mess: scale stored as a sibling column,
// renderers forgot to read it).
//
// The picking logic mirrors apps/api/src/routes/deals-financial-summaries.ts
// (see the historical/projected fallback chain there) so /deals (which
// uses the bulk summaries endpoint) and any future consumer of
// deal.cachedRevenue see byte-identical numbers. If you change the
// picking rules in one place, change them in both.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { comparePeriodChronologically } from '../utils/periodChrono.js';

// ─── Types ────────────────────────────────────────────────────

export type UnitScale = 'MILLIONS' | 'THOUSANDS' | 'ACTUALS' | 'BILLIONS';

/** Mirrors UNIT_SCALE_MULTIPLIER in apps/web-next/src/lib/formatters.ts. */
export const UNIT_SCALE_MULTIPLIER: Record<UnitScale, number> = {
  ACTUALS: 1,
  THOUSANDS: 1_000,
  MILLIONS: 1_000_000,
  BILLIONS: 1_000_000_000,
};

/**
 * Convert a stored value at the given `unitScale` into actual dollars.
 * Returns `null` for null/undefined/non-finite inputs so callers don't
 * have to re-validate before persisting.
 */
export function toActualDollars(
  value: number | null | undefined,
  unitScale: UnitScale | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const mult = UNIT_SCALE_MULTIPLIER[unitScale ?? 'ACTUALS'] ?? 1;
  return n * mult;
}

export interface IncomeStatementRow {
  period: string | null;
  periodType: string | null;
  unitScale: UnitScale | null;
  currency: string | null;
  lineItems: Record<string, number | null> | null;
}

/**
 * The shape we write back to the Deal row. All numeric fields are in
 * ACTUAL DOLLARS so consumers don't need to know about unitScale.
 */
export interface DealCacheRecord {
  cachedRevenue: number | null;
  cachedEbitda: number | null;
  cachedEbitdaMargin: number | null;
  cachedPeriod: string | null;
  cachedCurrency: string | null;
  cachedAt: string;
}

// ─── Picking logic ────────────────────────────────────────────

/**
 * Pick the chronologically-latest period that carries the headline
 * numbers, with progressive fallbacks. Mirrors the picker in
 * routes/deals-financial-summaries.ts so the bulk endpoint and the
 * cached column stay in lock-step.
 *
 * Order of preference:
 *   1. latest historical/actual/LTM row that has BOTH revenue and ebitda
 *   2. latest historical/actual/LTM row with revenue (ebitda may be null)
 *   3. latest historical/actual/LTM row with ebitda (revenue may be null)
 *   4. latest historical/actual/LTM row regardless of line items
 *   5. fall through to ANY active row (including projected) under the
 *      same chain
 *
 * Returns null when there are no candidates at all.
 */
export function pickLatestForCache(
  rows: IncomeStatementRow[],
): IncomeStatementRow | null {
  if (!rows || rows.length === 0) return null;

  const historical = rows.filter(
    (r) =>
      r.periodType === 'HISTORICAL' ||
      r.periodType === 'ACTUAL' ||
      r.periodType === 'LTM',
  );
  const candidates = historical.length > 0 ? historical : rows;

  // comparePeriodChronologically sorts ASC; reverse to get newest-first.
  const sortedDesc = [...candidates].sort((a, b) =>
    comparePeriodChronologically(b.period, a.period),
  );

  const latestWithBoth = sortedDesc.find(
    (r) => r.lineItems?.revenue != null && r.lineItems?.ebitda != null,
  );
  if (latestWithBoth) return latestWithBoth;

  const latestWithRevenue = sortedDesc.find(
    (r) => r.lineItems?.revenue != null,
  );
  if (latestWithRevenue) return latestWithRevenue;

  const latestWithEbitda = sortedDesc.find(
    (r) => r.lineItems?.ebitda != null,
  );
  if (latestWithEbitda) return latestWithEbitda;

  return sortedDesc[0] ?? null;
}

// ─── Cache record construction ────────────────────────────────

/**
 * Build a DealCacheRecord from the picked income-statement row.
 *
 * All currency-bearing fields are converted to ACTUAL DOLLARS using the
 * row's unitScale. Margin is preferred from the explicit
 * `ebitda_margin_pct` line item; otherwise computed from
 * revenue / ebitda (both at the same scale, so the ratio is
 * scale-free).
 *
 * `nowIso` is a parameter (rather than a fresh Date.now()) so callers
 * that update many deals in one extraction batch can use the same
 * timestamp — and so tests can pass a deterministic value.
 */
export function buildCacheRecord(
  row: IncomeStatementRow | null,
  nowIso: string,
): DealCacheRecord {
  if (!row) {
    return {
      cachedRevenue: null,
      cachedEbitda: null,
      cachedEbitdaMargin: null,
      cachedPeriod: null,
      cachedCurrency: null,
      cachedAt: nowIso,
    };
  }

  const li = row.lineItems ?? {};
  const unitScale = row.unitScale ?? 'ACTUALS';
  const cachedRevenue = toActualDollars(li.revenue ?? null, unitScale);
  const cachedEbitda = toActualDollars(li.ebitda ?? null, unitScale);

  let cachedEbitdaMargin: number | null = null;
  // Margin is scale-free, so compute from the raw (un-converted) line
  // items. Prefer the explicit pct field when present.
  const rev = li.revenue;
  const ebd = li.ebitda;
  if (
    rev != null &&
    ebd != null &&
    Number.isFinite(rev) &&
    Number.isFinite(ebd) &&
    rev !== 0
  ) {
    cachedEbitdaMargin = parseFloat(((ebd / rev) * 100).toFixed(1));
  } else if (li.ebitda_margin_pct != null && Number.isFinite(li.ebitda_margin_pct)) {
    cachedEbitdaMargin = li.ebitda_margin_pct;
  }

  return {
    cachedRevenue,
    cachedEbitda,
    cachedEbitdaMargin,
    cachedPeriod: row.period ?? null,
    cachedCurrency: row.currency ?? null,
    cachedAt: nowIso,
  };
}

// ─── DB read + write ──────────────────────────────────────────

/**
 * Pull every active income-statement row for the deal and pick the
 * canonical one. Returns null when the deal has no income statements
 * (in which case the caller should clear the cache, not throw).
 */
export async function fetchLatestIncomeStatement(
  dealId: string,
): Promise<IncomeStatementRow | null> {
  const { data: rows, error } = await supabase
    .from('FinancialStatement')
    .select('period, periodType, unitScale, currency, lineItems')
    .eq('dealId', dealId)
    .eq('statementType', 'INCOME_STATEMENT')
    .eq('isActive', true);

  if (error) {
    log.error('dealCacheWriteback: fetch failed', { dealId, error });
    return null;
  }

  return pickLatestForCache((rows as IncomeStatementRow[] | null) ?? []);
}

/**
 * Write the cache record to the Deal row. Always sets every cached*
 * column (no partial updates) so the row is internally consistent —
 * cachedRevenue and cachedEbitda always reflect the SAME period and
 * the SAME unit conversion.
 *
 * Idempotent: calling this with an unchanged latest period results in
 * the same write each time. We don't try to skip when nothing changed
 * (cheaper to UPDATE than to SELECT-then-compare for a 6-column row).
 */
export async function writeDealCache(
  dealId: string,
  record: DealCacheRecord,
): Promise<void> {
  const { error } = await supabase
    .from('Deal')
    .update(record)
    .eq('id', dealId);

  if (error) {
    log.error('dealCacheWriteback: update failed', { dealId, error });
  }
}

/**
 * End-to-end: pull latest income statement → build cache record →
 * write to Deal. Used by both the live extraction path (called from
 * runDeepPass) and the backfill script.
 *
 * Failures are logged and swallowed — the cache is a best-effort
 * derived view; we never want a cache writeback failure to bubble up
 * and fail an extraction the user just kicked off.
 */
export async function refreshDealCache(
  dealId: string,
  nowIso: string = new Date().toISOString(),
): Promise<DealCacheRecord | null> {
  try {
    const row = await fetchLatestIncomeStatement(dealId);
    const record = buildCacheRecord(row, nowIso);
    await writeDealCache(dealId, record);
    log.info('dealCacheWriteback: refreshed', {
      dealId,
      cachedPeriod: record.cachedPeriod,
      cachedRevenue: record.cachedRevenue,
      cachedEbitda: record.cachedEbitda,
    });
    return record;
  } catch (err) {
    log.error('dealCacheWriteback: refreshDealCache failed', { dealId, err });
    return null;
  }
}
