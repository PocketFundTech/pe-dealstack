// Debt and cash schedule (fix plan E3) — on the Returns sheet and inside
// each Scenarios block, from this one builder.
//
// Two tranches (senior + an optional second tranche; a zero-sized tranche
// just carries zeros). Per year:
//   mandatory = MIN(opening, original × amortisation %)
//   interest  = (opening − mandatory / 2) × rate — the average balance, with
//               scheduled amortisation through the year and the sweep at
//               year end. Interest never reads the sweep, so levered FCF
//               (after interest and tax) can drive the sweep with no
//               circular reference and no iterative calculation.
//   cash swept = MAX(0, opening cash + levered FCF − mandatory − minimum cash) × sweep %
//   senior sweep = MIN(senior after mandatory, cash swept); the second
//   tranche takes what is left. Closing cash = opening cash + levered FCF −
//   mandatory − sweeps; opening cash in Y1 is the minimum cash funded at entry.
// Revolver (fix plan H2; commitment 0 = none, every row 0): undrawn at entry;
//   interest = opening drawn × rate + (commitment − opening drawn) × fee —
//   opening balance only, so no circular reference; repaid first from cash
//   above the minimum (before the sweep); drawn to cover a shortfall below
//   the minimum, up to the undrawn commitment.
// Mirrors debtScheduler in @ai-crm/shared (numbers checked by deal-model-parity.test.ts).

import type ExcelJS from 'exceljs';
import type { ScalarKey } from './registry.js';
import { FMT_MONEY, colLetter, fx, label, put } from './xlsx.js';

export const DEBT_KEYS = [
  'lfcf', 'cashOpen',
  'open1', 'mand1', 'int1',
  'open2', 'mand2', 'int2',
  'openR', 'intR',
  'interest', 'repayR', 'drawR', 'available', 'sweep1', 'sweep2',
  'close1', 'close2', 'closeR', 'closing', 'cashClose',
] as const;
export type DebtKey = (typeof DEBT_KEYS)[number];

export const DEBT_LABELS: Record<DebtKey, string> = {
  lfcf: 'Levered FCF (after interest and tax)',
  cashOpen: 'Opening cash',
  open1: 'Senior — opening balance',
  mand1: 'Senior — mandatory amortisation',
  int1: 'Senior — interest (average balance)',
  open2: 'Second tranche — opening balance',
  mand2: 'Second tranche — mandatory amortisation',
  int2: 'Second tranche — interest (average balance)',
  openR: 'Revolver — opening drawn',
  intR: 'Revolver — interest on drawn + undrawn fee',
  interest: 'Total interest',
  repayR: 'Revolver — repaid from cash above minimum',
  drawR: 'Revolver — drawn to hold minimum cash',
  available: 'Cash swept (cash above minimum, after revolver, × sweep %)',
  sweep1: 'Senior — cash sweep',
  sweep2: 'Second tranche — cash sweep',
  close1: 'Senior — closing balance',
  close2: 'Second tranche — closing balance',
  closeR: 'Revolver — closing drawn',
  closing: 'Total debt — closing (incl. revolver)',
  cashClose: 'Closing cash',
};

export interface DebtBlock {
  rows: Record<DebtKey, number>;
  years: number;
  /** Column number of projected year y. */
  yearCol: (y: number) => number;
  /** Levered FCF of year y (a reference). */
  lfcf: (y: number) => string;
  /** Absolute references: tranche sizes at entry and the minimum cash. */
  senior: string;
  second: string;
  minCash: string;
  scalar: (name: ScalarKey) => string;
}

/** Formula for one schedule row in year y. */
export function debtFormula(k: DebtKey, y: number, d: DebtBlock): string {
  const c = colLetter(d.yearCol(y));
  const p = colLetter(d.yearCol(y - 1));
  const r = (key: DebtKey) => `${c}${d.rows[key]}`;
  const S = d.scalar;
  // Cash before the revolver and the sweep.
  const pre = `${r('cashOpen')}+${r('lfcf')}-${r('mand1')}-${r('mand2')}`;
  switch (k) {
    case 'lfcf': return d.lfcf(y);
    case 'cashOpen': return y === 0 ? d.minCash : `${p}${d.rows.cashClose}`;
    case 'open1': return y === 0 ? d.senior : `${p}${d.rows.close1}`;
    case 'mand1': return `MIN(${r('open1')},${d.senior}*${S('amortPctPerYear')})`;
    case 'int1': return `(${r('open1')}-${r('mand1')}/2)*${S('interestRate')}`;
    case 'open2': return y === 0 ? d.second : `${p}${d.rows.close2}`;
    case 'mand2': return `MIN(${r('open2')},${d.second}*${S('debt2AmortPct')})`;
    case 'int2': return `(${r('open2')}-${r('mand2')}/2)*${S('debt2InterestRate')}`;
    case 'openR': return y === 0 ? '0' : `${p}${d.rows.closeR}`;
    case 'intR': return `${r('openR')}*${S('revolverRate')}+(${S('revolverSize')}-${r('openR')})*${S('revolverFeePct')}`;
    case 'interest': return `${r('int1')}+${r('int2')}+${r('intR')}`;
    case 'repayR': return `MIN(${r('openR')},MAX(0,${pre}-${d.minCash}))`;
    case 'drawR': return `MIN(${S('revolverSize')}-${r('openR')},MAX(0,${d.minCash}-(${pre})))`;
    case 'available':
      return `MAX(0,${pre}-${r('repayR')}-${d.minCash})*${S('cashSweepPct')}`;
    case 'sweep1': return `MIN(${r('open1')}-${r('mand1')},${r('available')})`;
    case 'sweep2': return `MIN(${r('open2')}-${r('mand2')},${r('available')}-${r('sweep1')})`;
    case 'close1': return `${r('open1')}-${r('mand1')}-${r('sweep1')}`;
    case 'close2': return `${r('open2')}-${r('mand2')}-${r('sweep2')}`;
    case 'closeR': return `${r('openR')}+${r('drawR')}-${r('repayR')}`;
    case 'closing': return `${r('close1')}+${r('close2')}+${r('closeR')}`;
    case 'cashClose': return `${pre}+${r('drawR')}-${r('repayR')}-${r('sweep1')}-${r('sweep2')}`;
  }
}

export function writeDebtSchedule(sheet: ExcelJS.Worksheet, d: DebtBlock) {
  for (const k of DEBT_KEYS) {
    label(sheet, d.rows[k], DEBT_LABELS[k], k === 'closing' || k === 'cashClose' || k === 'interest');
    for (let y = 0; y < d.years; y++) put(sheet, d.rows[k], d.yearCol(y), fx(debtFormula(k, y, d)), FMT_MONEY);
  }
}

/** Consecutive rows for the schedule, starting at `first`. */
export function debtRows(first: number): Record<DebtKey, number> {
  return Object.fromEntries(DEBT_KEYS.map((k, i) => [k, first + i])) as Record<DebtKey, number>;
}
