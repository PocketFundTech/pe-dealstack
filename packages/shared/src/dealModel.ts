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

export interface CalcAssumptions {
  entryMultiple: number;
  entryBasis: 'EBITDA' | 'REVENUE';
  transactionFeesPct: number;
  debtQuantumMode: 'MULTIPLE' | 'ABSOLUTE';
  debtQuantum: number;
  interestRate: number;
  amortPctPerYear: number;
  cashSweepPct: number;
  projectionYears: number;
  capexPctRevenue: number;
  nwcPctRevenue: number;
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
  fcf: number[];
  debtClosing: number[];
  entryEbitda: number;
  entryEv: number;
  equity: number;
  debt: number;
  exitRevenue: number;
  exitEbitda: number;
  exitEv: number;
  exitEquity: number;
  mom: number | null;
  irr: number | null;
}

/**
 * Evaluate the model the way the workbook's formulas do. `baseValues` are
 * the base-column figures for INPUT (and COMPUTED) lines; missing = 0.
 */
export function projectModel(
  lines: ModelLine[],
  baseValues: Record<string, number>,
  a: CalcAssumptions,
): ModelProjection {
  const n = a.projectionYears;
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const memo = new Map<string, number>();
  const pct = (v: number) => v / 100;

  const debtState: { opening: number[]; amort: number[]; closing: number[]; debt0: number | null } = {
    opening: [], amort: [], closing: [], debt0: null,
  };

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
      else if (line.computed === 'INTEREST') out = debtAt(y).opening * pct(a.interestRate);
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

  const fcfAt = (y: number): number => {
    const rev = val('revenue', y);
    const prev = val('revenue', y - 1);
    return val('ebit', y) * (1 - pct(a.taxRate)) + val('da', y)
      - rev * pct(a.capexPctRevenue) - (rev - prev) * pct(a.nwcPctRevenue);
  };

  const entryEbitda = val('ebitda', -1);
  const debt0 = a.debtQuantumMode === 'ABSOLUTE' ? a.debtQuantum : entryEbitda * a.debtQuantum;
  debtState.debt0 = debt0;

  function debtAt(y: number): { opening: number; closing: number } {
    for (let i = debtState.closing.length; i <= y; i++) {
      const opening = i === 0 ? debt0 : debtState.closing[i - 1];
      const amort = Math.min(opening, debt0 * pct(a.amortPctPerYear) + Math.max(0, fcfAt(i)) * pct(a.cashSweepPct));
      debtState.opening.push(opening);
      debtState.amort.push(amort);
      debtState.closing.push(opening - amort);
    }
    return { opening: debtState.opening[y], closing: debtState.closing[y] };
  }

  const years = Array.from({ length: n }, (_, y) => y);
  const values: Record<string, number[]> = {};
  const base: Record<string, number> = {};
  for (const l of lines) {
    base[l.key] = val(l.key, -1);
    values[l.key] = l.historicalOnly ? [] : years.map((y) => val(l.key, y));
  }
  const revenue = years.map((y) => val('revenue', y));
  const ebitda = years.map((y) => val('ebitda', y));
  const fcf = years.map(fcfAt);
  const debtClosing = years.map((y) => debtAt(y).closing);

  const entryMetric = a.entryBasis === 'REVENUE' ? val('revenue', -1) : entryEbitda;
  const entryEv = entryMetric * a.entryMultiple;
  const equity = entryEv * (1 + pct(a.transactionFeesPct)) - debt0;
  const exitIdx = Math.min(Math.max(a.exitYear, 1), n) - 1;
  const exitEbitda = ebitda[exitIdx] ?? 0;
  const exitEv = exitEbitda * a.exitMultiple;
  const exitEquity = exitEv - (debtClosing[exitIdx] ?? 0);
  // Excel: MoM = IF(equity=0,"",proceeds/equity); IRR of [-equity, 0…, proceeds].
  const mom = equity !== 0 ? exitEquity / equity : null;
  const irr = equity > 0 && exitEquity > 0 ? Math.pow(exitEquity / equity, 1 / (exitIdx + 1)) - 1 : null;

  return {
    values, base, revenue, ebitda,
    ebitdaMarginPct: years.map((y) => (revenue[y] ? (ebitda[y] / revenue[y]) * 100 : null)),
    fcf, debtClosing, entryEbitda, entryEv, equity, debt: debt0,
    exitRevenue: revenue[exitIdx] ?? 0, exitEbitda, exitEv, exitEquity, mom, irr,
  };
}
