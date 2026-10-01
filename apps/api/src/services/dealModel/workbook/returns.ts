// Sources & uses, debt schedule, exit, IRR / MoM and a DCF cross-check —
// all live formulas off Assumptions and the Projections EBITDA / FCF rows.

import type ExcelJS from 'exceljs';
import type { ResolvedAssumptions } from '../assumptions.js';
import type { BasePeriod } from '../basePeriod.js';
import type { BaseColumn } from '../lineCatalogue.js';
import type { Registry } from './registry.js';
import { SHEETS, FMT_MONEY, FMT_PCT, FMT_MULT, colLetter, fx, label, put, title, unitsText, type WorkbookContext } from './xlsx.js';

export const RETURNS_ROWS = {
  entryEbitda: 4,
  entryEv: 5,
  fees: 6,
  debt: 7,
  equity: 8,
  debtHeader: 11,
  opening: 12,
  interest: 13,
  amort: 14,
  closing: 15,
  dscr: 16,
  dscrHeadroom: 17,
  exitHeader: 19,
  exitEbitda: 20,
  exitEv: 21,
  exitDebt: 22,
  exitEquity: 23,
  cfHeader: 26,
  cashflow: 27,
  irr: 29,
  mom: 30,
  dcfHeader: 32,
  dcfValue: 33,
  dcfVsEntry: 34,
} as const;
const R = RETURNS_ROWS;

export function writeReturns(
  sheet: ExcelJS.Worksheet,
  a: ResolvedAssumptions,
  reg: Registry,
  base: BasePeriod | null,
  baseCol: BaseColumn,
  ctx: WorkbookContext,
) {
  const years = a.projectionYears;
  const P = SHEETS.projections;
  const S = reg.scalar;
  const ebitdaRow = reg.pl.row.ebitda;
  sheet.columns = [{ width: 34 }, ...Array.from({ length: years + 2 }, () => ({ width: 14 }))];
  title(sheet, 'Sources, uses & returns', unitsText(ctx));

  const src = baseCol.entrySource;
  label(sheet, R.entryEbitda, `Entry EBITDA (${base ? base.label.replace(/ ?A$/, '') : 'base'}${src === 'deal' ? ', from deal' : ''}${src === 'missing' ? ' — MISSING' : ''})`);
  put(sheet, R.entryEbitda, 2, fx(`${P}!B${ebitdaRow}`), FMT_MONEY);

  label(sheet, R.entryEv, 'Entry enterprise value');
  // entryBasis REVENUE: the multiple applies to base revenue, not EBITDA.
  const entryMetric = a.entryBasis === 'REVENUE' ? `${P}!B${reg.pl.row.revenue}` : `B${R.entryEbitda}`;
  put(sheet, R.entryEv, 2, fx(`${entryMetric}*${S('entryMultiple')}`), FMT_MONEY);

  label(sheet, R.fees, 'Transaction fees');
  put(sheet, R.fees, 2, fx(`B${R.entryEv}*${S('transactionFeesPct')}`), FMT_MONEY);

  label(sheet, R.debt, 'Debt raised');
  put(sheet, R.debt, 2, fx(a.debtQuantumMode === 'ABSOLUTE' ? S('debtQuantum') : `B${R.entryEbitda}*${S('debtQuantum')}`), FMT_MONEY);

  label(sheet, R.equity, 'Equity cheque', true);
  put(sheet, R.equity, 2, fx(`B${R.entryEv}+B${R.fees}-B${R.debt}`), FMT_MONEY);

  // ── Debt schedule ────────────────────────────────────────────
  label(sheet, R.debtHeader, 'Debt schedule', true);
  for (let y = 0; y < years; y++) sheet.getCell(R.debtHeader, 2 + y).value = `Y${y + 1}`;
  label(sheet, R.opening, 'Opening debt');
  label(sheet, R.interest, 'Interest');
  label(sheet, R.amort, 'Amortisation');
  label(sheet, R.closing, 'Closing debt');
  label(sheet, R.dscr, 'DSCR');
  label(sheet, R.dscrHeadroom, 'DSCR headroom vs target');

  for (let y = 0; y < years; y++) {
    const col = colLetter(2 + y);
    const prev = colLetter(1 + y);
    const projCol = colLetter(3 + y);
    put(sheet, R.opening, 2 + y, fx(y === 0 ? `B${R.debt}` : `${prev}${R.closing}`), FMT_MONEY);
    put(sheet, R.interest, 2 + y, fx(`${col}${R.opening}*${S('interestRate')}`), FMT_MONEY);
    // Scheduled amortisation plus a cash sweep out of that year's free
    // cash flow, capped at the opening balance so debt can't go negative.
    put(sheet, R.amort, 2 + y, fx(
      `MIN(${col}${R.opening},B${R.debt}*${S('amortPctPerYear')}` +
      `+MAX(0,${P}!${projCol}${reg.pl.fcf})*${S('cashSweepPct')})`,
    ), FMT_MONEY);
    put(sheet, R.closing, 2 + y, fx(`${col}${R.opening}-${col}${R.amort}`), FMT_MONEY);
    // DSCR = EBITDA / (interest + amortisation). Lenders live on this line.
    put(sheet, R.dscr, 2 + y, fx(
      `IF((${col}${R.interest}+${col}${R.amort})=0,"",${P}!${projCol}${ebitdaRow}/(${col}${R.interest}+${col}${R.amort}))`,
    ), '0.00"x"');
    // Headroom against the covenant; negative = breach at these assumptions.
    put(sheet, R.dscrHeadroom, 2 + y, fx(`IF(${col}${R.dscr}="","",${col}${R.dscr}-${S('dscrTarget')})`), '0.00"x";[Red]-0.00"x"');
  }

  // ── Exit ─────────────────────────────────────────────────────
  label(sheet, R.exitHeader, 'Exit', true);
  label(sheet, R.exitEbitda, 'Exit-year EBITDA');
  // INDEX on the exit-year input so changing it in Excel moves the exit.
  const ebitdaRange = `${P}!${colLetter(3)}${ebitdaRow}:${colLetter(2 + years)}${ebitdaRow}`;
  put(sheet, R.exitEbitda, 2, fx(`INDEX(${ebitdaRange},1,${S('exitYear')})`), FMT_MONEY);
  label(sheet, R.exitEv, 'Exit enterprise value');
  put(sheet, R.exitEv, 2, fx(`B${R.exitEbitda}*${S('exitMultiple')}`), FMT_MONEY);
  label(sheet, R.exitDebt, 'Debt at exit');
  put(sheet, R.exitDebt, 2, fx(`INDEX(${colLetter(2)}${R.closing}:${colLetter(1 + years)}${R.closing},1,${S('exitYear')})`), FMT_MONEY);
  label(sheet, R.exitEquity, 'Equity proceeds', true);
  put(sheet, R.exitEquity, 2, fx(`B${R.exitEv}-B${R.exitDebt}`), FMT_MONEY);

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
