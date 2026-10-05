/**
 * Financial Analysis Helpers
 * Shared utility functions used across all analysis modules.
 */

import { parsePeriod, comparePeriods, isFullYear, inferFiscalYearEndMonth, type CanonicalPeriod } from '@ai-crm/shared';
import { LineItems, PreparedData } from './types.js';

export function li(lineItems: LineItems, key: string): number | null {
  return lineItems[key] ?? null;
}

/**
 * EBITDA as reported, else EBIT + D&A. Safety net for rows extracted before
 * EBITDA derivation reached the Claude path.
 */
export function ebitdaOf(lineItems: LineItems): number | null {
  const e = li(lineItems, 'ebitda');
  if (e != null) return e;
  const ebit = li(lineItems, 'ebit');
  const da = li(lineItems, 'da');
  return ebit != null && da != null ? ebit + da : null;
}

export function pctChange(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/**
 * Growth from `prev` to `cur`, per year: when two fiscal years are more than
 * a year apart (e.g. 2021 → FY2023 with 2022 missing) the change is
 * annualised, so a gap doesn't look like one enormous jump.
 */
export function periodGrowth(
  data: PreparedData,
  prevPeriod: string, curPeriod: string,
  prev: number | null, cur: number | null,
): number | null {
  const a = data.periodInfo.get(prevPeriod);
  const b = data.periodInfo.get(curPeriod);
  const years = a && b && isFullYear(a) && isFullYear(b) ? b.fiscalYear - a.fiscalYear : 1;
  if (years > 1 && prev != null && cur != null && prev > 0 && cur > 0) {
    return (Math.pow(cur / prev, 1 / years) - 1) * 100;
  }
  return pctChange(cur, prev);
}

export function safeDiv(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

export function round2(val: number | null): number | null {
  if (val == null) return null;
  return Math.round(val * 100) / 100;
}

export function avg(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function trendDirection(values: (number | null)[]): 'improving' | 'declining' | 'stable' | 'insufficient' {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length < 2) return 'insufficient';

  const mid = Math.floor(valid.length / 2);
  const firstHalf = avg(valid.slice(0, mid));
  const secondHalf = avg(valid.slice(mid));

  if (firstHalf == null || secondHalf == null) return 'insufficient';
  const change = ((secondHalf - firstHalf) / Math.abs(firstHalf)) * 100;

  if (Math.abs(change) < 3) return 'stable';
  return change > 0 ? 'improving' : 'declining';
}

function numericCount(items: LineItems): number {
  return Object.values(items).filter(v => typeof v === 'number').length;
}

/** Fill gaps in the richer row from the poorer one — never overwrite a value. */
function mergeLineItems(a: LineItems, b: LineItems): LineItems {
  const [base, extra] = numericCount(a) >= numericCount(b) ? [a, b] : [b, a];
  const out: LineItems = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (out[k] == null && v != null) out[k] = v;
  }
  return out;
}

/**
 * Group historical rows by canonical period (so "FY2024 (Jan–Dec 2024)" and
 * "2024" are one year) and order them chronologically. Plain string sorting
 * put FY2023 after "2025 YTD", which produced false declines and wrong CAGRs.
 */
const currencyOf = (r: { currency?: string | null }) => (r.currency || 'USD').toUpperCase();

/**
 * One currency for the analysis (fix plan G10). Figures are never
 * converted, so statements in another currency are left out rather than
 * added to the main series. Main currency = the one with the most
 * historical income-statement rows (all rows when there are none); USD,
 * then alphabetical, breaks a tie.
 */
export function pickAnalysisCurrency(rows: any[]): { currency: string; rows: any[]; note?: string } {
  const all = new Set(rows.map(currencyOf));
  if (all.size <= 1) return { currency: [...all][0] ?? 'USD', rows };

  const pl = rows.filter(r => r.statementType === 'INCOME_STATEMENT' && r.periodType === 'HISTORICAL');
  const counts = new Map<string, number>();
  for (const r of pl.length ? pl : rows) counts.set(currencyOf(r), (counts.get(currencyOf(r)) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || (a[0] === 'USD' ? -1 : b[0] === 'USD' ? 1 : a[0].localeCompare(b[0])))[0][0];

  const kept = rows.filter(r => currencyOf(r) === currency);
  const others = [...all].filter(c => c !== currency).sort();
  const left = rows.length - kept.length;
  const note =
    `This deal's statements are in ${[currency, ...others].join(' and ')}. Figures are not converted between currencies, ` +
    `so this analysis uses the ${currency} statements only and leaves out ${left} ${others.join('/')} statement period${left === 1 ? '' : 's'}.`;
  return { currency, rows: kept, note };
}

export function prepareData(rows: any[]): PreparedData {
  const income = new Map<string, LineItems>();
  const balance = new Map<string, LineItems>();
  const cashflow = new Map<string, LineItems>();
  const periodInfo = new Map<string, CanonicalPeriod>();

  const historical = rows.filter(r => r.periodType === 'HISTORICAL');
  // A June year-end company's bare "FY2025" ends in June, not December (G13).
  const fiscalYearEndMonth = inferFiscalYearEndMonth(historical.map(r => r.period));
  const parsed = historical.map(r => ({ row: r, period: parsePeriod(r.period, { fiscalYearEndMonth }) }));

  // A balance sheet dated at a fiscal year-end ("Dec 31, 2024") belongs to
  // that fiscal year's column.
  const fyByEndDate = new Map<string, CanonicalPeriod>();
  for (const { period } of parsed) {
    if (isFullYear(period)) fyByEndDate.set(period!.endDate, period!);
  }

  for (const { row, period } of parsed) {
    const map =
      row.statementType === 'INCOME_STATEMENT' ? income :
      row.statementType === 'BALANCE_SHEET' ? balance :
      row.statementType === 'CASH_FLOW' ? cashflow : null;
    if (!map) continue;

    let canon = period;
    if (canon && canon.kind === 'M' && row.statementType === 'BALANCE_SHEET') {
      canon = fyByEndDate.get(canon.endDate) ?? canon;
    }
    const key = canon?.canonicalKey ?? String(row.period);
    if (canon && !periodInfo.has(key)) periodInfo.set(key, canon);

    const items = (row.lineItems ?? {}) as LineItems;
    const existing = map.get(key);
    map.set(key, existing ? mergeLineItems(existing, items) : items);
  }

  const allPeriods = new Set<string>();
  [income, balance, cashflow].forEach(m => m.forEach((_, k) => allPeriods.add(k)));
  const periods = Array.from(allPeriods).sort((a, b) =>
    comparePeriods(periodInfo.get(a) ?? a, periodInfo.get(b) ?? b));
  const annualPeriods = periods.filter(p => isFullYear(periodInfo.get(p)));

  return { income, balance, cashflow, periods, annualPeriods, periodInfo };
}

/**
 * The periods that can be compared with each other for growth and trends:
 * full fiscal years when there are at least two, otherwise the largest group
 * of same-length periods (e.g. a monthly P&L). Never mixes a YTD with a year.
 */
export function comparablePeriods(
  data: PreparedData,
  statement?: 'income' | 'balance' | 'cashflow',
): string[] {
  // Restricting to one statement stops e.g. a balance-sheet-only "2025" from
  // a valuation file showing up as an empty year in the revenue series.
  const has = (p: string) => !statement || data[statement].has(p);
  const annual = data.annualPeriods.filter(has);
  if (annual.length >= 2) return annual;
  const groups = new Map<string, string[]>();
  for (const p of data.periods.filter(has)) {
    const info = data.periodInfo.get(p);
    if (!info || info.kind === 'EST') continue;
    const g = `${info.kind}:${info.months ?? '?'}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  let best: string[] = annual;
  for (const g of groups.values()) if (g.length > best.length) best = g;
  return best;
}

/**
 * trendDirection over comparable periods only, so a partial YTD or an
 * estimate at the end of the series can't flip the arrow.
 */
export function comparableTrend(
  data: PreparedData,
  series: { period: string; value: number | null }[],
): ReturnType<typeof trendDirection> {
  const keep = new Set(comparablePeriods(data));
  return trendDirection(series.filter(x => keep.has(x.period)).map(x => x.value));
}
