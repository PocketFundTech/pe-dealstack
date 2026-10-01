// ─── Deal model — line structure + calculator ─────────────────────
// Shared by the API (scenario summary on GET /model/cases) and the web
// panel (live preview), so the numbers a user sees before downloading are
// the same arithmetic the workbook's formulas perform. The workbook is
// still the source of truth: every figure there is a live Excel formula.
//
// A model is a list of P&L lines (the "catalogue", built server-side from
// the deal's extracted accounts) plus one driver per input line:
//   GROWTH       value_y = value_(y-1) × (1 + g)
//   PCT_REVENUE  value_y = revenue_y × p
//   FIXED        value_y = v
//   SUBTOTAL     a formula line — sum of its accounts, a subtotal (gross
//                profit, EBITDA, EBIT, EBT, net income) or a linked line
//                (interest from the debt schedule, tax from the tax rate).
// Percentages are stored as percent numbers (5 = 5%), money in millions.
// Working capital, capex and the debt schedule: see dealModelCash.ts (E3).

import {
  DAYS_IN_YEAR, balanceDriversOf, debtScheduler,
  type CashFlowAssumptionFields, type DebtYear, type OpeningBalances,
} from './dealModelCash.js';

export type DriverMethod = 'PCT_REVENUE' | 'GROWTH' | 'FIXED' | 'SUBTOTAL';
export const INPUT_METHODS = ['GROWTH', 'PCT_REVENUE', 'FIXED'] as const;

export interface LineDriver {
  method: DriverMethod;
  /** One per projected year; empty for SUBTOTAL. */
  values: number[];
}

/** Labels used on the Assumptions sheet's method cells and in the panel. */
export const DRIVER_METHOD_LABELS: Record<Exclude<DriverMethod, 'SUBTOTAL'>, string> = {
  GROWTH: 'Growth %',
  PCT_REVENUE: '% of revenue',
  FIXED: 'Fixed',
};

export type ModelLineKind = 'INPUT' | 'SUM' | 'SUBTOTAL' | 'COMPUTED';

export interface ModelLine {
  key: string;
  label: string;
  kind: ModelLineKind;
  /** Outline depth: 0 = statement line, 1+ = account nested under `parent`. */
  level: number;
  parent?: string;
  /** SUM: its accounts (+1 each). SUBTOTAL: signed lines. */
  components?: Array<{ key: string; sign: 1 | -1 }>;
  /** Revenue or one of its accounts — GROWTH / FIXED only (% of revenue would be circular). */
  revenueLine?: boolean;
  /** Operating cost between revenue and EBITDA — scenario margin deltas apply. */
  costLine?: boolean;
  /** COMPUTED lines: interest comes from the debt schedule, tax from the tax rate. */
  computed?: 'INTEREST' | 'TAX';
  /** Accounts of a COMPUTED line — shown in Historicals only. */
  historicalOnly?: boolean;
}

export function allowedMethods(line: ModelLine): DriverMethod[] {
  if (line.kind !== 'INPUT') return ['SUBTOTAL'];
  return line.revenueLine ? ['GROWTH', 'FIXED'] : ['PCT_REVENUE', 'GROWTH', 'FIXED'];
}

export interface CalcAssumptions extends CashFlowAssumptionFields {
  entryMultiple: number;
  entryBasis: 'EBITDA' | 'REVENUE';
  transactionFeesPct: number;
  debtQuantumMode: 'MULTIPLE' | 'ABSOLUTE';
  /** Senior tranche: × entry EBITDA (MULTIPLE) or an amount (ABSOLUTE). */
  debtQuantum: number;
  interestRate: number;
  amortPctPerYear: number;
  /** Optional second tranche (fix plan E3), same quantum mode; 0 / absent = none. */
  debt2Quantum?: number;
  debt2InterestRate?: number;
  debt2AmortPct?: number;
  /** % of cash above the minimum swept to repay debt. */
  cashSweepPct: number;
  /** Minimum cash balance (millions), funded at entry. */
  minCash?: number;
  taxRate: number;
  exitMultiple: number;
  exitYear: number;
  lineDrivers: Record<string, LineDriver>;
}

export interface ModelProjection {
  /** values[key][y]; index 0..n-1 = Y1..Yn. */
  values: Record<string, number[]>;
  /** Base column (LTM / last full year) per line. */
  base: Record<string, number>;
  revenue: number[];
  ebitda: number[];
  ebitdaMarginPct: Array<number | null>;
  /** Net working capital per year, and the base column's. */
  nwc: number[];
  nwcBase: number;
  deltaNwc: number[];
  capex: number[];
  /** Unlevered FCF = EBIT × (1 − tax) + D&A − capex − ΔNWC (DCF). */
  fcf: number[];
  /** Levered FCF = net income + D&A − capex − ΔNWC (feeds the cash sweep). */
  leveredFcf: number[];
  debtSchedule: DebtYear[];
  debtClosing: number[];
  cashClosing: number[];
  entryEbitda: number;
  entryEv: number;
  equity: number;
  /** Total debt raised at entry (senior + second tranche). */
  debt: number;
  seniorDebt: number;
  secondDebt: number;
  minCash: number;
  exitRevenue: number;
  exitEbitda: number;
  exitEv: number;
  exitDebt: number;
  exitCash: number;
  exitEquity: number;
  mom: number | null;
  irr: number | null;
}

/**
 * Evaluate the model the way the workbook's formulas do. `baseValues` are
 * the base-column figures for INPUT (and COMPUTED) lines; missing = 0.
 * `opening` carries the latest full-year balances (DAYS working capital).
 */
export function projectModel(
  lines: ModelLine[],
  baseValues: Record<string, number>,
  a: CalcAssumptions,
  opening: OpeningBalances = {},
): ModelProjection {
  const n = a.projectionYears;
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const memo = new Map<string, number>();
  const pct = (v: number) => v / 100;
  const bd = balanceDriversOf(a);
  const at = (xs: number[], y: number) => xs[y] ?? xs[xs.length - 1] ?? 0;

  const val = (key: string, y: number): number => {
    const id = `${key}|${y}`;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const line = byKey.get(key);
    let out = 0;
    if (!line) out = 0;
    else if (line.kind === 'SUM' || line.kind === 'SUBTOTAL') {
      out = (line.components ?? []).reduce((s, c) => s + c.sign * val(c.key, y), 0);
    } else if (line.kind === 'COMPUTED') {
      if (y < 0) out = baseValues[key] ?? 0;
      else if (line.computed === 'INTEREST') out = debt.interestAt(y);
      else if (line.computed === 'TAX') out = Math.max(0, val('ebt', y)) * pct(a.taxRate);
    } else if (y < 0) {
      out = baseValues[key] ?? 0;
    } else {
      const d = a.lineDrivers[key];
      const v = d?.values[y] ?? 0;
      if (!d || d.method === 'FIXED') out = v;
      else if (d.method === 'GROWTH') out = val(key, y - 1) * (1 + pct(v));
      else if (d.method === 'PCT_REVENUE') out = val('revenue', y) * pct(v);
    }
    memo.set(id, out);
    return out;
  };

  const nwcAt = (y: number): number => {
    if (bd.nwcMethod === 'PCT_REVENUE') return val('revenue', y) * pct(at(bd.nwcPct, Math.max(y, 0)));
    if (y < 0) return (opening.ar ?? 0) + (opening.inventory ?? 0) - (opening.ap ?? 0);
    const cogs = val('cogs', y);
    return (val('revenue', y) * at(bd.dso, y) + cogs * at(bd.dio, y) - cogs * at(bd.dpo, y)) / DAYS_IN_YEAR;
  };
  const capexAt = (y: number): number => val('revenue', y) * pct(bd.capexMethod === 'SPLIT'
    ? at(bd.capexMaintPct, y) + at(bd.capexGrowthPct, y)
    : at(bd.capexPct, y));
  const cashItems = (y: number) => val('da', y) - capexAt(y) - (nwcAt(y) - nwcAt(y - 1));
  const fcfAt = (y: number) => val('ebit', y) * (1 - pct(a.taxRate)) + cashItems(y);
  const lfcfAt = (y: number) => val('net_income', y) + cashItems(y);

  const entryEbitda = val('ebitda', -1);
  const size = (q: number | undefined) => (a.debtQuantumMode === 'ABSOLUTE' ? (q ?? 0) : entryEbitda * (q ?? 0));
  const seniorDebt = size(a.debtQuantum);
  const secondDebt = size(a.debt2Quantum);
  const minCash = a.minCash ?? 0;
  const debt = debtScheduler({
    senior: seniorDebt, seniorRate: a.interestRate, seniorAmort: a.amortPctPerYear,
    second: secondDebt, secondRate: a.debt2InterestRate ?? 0, secondAmort: a.debt2AmortPct ?? 0,
    minCash, sweepPct: a.cashSweepPct,
  }, lfcfAt);

  const years = Array.from({ length: n }, (_, y) => y);
  const values: Record<string, number[]> = {};
  const base: Record<string, number> = {};
  for (const l of lines) {
    base[l.key] = val(l.key, -1);
    values[l.key] = l.historicalOnly ? [] : years.map((y) => val(l.key, y));
  }
  const revenue = years.map((y) => val('revenue', y));
  const ebitda = years.map((y) => val('ebitda', y));
  const debtSchedule = years.map((y) => debt.year(y));

  const entryMetric = a.entryBasis === 'REVENUE' ? val('revenue', -1) : entryEbitda;
  const entryEv = entryMetric * a.entryMultiple;
  const totalDebt = seniorDebt + secondDebt;
  const equity = entryEv * (1 + pct(a.transactionFeesPct)) + minCash - totalDebt;
  const exitIdx = Math.min(Math.max(a.exitYear, 1), n) - 1;
  const exitEbitda = ebitda[exitIdx] ?? 0;
  const exitEv = exitEbitda * a.exitMultiple;
  const exitDebt = debtSchedule[exitIdx]?.closing ?? 0;
  const exitCash = debtSchedule[exitIdx]?.cashClose ?? 0;
  const exitEquity = exitEv - exitDebt + exitCash;
  // Excel: MoM = IF(equity=0,"",proceeds/equity); IRR of [-equity, 0…, proceeds].
  const mom = equity !== 0 ? exitEquity / equity : null;
  const irr = equity > 0 && exitEquity > 0 ? Math.pow(exitEquity / equity, 1 / (exitIdx + 1)) - 1 : null;

  return {
    values, base, revenue, ebitda,
    ebitdaMarginPct: years.map((y) => (revenue[y] ? (ebitda[y] / revenue[y]) * 100 : null)),
    nwc: years.map(nwcAt), nwcBase: nwcAt(-1), deltaNwc: years.map((y) => nwcAt(y) - nwcAt(y - 1)),
    capex: years.map(capexAt), fcf: years.map(fcfAt), leveredFcf: debtSchedule.map((d) => d.lfcf),
    debtSchedule, debtClosing: debtSchedule.map((d) => d.closing), cashClosing: debtSchedule.map((d) => d.cashClose),
    entryEbitda, entryEv, equity, debt: totalDebt, seniorDebt, secondDebt, minCash,
    exitRevenue: revenue[exitIdx] ?? 0, exitEbitda, exitEv, exitDebt, exitCash, exitEquity, mom, irr,
  };
}

// ─── Scenarios (fix plan E2) ──────────────────────────────────────
// Each case is a full assumption set (a DealModel row per name); the
// workbook carries all three and switches with an "Active case" cell.

export const MODEL_CASES = ['Low', 'Base', 'High'] as const;
export type ModelCase = (typeof MODEL_CASES)[number];

export interface CaseSummary {
  exitRevenue: number;
  exitEbitda: number;
  exitEv: number;
  entryEv: number;
  equity: number;
  irr: number | null;
  mom: number | null;
}

/** Headline figures for one case — what the workbook's Scenarios sheet shows. */
export function summariseCase(
  lines: ModelLine[], baseValues: Record<string, number>, a: CalcAssumptions, opening: OpeningBalances = {},
): CaseSummary {
  const p = projectModel(lines, baseValues, a, opening);
  return {
    exitRevenue: p.exitRevenue, exitEbitda: p.exitEbitda, exitEv: p.exitEv,
    entryEv: p.entryEv, equity: p.equity, irr: p.irr, mom: p.mom,
  };
}
