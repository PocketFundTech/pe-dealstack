// Sources & uses, debt and cash schedule, exit, IRR / MoM and a DCF
// cross-check — all live formulas off Assumptions (Live column) and the
// Projections EBITDA / FCF rows.
//
// Entry is cash-free, debt-free (fix plan E3): the seller's net debt from
// the latest full-year balance sheet is refinanced at entry — the equity
// purchase price is EV − net debt, existing debt is repaid and existing cash
// acquired — so the sponsor's cheque is EV + fees + minimum cash − new debt
// whatever the opening net debt. Sources and uses are shown in full and
// must balance.

import type ExcelJS from 'exceljs';
import type { OpeningBalances } from '@ai-crm/shared';
import type { ResolvedAssumptions } from '../assumptions.js';
import type { BasePeriod } from '../basePeriod.js';
import type { BaseColumn } from '../lineCatalogue.js';
import type { Registry, ScalarKey } from './registry.js';
import { debtRows, writeDebtSchedule } from './debtSchedule.js';
import {
  SHEETS, FMT_MONEY, FMT_PCT, FMT_MULT, INPUT_FONT, colLetter, fx, label, put, title, unitsText, type WorkbookContext,
} from './xlsx.js';

const DEBT_HEADER = 28;
const SCHEDULE = debtRows(DEBT_HEADER + 1);

export const RETURNS_ROWS = {
  entryEbitda: 4,
  entryEv: 5,
  fees: 6,
  /** Senior tranche raised at entry. */
  debt: 7,
  debt2: 8,
  totalDebt: 9,
  minCash: 10,
  equity: 11,
  suHeader: 13,
  existingDebt: 14,
  existingCash: 15,
  netDebt: 16,
  usesEquity: 17,
  usesRefinance: 18,
  usesFees: 19,
  usesCash: 20,
  totalUses: 21,
  srcSenior: 22,
  srcSecond: 23,
  srcCash: 24,
  srcEquity: 25,
  totalSources: 26,
  debtHeader: DEBT_HEADER,
  ...SCHEDULE,
  dscr: SCHEDULE.cashClose + 1,
  dscrHeadroom: SCHEDULE.cashClose + 2,
  exitHeader: SCHEDULE.cashClose + 4,
  exitEbitda: SCHEDULE.cashClose + 5,
  exitEv: SCHEDULE.cashClose + 6,
  exitDebt: SCHEDULE.cashClose + 7,
  exitCash: SCHEDULE.cashClose + 8,
  exitEquity: SCHEDULE.cashClose + 9,
  cfHeader: SCHEDULE.cashClose + 11,
  cashflow: SCHEDULE.cashClose + 12,
  irr: SCHEDULE.cashClose + 14,
  mom: SCHEDULE.cashClose + 15,
  dcfHeader: SCHEDULE.cashClose + 17,
  dcfValue: SCHEDULE.cashClose + 18,
  dcfVsEntry: SCHEDULE.cashClose + 19,
} as const;
const R = RETURNS_ROWS;

/** Entry rows shared with the Scenarios blocks: EBITDA, EV, fees, tranches, minimum cash, equity. */
export function entryFormulas(
  a: Pick<ResolvedAssumptions, 'entryBasis' | 'debtQuantumMode'>,
  row: { entryEbitda: number; entryEv: number; fees: number; debt: number; debt2: number; totalDebt: number; minCash: number },
  S: (name: ScalarKey) => string,
  baseRevenue: string,
): Record<'entryEv' | 'fees' | 'debt' | 'debt2' | 'totalDebt' | 'minCash' | 'equity', string> {
  const size = (q: 'debtQuantum' | 'debt2Quantum') => (a.debtQuantumMode === 'ABSOLUTE' ? S(q) : `B${row.entryEbitda}*${S(q)}`);
  return {
    // entryBasis REVENUE: the multiple applies to base revenue, not EBITDA.
    entryEv: `${a.entryBasis === 'REVENUE' ? baseRevenue : `B${row.entryEbitda}`}*${S('entryMultiple')}`,
    fees: `B${row.entryEv}*${S('transactionFeesPct')}`,
    debt: size('debtQuantum'),
    debt2: size('debt2Quantum'),
    totalDebt: `B${row.debt}+B${row.debt2}`,
    minCash: S('minCash'),
    equity: `B${row.entryEv}+B${row.fees}+B${row.minCash}-B${row.totalDebt}`,
  };
}

export function writeReturns(
  sheet: ExcelJS.Worksheet,
  a: ResolvedAssumptions,
  reg: Registry,
  base: BasePeriod | null,
  baseCol: BaseColumn,
  opening: OpeningBalances,
  ctx: WorkbookContext,
) {
  const years = a.projectionYears;
  const P = SHEETS.projections;
  const S = reg.scalar;
  const ebitdaRow = reg.pl.row.ebitda;
  sheet.columns = [{ width: 44 }, ...Array.from({ length: years + 2 }, () => ({ width: 14 }))];
  title(sheet, 'Sources, uses & returns', unitsText(ctx));

  // ── Entry ────────────────────────────────────────────────────
  const src = baseCol.entrySource;
  label(sheet, R.entryEbitda, `Entry EBITDA (${base ? base.label.replace(/ ?A$/, '') : 'base'}${src === 'deal' ? ', from deal' : ''}${src === 'missing' ? ' — MISSING' : ''})`);
  put(sheet, R.entryEbitda, 2, fx(`${P}!B${ebitdaRow}`), FMT_MONEY);
  const entry = entryFormulas(a, R, S, `${P}!B${reg.pl.row.revenue}`);
  const entryLabels: Array<[keyof typeof entry, string]> = [
    ['entryEv', 'Entry enterprise value'], ['fees', 'Transaction fees'], ['debt', 'Senior debt raised'],
    ['debt2', 'Second tranche raised'], ['totalDebt', 'Total new debt'], ['minCash', 'Minimum cash funded at entry'],
    ['equity', 'Equity cheque'],
  ];
  for (const [k, text] of entryLabels) {
    label(sheet, R[k], text, k === 'equity');
    put(sheet, R[k], 2, fx(entry[k]), FMT_MONEY);
  }

  // ── Sources & uses: existing net debt refinanced at entry ────
  const bs = opening.period ? `${opening.period} balance sheet` : 'no balance sheet extracted';
  label(sheet, R.suHeader, 'Sources & uses (cash-free, debt-free: existing net debt refinanced at entry)', true);
  label(sheet, R.existingDebt, `Existing debt (${bs})`);
  put(sheet, R.existingDebt, 2, opening.debt ?? 0, FMT_MONEY).font = INPUT_FONT;
  label(sheet, R.existingCash, `Existing cash (${bs})`);
  put(sheet, R.existingCash, 2, opening.cash ?? 0, FMT_MONEY).font = INPUT_FONT;
  label(sheet, R.netDebt, 'Opening net debt');
  put(sheet, R.netDebt, 2, fx(`B${R.existingDebt}-B${R.existingCash}`), FMT_MONEY);
  const su: Array<[number, string, string, boolean?]> = [
    [R.usesEquity, 'Uses: purchase of equity (EV − net debt)', `B${R.entryEv}-B${R.netDebt}`],
    [R.usesRefinance, 'Uses: refinance existing debt', `B${R.existingDebt}`],
    [R.usesFees, 'Uses: transaction fees', `B${R.fees}`],
    [R.usesCash, 'Uses: cash to balance sheet (minimum cash)', `B${R.minCash}`],
    [R.totalUses, 'Total uses', `SUM(B${R.usesEquity}:B${R.usesCash})`, true],
    [R.srcSenior, 'Sources: senior debt', `B${R.debt}`],
    [R.srcSecond, 'Sources: second tranche', `B${R.debt2}`],
    [R.srcCash, 'Sources: existing cash acquired', `B${R.existingCash}`],
    [R.srcEquity, 'Sources: sponsor equity', `B${R.equity}`],
    [R.totalSources, 'Total sources (= total uses)', `SUM(B${R.srcSenior}:B${R.srcEquity})`, true],
  ];
  for (const [row, text, formula, bold] of su) {
    label(sheet, row, text, !!bold);
    put(sheet, row, 2, fx(formula), FMT_MONEY);
  }

  // ── Debt and cash schedule ───────────────────────────────────
  label(sheet, R.debtHeader, 'Debt and cash schedule', true);
  for (let y = 0; y < years; y++) sheet.getCell(R.debtHeader, 2 + y).value = `Y${y + 1}`;
  writeDebtSchedule(sheet, {
    rows: SCHEDULE, years, yearCol: (y) => 2 + y,
    lfcf: (y) => `${P}!${colLetter(3 + y)}${reg.pl.lfcf}`,
    senior: `$B$${R.debt}`, second: `$B$${R.debt2}`, minCash: `$B$${R.minCash}`, scalar: S,
  });
  label(sheet, R.dscr, 'DSCR (EBITDA / (interest + mandatory amortisation))');
  label(sheet, R.dscrHeadroom, 'DSCR headroom vs target');
  for (let y = 0; y < years; y++) {
    const col = colLetter(2 + y);
    const service = `(${col}${R.interest}+${col}${R.mand1}+${col}${R.mand2})`;
    // Lenders live on this line; the voluntary sweep is not debt service.
    put(sheet, R.dscr, 2 + y, fx(`IF(${service}=0,"",${P}!${colLetter(3 + y)}${ebitdaRow}/${service})`), '0.00"x"');
    put(sheet, R.dscrHeadroom, 2 + y, fx(`IF(${col}${R.dscr}="","",${col}${R.dscr}-${S('dscrTarget')})`), '0.00"x";[Red]-0.00"x"');
  }

  // ── Exit ─────────────────────────────────────────────────────
  label(sheet, R.exitHeader, 'Exit', true);
  const lastCol = colLetter(1 + years);
  const exitAt = (row: number) => `INDEX(B${row}:${lastCol}${row},1,${S('exitYear')})`;
  // INDEX on the exit-year input so changing it in Excel moves the exit.
  const ebitdaRange = `${P}!${colLetter(3)}${ebitdaRow}:${colLetter(2 + years)}${ebitdaRow}`;
  const exit: Array<[number, string, string, boolean?]> = [
    [R.exitEbitda, 'Exit-year EBITDA', `INDEX(${ebitdaRange},1,${S('exitYear')})`],
    [R.exitEv, 'Exit enterprise value', `B${R.exitEbitda}*${S('exitMultiple')}`],
    [R.exitDebt, 'Debt at exit', exitAt(R.closing)],
    [R.exitCash, 'Cash at exit', exitAt(R.cashClose)],
    [R.exitEquity, 'Equity proceeds (EV − debt + cash)', `B${R.exitEv}-B${R.exitDebt}+B${R.exitCash}`, true],
  ];
  for (const [row, text, formula, bold] of exit) {
    label(sheet, row, text, !!bold);
    put(sheet, row, 2, fx(formula), FMT_MONEY);
  }

  // ── Equity cash flows + returns ──────────────────────────────
  label(sheet, R.cfHeader, 'Equity cash flows', true);
  sheet.getCell(R.cfHeader, 2).value = 'Y0';
  for (let y = 1; y <= years; y++) sheet.getCell(R.cfHeader, 2 + y).value = `Y${y}`;
  label(sheet, R.cashflow, 'Cash flow');
  put(sheet, R.cashflow, 2, fx(`-B${R.equity}`), FMT_MONEY);
  for (let y = 1; y <= years; y++) {
    // Proceeds land in the exit year only in this simplified structure.
    put(sheet, R.cashflow, 2 + y, fx(`IF(${y}=${S('exitYear')},B${R.exitEquity},0)`), FMT_MONEY);
  }
  const cfRange = `B${R.cashflow}:${colLetter(2 + years)}${R.cashflow}`;
  label(sheet, R.irr, 'IRR', true);
  put(sheet, R.irr, 2, fx(`IFERROR(IRR(${cfRange}),"n/a")`), FMT_PCT);
  label(sheet, R.mom, 'MoM', true);
  put(sheet, R.mom, 2, fx(`IF(B${R.equity}=0,"",B${R.exitEquity}/B${R.equity})`), FMT_MULT);

  // ── DCF cross-check ──────────────────────────────────────────
  label(sheet, R.dcfHeader, 'DCF cross-check (unlevered)', true);
  label(sheet, R.dcfValue, 'PV of unlevered FCF + terminal');
  // Sheet name goes on the range ONCE — `Sheet!A1:Sheet!B2` breaks Google Sheets.
  const fcfRange = `${P}!${colLetter(3)}${reg.pl.fcf}:${colLetter(2 + years)}${reg.pl.fcf}`;
  const terminal = `(${P}!${colLetter(2 + years)}${ebitdaRow}*${S('exitMultiple')})/((1+${S('wacc')})^${years})`;
  put(sheet, R.dcfValue, 2, fx(`IFERROR(NPV(${S('wacc')},${fcfRange})+${terminal},"n/a")`), FMT_MONEY);
  label(sheet, R.dcfVsEntry, 'Premium / (discount) to entry EV');
  put(sheet, R.dcfVsEntry, 2, fx(`IF(B${R.entryEv}=0,"",B${R.dcfValue}/B${R.entryEv}-1)`), '0.0%;[Red](0.0%)');
}
