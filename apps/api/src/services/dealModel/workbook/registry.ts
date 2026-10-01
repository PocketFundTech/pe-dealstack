// ─── Deal model workbook — cell registry ──────────────────────────
// Every formula references cells by address, so the layout is generated
// from the line catalogue rather than hand-maintained (the old fixed
// ASSUMPTION_CELLS / PL_ROWS maps). Sheet writers ask the registry for an
// address; tests rebuild the same registry and assert against it.

import type { ModelLine } from '@ai-crm/shared';
import { SHEETS, colLetter } from './xlsx.js';

/** Scalar assumptions, in Assumptions-sheet order. */
export const SCALAR_KEYS = [
  'entryMultiple', 'transactionFeesPct', 'debtQuantum', 'interestRate', 'amortPctPerYear',
  'cashSweepPct', 'capexPctRevenue', 'nwcPctRevenue', 'taxRate', 'exitMultiple', 'exitYear',
  'wacc', 'dscrTarget',
] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

const A = SHEETS.assumptions;
const SCALAR_FIRST_ROW = 4;
const SCALAR_COL = 2;
/** Driver block: A line, B method, C.. one column per projected year. */
export const DRIVER_METHOD_COL = 2;
export const DRIVER_FIRST_YEAR_COL = 3;

export interface Registry {
  years: number;
  lines: ModelLine[];
  /** Lines with a driver row on Assumptions (inputs that are projected). */
  driverLines: ModelLine[];
  assumptions: {
    scalarRow: Record<ScalarKey, number>;
    driverHeaderRow: number;
    driverRow: Record<string, number>;
  };
  pl: {
    header: number;
    row: Record<string, number>;
    grossMargin: number | null;
    ebitdaMargin: number;
    fcf: number;
  };
  /** `Assumptions!$B$n` for a scalar. */
  scalar(name: ScalarKey): string;
  /** Method cell of a line's driver. */
  method(key: string): string;
  /** Driver value for projected year y (0-based). */
  value(key: string, y: number): string;
}

export function buildRegistry(lines: ModelLine[], years: number): Registry {
  const scalarRow = Object.fromEntries(SCALAR_KEYS.map((k, i) => [k, SCALAR_FIRST_ROW + i])) as Record<ScalarKey, number>;
  const driverLines = lines.filter((l) => l.kind === 'INPUT' && !l.historicalOnly);
  const driverHeaderRow = SCALAR_FIRST_ROW + SCALAR_KEYS.length + 2;
  const driverRow = Object.fromEntries(driverLines.map((l, i) => [l.key, driverHeaderRow + 1 + i]));

  const header = 3;
  const row = Object.fromEntries(lines.map((l, i) => [l.key, header + 1 + i]));
  const afterLines = header + lines.length + 2;
  const hasGp = lines.some((l) => l.key === 'gross_profit');
  const grossMargin = hasGp ? afterLines : null;
  const ebitdaMargin = hasGp ? afterLines + 1 : afterLines;
  const fcf = ebitdaMargin + 2;

  const need = (key: string) => {
    const r = driverRow[key];
    if (r === undefined) throw new Error(`No driver row for line "${key}"`);
    return r;
  };
  return {
    years,
    lines,
    driverLines,
    assumptions: { scalarRow, driverHeaderRow, driverRow },
    pl: { header, row, grossMargin, ebitdaMargin, fcf },
    scalar: (name) => `${A}!$${colLetter(SCALAR_COL)}$${scalarRow[name]}`,
    method: (key) => `${A}!$${colLetter(DRIVER_METHOD_COL)}$${need(key)}`,
    value: (key, y) => `${A}!$${colLetter(DRIVER_FIRST_YEAR_COL + y)}$${need(key)}`,
  };
}
