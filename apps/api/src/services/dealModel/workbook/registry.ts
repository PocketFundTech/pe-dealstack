// ─── Deal model workbook — cell registry ──────────────────────────
// Every formula references cells by address, so the layout is generated
// from the line catalogue rather than hand-maintained (the old fixed
// ASSUMPTION_CELLS / PL_ROWS maps). Sheet writers ask the registry for an
// address; tests rebuild the same registry and assert against it.
//
// Assumptions layout (fix plan E2):
//   B4  Active case (blue input: Low / Base / High)   B5  its number (MATCH)
//   row 7 header, then one row per scalar:  B Low | C Base | D High | E Live
//   driver block: four rows per line (Low, Base, High, Live);
//     B case name | C method | D.. one value per projected year
//   Live = CHOOSE(active case number, Low, Base, High). The main model reads
//   only Live cells; the Scenarios sheet reads each case directly.

import type { ModelCase, ModelLine } from '@ai-crm/shared';
import { MODEL_CASES } from '@ai-crm/shared';
import { SHEETS, colLetter } from './xlsx.js';

/** Scalar assumptions, in Assumptions-sheet order. */
export const SCALAR_KEYS = [
  'entryMultiple', 'transactionFeesPct', 'debtQuantum', 'interestRate', 'amortPctPerYear',
  'cashSweepPct', 'capexPctRevenue', 'nwcPctRevenue', 'taxRate', 'exitMultiple', 'exitYear',
  'wacc', 'dscrTarget',
] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

export type CaseColumn = ModelCase | 'Live';
export const CASE_COLUMNS: CaseColumn[] = [...MODEL_CASES, 'Live'];

const A = SHEETS.assumptions;
export const ACTIVE_CASE_ROW = 4;
export const ACTIVE_INDEX_ROW = 5;
export const SCALAR_HEADER_ROW = 7;
/** Scalar block: B Low, C Base, D High, E Live. */
export const SCALAR_CASE_COL: Record<CaseColumn, number> = { Low: 2, Base: 3, High: 4, Live: 5 };
/** Driver block: A line, B case, C method, D.. one column per projected year. */
export const DRIVER_CASE_COL = 2;
export const DRIVER_METHOD_COL = 3;
export const DRIVER_FIRST_YEAR_COL = 4;

export interface Registry {
  years: number;
  lines: ModelLine[];
  /** Lines with driver rows on Assumptions (inputs that are projected). */
  driverLines: ModelLine[];
  assumptions: {
    activeCase: string;
    activeIndex: string;
    scalarRow: Record<ScalarKey, number>;
    driverHeaderRow: number;
    driverRow: Record<string, Record<CaseColumn, number>>;
  };
  pl: {
    header: number;
    row: Record<string, number>;
    grossMargin: number | null;
    ebitdaMargin: number;
    fcf: number;
  };
  /** Scalar cell, Live unless a case is named. */
  scalar(name: ScalarKey, c?: CaseColumn): string;
  /** Method cell of a line's driver. */
  method(key: string, c?: CaseColumn): string;
  /** Driver value for projected year y (0-based). */
  value(key: string, y: number, c?: CaseColumn): string;
}

export function buildRegistry(lines: ModelLine[], years: number): Registry {
  const scalarRow = Object.fromEntries(SCALAR_KEYS.map((k, i) => [k, SCALAR_HEADER_ROW + 1 + i])) as Record<ScalarKey, number>;
  const driverLines = lines.filter((l) => l.kind === 'INPUT' && !l.historicalOnly);
  const driverHeaderRow = SCALAR_HEADER_ROW + SCALAR_KEYS.length + 2;
  const driverRow = Object.fromEntries(driverLines.map((l, i) => {
    const first = driverHeaderRow + 1 + i * CASE_COLUMNS.length;
    return [l.key, Object.fromEntries(CASE_COLUMNS.map((c, j) => [c, first + j])) as Record<CaseColumn, number>];
  }));

  const header = 3;
  const row = Object.fromEntries(lines.map((l, i) => [l.key, header + 1 + i]));
  const afterLines = header + lines.length + 2;
  const hasGp = lines.some((l) => l.key === 'gross_profit');
  const grossMargin = hasGp ? afterLines : null;
  const ebitdaMargin = hasGp ? afterLines + 1 : afterLines;
  const fcf = ebitdaMargin + 2;

  const need = (key: string, c: CaseColumn) => {
    const r = driverRow[key]?.[c];
    if (r === undefined) throw new Error(`No driver row for line "${key}"`);
    return r;
  };
  return {
    years,
    lines,
    driverLines,
    assumptions: {
      activeCase: `${A}!$B$${ACTIVE_CASE_ROW}`,
      activeIndex: `${A}!$B$${ACTIVE_INDEX_ROW}`,
      scalarRow,
      driverHeaderRow,
      driverRow,
    },
    pl: { header, row, grossMargin, ebitdaMargin, fcf },
    scalar: (name, c = 'Live') => `${A}!$${colLetter(SCALAR_CASE_COL[c])}$${scalarRow[name]}`,
    method: (key, c = 'Live') => `${A}!$${colLetter(DRIVER_METHOD_COL)}$${need(key, c)}`,
    value: (key, y, c = 'Live') => `${A}!$${colLetter(DRIVER_FIRST_YEAR_COL + y)}$${need(key, c)}`,
  };
}
