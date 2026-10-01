// ─── Deal model — balance sheet and cash flow inputs (fix plan E3) ─
// normaliseStatements used to throw the balance sheet and cash flow away.
// They now feed the model's working capital, capex and opening net debt:
//
//   balance sheet  AR, inventory, AP, PP&E, cash, short- / long-term debt
//                  (total_debt when printed — #163 gave it its own key)
//   cash flow      capex, summing split lines (growth_capex,
//                  maintenance_capex, replacement_capex_capitalized, …).
//                  Outflows are stored ≤ 0 since #163; magnitudes are used.
//
// Seeding uses FULL fiscal years only — a 9-month YTD revenue against a
// period-end receivable would overstate DSO by a third:
//   DSO = AR / revenue × 365, DIO = inventory / COGS × 365,
//   DPO = AP / COGS × 365 (averaged). With no receivables, or inventory /
//   payables but no COGS line, working capital falls back to % of revenue:
//   (AR + inventory − AP) / revenue when any of them exists, else 10% (the
//   pre-E3 default).
//   Capex % = |capex| / revenue (averaged), else 3%. Maintenance / growth
//   split when both were reported in a year.
// Every series is seeded whichever method is active, so switching method
// in the panel starts from history rather than zeros.

import {
  BALANCE_SERIES_KEYS, DAYS_IN_YEAR, DEFAULT_CAPEX_PCT, DEFAULT_NWC_PCT,
  type BalanceDrivers, type OpeningBalances,
} from '@ai-crm/shared';
import type { HistoricalRow } from './assumptions.js';
import { isFullYearRow } from './basePeriod.js';
import type { LineCatalogue } from './lineCatalogue.js';

export interface BalanceItems {
  ar?: number;
  inventory?: number;
  ap?: number;
  ppe?: number;
  cash?: number;
  stDebt?: number;
  ltDebt?: number;
  /** total_debt, else short- + long-term debt. */
  debt?: number;
  /** Capex magnitudes (≥ 0): total, and the split when reported. */
  capex?: number;
  capexMaintenance?: number;
  capexGrowth?: number;
}

type Scaled = (v: unknown) => number | undefined;

const first = (li: Record<string, unknown>, scaled: Scaled, keys: string[]) => {
  for (const k of keys) {
    const v = scaled(li[k]);
    if (v !== undefined) return v;
  }
  return undefined;
};

const CAPEX_PART_RE = /(^|_)capex(_|$)|capital_expenditures?|purchases?_of_(property|equipment|ppe|fixed_assets)/;
const GROWTH_RE = /growth|expansion/;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The items the model reads from one balance sheet or cash flow statement. */
export function readBalanceItems(statementType: string, li: Record<string, unknown>, scaled: Scaled): BalanceItems {
  const out: BalanceItems = {};
  const set = (k: keyof BalanceItems, v: number | undefined) => { if (v !== undefined) out[k] = v; };
  if (statementType === 'BALANCE_SHEET') {
    set('ar', first(li, scaled, ['accounts_receivable', 'trade_receivables', 'receivables']));
    set('inventory', first(li, scaled, ['inventory', 'inventories']));
    set('ap', first(li, scaled, ['accounts_payable', 'trade_payables', 'payables']));
    set('ppe', first(li, scaled, ['ppe_net', 'ppe', 'net_ppe', 'property_plant_equipment']));
    set('cash', first(li, scaled, ['cash', 'cash_and_equivalents', 'cash_and_cash_equivalents']));
    set('stDebt', first(li, scaled, ['short_term_debt']));
    set('ltDebt', first(li, scaled, ['long_term_debt']));
    const total = first(li, scaled, ['total_debt']);
    set('debt', total ?? (out.stDebt !== undefined || out.ltDebt !== undefined ? r3((out.stDebt ?? 0) + (out.ltDebt ?? 0)) : undefined));
  } else if (statementType === 'CASH_FLOW') {
    const parts = Object.keys(li)
      .filter((k) => k !== 'capex' && !/_(source|pct|label|order)$/.test(k) && CAPEX_PART_RE.test(k))
      .map((k) => [k, scaled(li[k])] as const)
      .filter((e): e is readonly [string, number] => e[1] !== undefined);
    const printed = scaled(li.capex);
    const partsTotal = parts.reduce((t, [, v]) => t + Math.abs(v), 0);
    if (printed !== undefined) out.capex = Math.abs(printed);
    else if (parts.length) out.capex = r3(partsTotal);
    const growth = parts.filter(([k]) => GROWTH_RE.test(k)).reduce((t, [, v]) => t + Math.abs(v), 0);
    if (growth > 0 && out.capex !== undefined && out.capex - growth > 0.0005) {
      out.capexGrowth = r3(growth);
      out.capexMaintenance = r3(out.capex - growth);
    }
  }
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const series = (years: number, v: number) => Array.from({ length: years }, () => v);

/** Full fiscal years with revenue and balance data (all such periods when none is a full year — capex only). */
function periodsWithBalance(history: HistoricalRow[], cat: LineCatalogue, fullOnly: boolean): number[] {
  const all = history.map((_, i) => i)
    .filter((i) => history[i].balance && (cat.periods[i]?.values.revenue ?? 0) > 0);
  const full = all.filter((i) => isFullYearRow(history[i]));
  return full.length || fullOnly ? full : all;
}

export function seedBalanceDrivers(history: HistoricalRow[], cat: LineCatalogue, years: number): BalanceDrivers {
  const wcIdx = periodsWithBalance(history, cat, true);
  const rev = (i: number) => cat.periods[i].values.revenue;
  const cogs = (i: number) => cat.periods[i].values.cogs ?? 0;
  const bal = (i: number) => history[i].balance!;
  const days = (item: 'ar' | 'inventory' | 'ap', denom: (i: number) => number) => avg(wcIdx
    .filter((i) => bal(i)[item] !== undefined && denom(i) > 0)
    .map((i) => (bal(i)[item]! / denom(i)) * DAYS_IN_YEAR));
  const seen = (item: 'ar' | 'inventory' | 'ap') => wcIdx.some((i) => bal(i)[item] !== undefined);

  const dso = days('ar', rev);
  const dio = days('inventory', cogs);
  const dpo = days('ap', cogs);
  const hasCogsLine = cat.lines.some((l) => l.key === 'cogs');
  const daysOk = dso !== null && hasCogsLine && (!seen('inventory') || dio !== null) && (!seen('ap') || dpo !== null);
  const nwcPct = avg(wcIdx
    .filter((i) => (['ar', 'inventory', 'ap'] as const).some((k) => bal(i)[k] !== undefined))
    .map((i) => (((bal(i).ar ?? 0) + (bal(i).inventory ?? 0) - (bal(i).ap ?? 0)) / rev(i)) * 100));

  const capexIdx = periodsWithBalance(history, cat, false).filter((i) => bal(i).capex !== undefined);
  const capexPct = avg(capexIdx.map((i) => (bal(i).capex! / rev(i)) * 100));
  const splitIdx = capexIdx.filter((i) => bal(i).capexGrowth !== undefined);
  const maintPct = avg(splitIdx.map((i) => (bal(i).capexMaintenance! / rev(i)) * 100));
  const growthPct = avg(splitIdx.map((i) => (bal(i).capexGrowth! / rev(i)) * 100));

  return {
    nwcMethod: daysOk ? 'DAYS' : 'PCT_REVENUE',
    dso: series(years, round(dso ?? 0, 1)),
    dio: series(years, round(dio ?? 0, 1)),
    dpo: series(years, round(dpo ?? 0, 1)),
    nwcPct: series(years, round(nwcPct ?? DEFAULT_NWC_PCT, 2)),
    capexMethod: splitIdx.length ? 'SPLIT' : 'TOTAL',
    capexPct: series(years, round(capexPct ?? DEFAULT_CAPEX_PCT, 2)),
    capexMaintPct: series(years, round(maintPct ?? 0, 2)),
    capexGrowthPct: series(years, round(growthPct ?? 0, 2)),
  };
}

/** Latest full-year balance sheet (else the latest one) — DAYS base balances and the net debt refinanced at entry. */
export function openingBalances(history: HistoricalRow[]): OpeningBalances {
  const has = (r: HistoricalRow) => !!r.balance && ['ar', 'inventory', 'ap', 'cash', 'debt'].some((k) => r.balance![k as keyof BalanceItems] !== undefined);
  const withBs = history.filter(has);
  const row = withBs.filter(isFullYearRow).at(-1) ?? withBs.at(-1);
  if (!row) return {};
  const b = row.balance!;
  const out: OpeningBalances = { period: row.period };
  for (const k of ['ar', 'inventory', 'ap', 'cash', 'debt'] as const) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** Pad with the last value, or truncate, to `years` entries. */
function fit(values: number[] | undefined, years: number, fallback: number[]): number[] {
  const src = values?.length ? values : fallback;
  const last = src.at(-1) ?? 0;
  return Array.from({ length: years }, (_, i) => src[i] ?? last);
}

/**
 * Saved drivers over the seed. Rows saved before E3 have no balanceDrivers
 * but carry scalar nwcPctRevenue / capexPctRevenue: they become % of revenue
 * series at the same value, so the model's cash flows are unchanged.
 */
export function resolveBalanceDrivers(
  saved: Partial<BalanceDrivers> | undefined,
  legacy: { nwcPctRevenue?: number; capexPctRevenue?: number },
  seeded: BalanceDrivers,
  years: number,
): BalanceDrivers {
  const out = { ...seeded };
  for (const k of BALANCE_SERIES_KEYS) out[k] = fit(saved?.[k], years, seeded[k]);
  if (saved) {
    if (saved.nwcMethod === 'DAYS' || saved.nwcMethod === 'PCT_REVENUE') out.nwcMethod = saved.nwcMethod;
    if (saved.capexMethod === 'TOTAL' || saved.capexMethod === 'SPLIT') out.capexMethod = saved.capexMethod;
    return out;
  }
  if (typeof legacy.nwcPctRevenue === 'number') {
    out.nwcMethod = 'PCT_REVENUE';
    out.nwcPct = series(years, legacy.nwcPctRevenue);
  }
  if (typeof legacy.capexPctRevenue === 'number') {
    out.capexMethod = 'TOTAL';
    out.capexPct = series(years, legacy.capexPctRevenue);
  }
  return out;
}
