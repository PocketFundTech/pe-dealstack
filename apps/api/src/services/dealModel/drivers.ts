// ─── Deal model — per-line drivers (fix plan E1) ──────────────────
// Each input line of the catalogue gets a driver: GROWTH, PCT_REVENUE or
// FIXED, one value per projected year. Subtotals, sums of accounts and the
// linked lines (interest, tax) are SUBTOTAL — formulas, never inputs.
//
// Seeding (deriveDefaults) uses FULL fiscal years only — a 9-month YTD is
// not a year — falling back to every period only when no label can be
// dated as a full year:
//   revenue lines   GROWTH = revenue CAGR over the real span, clamped −15..30
//   operating costs PCT_REVENUE = average of (line / revenue)
//   D&A             PCT_REVENUE = average (3% when never reported)
//   other inc / exp FIXED = average amount
//
// Backward compatibility: DealModel rows saved before E1 carry
// `revenueGrowthPct` / `ebitdaMarginPct` / `daPctRevenue` and no
// `lineDrivers`. resolveLineDrivers migrates them in code:
//   - every revenue line → GROWTH at the saved growth;
//   - operating cost lines → PCT_REVENUE, splitting (100 − saved margin)
//     across the lines in proportion to their historical shares, so the
//     projected EBITDA margin equals the saved margin exactly;
//   - D&A → PCT_REVENUE at the saved daPctRevenue.

import type { LineDriver, ModelLine } from '@ai-crm/shared';
import { allowedMethods } from '@ai-crm/shared';
import type { HistoricalRow } from './assumptions.js';
import { isFullYearRow, withPeriodMeta } from './basePeriod.js';
import type { LineCatalogue } from './lineCatalogue.js';

export const DEFAULT_EBITDA_MARGIN = 15;
export const DEFAULT_DA_PCT = 3;
const MAX_SEEDED_GROWTH = 30;
const MIN_SEEDED_GROWTH = -15;

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function cagrPct(first: number, last: number, years: number): number | null {
  if (first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

/** Indices of the periods drivers are seeded from: full years with revenue, else all with revenue. */
export function seedPeriodIndices(history: HistoricalRow[], cat: LineCatalogue): number[] {
  const withRev = cat.periods.map((p, i) => i).filter((i) => (cat.periods[i].values.revenue ?? 0) > 0);
  const full = withRev.filter((i) => isFullYearRow(history[i]));
  return full.length ? full : withRev;
}

// A year-on-year jump above this is a step change (an acquisition, a
// re-basing), not a growth rate to project forward.
const STEP_CHANGE_GROWTH = 100;

interface GrowthSeed { growthPct: number; stepChanges: Array<{ period: string; growthPct: number }> }

/**
 * Revenue growth seed — compound annual growth over the real span of years,
 * leaving out step-change years, clamped. CSP's 2025 (+284% on an
 * acquisition) made the plain 2022→2025 CAGR 59% (capped at 30%): Base 51%
 * IRR against ~15% in the buyer's own LBO (15 Oct 2026).
 */
export function seedRevenueGrowthDetail(history: HistoricalRow[], cat: LineCatalogue): GrowthSeed {
  const idx = seedPeriodIndices(history, cat);
  const full = idx.every((i) => isFullYearRow(history[i])) && idx.length > 0;
  if (idx.length < 2) return { growthPct: 5, stepChanges: [] };
  const fy = (i: number) => withPeriodMeta(history[i]).fiscalYear ?? null;
  const rev = (i: number) => cat.periods[i].values.revenue;
  let logSum = 0;
  let years = 0;
  const stepChanges: GrowthSeed['stepChanges'] = [];
  for (let k = 1; k < idx.length; k++) {
    const a = idx[k - 1];
    const b = idx[k];
    const span = full && fy(a) !== null && fy(b) !== null ? fy(b)! - fy(a)! : 1;
    if (span <= 0 || rev(a) <= 0 || rev(b) <= 0) continue;
    const annual = (Math.pow(rev(b) / rev(a), 1 / span) - 1) * 100;
    if (annual > STEP_CHANGE_GROWTH) {
      stepChanges.push({ period: history[b].period, growthPct: round(annual, 1) });
      continue;
    }
    logSum += Math.log(rev(b) / rev(a));
    years += span;
  }
  const derived = years > 0 ? (Math.exp(logSum / years) - 1) * 100 : null;
  const growthPct = derived === null ? 5 : Math.max(MIN_SEEDED_GROWTH, Math.min(MAX_SEEDED_GROWTH, derived));
  return { growthPct, stepChanges };
}

export function seedRevenueGrowth(history: HistoricalRow[], cat: LineCatalogue): number {
  return seedRevenueGrowthDetail(history, cat).growthPct;
}

/** The model note when a step-change year was left out of the growth seed. */
export function growthSeedNote(history: HistoricalRow[], cat: LineCatalogue): string | null {
  const { growthPct, stepChanges } = seedRevenueGrowthDetail(history, cat);
  if (stepChanges.length === 0) return null;
  const jumps = stepChanges.map((s) => `${s.period} (+${s.growthPct.toFixed(0)}%)`).join(', ');
  return (
    `Revenue growth is seeded at ${growthPct.toFixed(1)}% a year from the other years: ${jumps} is treated as a step change ` +
    `(e.g. an acquisition), not a growth rate to project forward. Edit the growth on each case if you expect it to continue.`
  );
}

export function inputLines(lines: ModelLine[]): ModelLine[] {
  return lines.filter((l) => l.kind === 'INPUT' && !l.historicalOnly);
}

/** Starting drivers for every line of the catalogue. */
export function seedLineDrivers(
  history: HistoricalRow[],
  cat: LineCatalogue,
  years: number,
): Record<string, LineDriver> {
  const idx = seedPeriodIndices(history, cat);
  const growth = round(seedRevenueGrowth(history, cat), 1);
  const series = (v: number) => Array.from({ length: years }, () => v);
  const avgPct = (key: string) => avg(idx
    .map((i) => cat.periods[i].values)
    .filter((v) => v[key] !== undefined && v.revenue)
    .map((v) => (v[key] / v.revenue) * 100));

  const drivers: Record<string, LineDriver> = {};
  for (const line of cat.lines) {
    if (line.kind !== 'INPUT' || line.historicalOnly) {
      drivers[line.key] = { method: 'SUBTOTAL', values: [] };
    } else if (line.revenueLine) {
      drivers[line.key] = { method: 'GROWTH', values: series(growth) };
    } else if (line.costLine || line.key === 'da' || line.parent === 'da') {
      const fallback = line.key === 'da' ? DEFAULT_DA_PCT : 0;
      drivers[line.key] = { method: 'PCT_REVENUE', values: series(round(avgPct(line.key) ?? fallback, 2)) };
    } else {
      const amounts = idx.map((i) => cat.periods[i].values[line.key]).filter((v): v is number => v !== undefined);
      drivers[line.key] = { method: 'FIXED', values: series(round(avg(amounts) ?? 0, 3)) };
    }
  }

  // No operating-cost history at all: hold a default margin rather than
  // projecting EBITDA = revenue.
  const costs = inputLines(cat.lines).filter((l) => l.costLine);
  if (costs.length && costs.every((l) => drivers[l.key].values.every((v) => v === 0))) {
    drivers[costs[0].key] = { method: 'PCT_REVENUE', values: series(100 - DEFAULT_EBITDA_MARGIN) };
  }
  return drivers;
}

/** Fit a series to `years` entries (pad with the last value, or truncate). */
function fit(values: number[], years: number): number[] {
  if (values.length === years) return values;
  const last = values.at(-1) ?? 0;
  return Array.from({ length: years }, (_, i) => values[i] ?? last);
}

export interface LegacyFields {
  revenueGrowthPct?: number[];
  ebitdaMarginPct?: number[];
  daPctRevenue?: number;
}

/** Pre-E1 growth / margin → per-line drivers (see header). */
export function migrateLegacyDrivers(
  legacy: LegacyFields,
  lines: ModelLine[],
  seeded: Record<string, LineDriver>,
  years: number,
): Record<string, LineDriver> {
  const out: Record<string, LineDriver> = { ...seeded };
  const inputs = inputLines(lines);
  if (legacy.revenueGrowthPct?.length) {
    for (const l of inputs.filter((x) => x.revenueLine)) {
      out[l.key] = { method: 'GROWTH', values: fit(legacy.revenueGrowthPct, years) };
    }
  }
  if (legacy.ebitdaMarginPct?.length) {
    const margins = fit(legacy.ebitdaMarginPct, years);
    const costs = inputs.filter((l) => l.costLine);
    const share = costs.map((l) => (seeded[l.key]?.method === 'PCT_REVENUE' ? Math.max(0, seeded[l.key].values[0] ?? 0) : 0));
    const total = share.reduce((a, b) => a + b, 0);
    costs.forEach((l, i) => {
      const weight = total > 0 ? share[i] / total : i === 0 ? 1 : 0;
      out[l.key] = { method: 'PCT_REVENUE', values: margins.map((m) => round((100 - m) * weight, 4)) };
    });
  }
  if (typeof legacy.daPctRevenue === 'number' && inputs.some((l) => l.key === 'da')) {
    out.da = { method: 'PCT_REVENUE', values: fit([legacy.daPctRevenue], years) };
  }
  return out;
}

/**
 * Full driver set for the catalogue: saved drivers where they fit the line
 * (allowed method, right length), otherwise migrated legacy fields, otherwise
 * the seed. Lines that left the catalogue (re-extraction) are dropped.
 */
export function resolveLineDrivers(
  saved: Record<string, LineDriver> | undefined,
  legacy: LegacyFields,
  lines: ModelLine[],
  seeded: Record<string, LineDriver>,
  years: number,
): Record<string, LineDriver> {
  const fallback = saved ? seeded : migrateLegacyDrivers(legacy, lines, seeded, years);
  const out: Record<string, LineDriver> = {};
  for (const line of lines) {
    const allowed = allowedMethods(line);
    if (allowed[0] === 'SUBTOTAL' || line.historicalOnly) { out[line.key] = { method: 'SUBTOTAL', values: [] }; continue; }
    const d = saved?.[line.key];
    out[line.key] = d && allowed.includes(d.method) && d.values.length > 0
      ? { method: d.method, values: fit(d.values, years) }
      : { method: fallback[line.key]?.method ?? allowed[0], values: fit(fallback[line.key]?.values ?? [0], years) };
  }
  return out;
}
