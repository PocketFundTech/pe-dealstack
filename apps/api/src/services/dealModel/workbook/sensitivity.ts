// Sensitivity: IRR across entry (rows) and exit (columns) multiples, as
// formulas so the grid recalculates when the model changes.

import type ExcelJS from 'exceljs';
import type { ResolvedAssumptions } from '../assumptions.js';
import type { Registry } from './registry.js';
import { RETURNS_ROWS as R } from './returns.js';
import { SHEETS, FMT_MULT, FMT_PCT, fx, title } from './xlsx.js';

export function writeSensitivity(sheet: ExcelJS.Worksheet, a: ResolvedAssumptions, reg: Registry) {
  const S = reg.scalar;
  sheet.columns = [{ width: 22 }, ...Array.from({ length: 6 }, () => ({ width: 12 }))];
  title(sheet, 'Sensitivity — IRR', 'Entry multiple (rows) against exit multiple (columns)');

  const steps = [-1, -0.5, 0, 0.5, 1];
  const headerRow = 4;
  sheet.getCell(headerRow, 1).value = 'Entry \\ Exit';
  sheet.getCell(headerRow, 1).font = { bold: true };
  steps.forEach((s, i) => {
    const cell = sheet.getCell(headerRow, 2 + i);
    cell.value = fx(`${S('exitMultiple')}+${s}`);
    cell.numFmt = FMT_MULT;
    cell.font = { bold: true };
  });

  const Rt = SHEETS.returns;
  // The metric the entry multiple applies to: base EBITDA, or base revenue.
  const entryBasis = a.entryBasis === 'REVENUE'
    ? `${SHEETS.projections}!$B$${reg.pl.row.revenue}`
    : `${Rt}!$B$${R.entryEbitda}`;
  steps.forEach((entryStep, r) => {
    const row = headerRow + 1 + r;
    const rowHead = sheet.getCell(row, 1);
    rowHead.value = fx(`${S('entryMultiple')}+${entryStep}`);
    rowHead.numFmt = FMT_MULT;
    rowHead.font = { bold: true };
    steps.forEach((exitStep, c) => {
      // Closed-form MoM-implied IRR at this (entry, exit) pair, with the
      // debt and cash path of the live case held as it is:
      // equity0 = EV(entry) + fees + minimum cash − new debt
      // proceeds = EV(exit) − debt at exit + cash at exit
      const entryEv = `${entryBasis}*(${S('entryMultiple')}+${entryStep})`;
      const equity0 = `(${entryEv})*(1+${S('transactionFeesPct')})+${Rt}!$B$${R.minCash}-${Rt}!$B$${R.totalDebt}`;
      const proceeds = `${Rt}!$B$${R.exitEbitda}*(${S('exitMultiple')}+${exitStep})-${Rt}!$B$${R.exitDebt}+${Rt}!$B$${R.exitCash}`;
      const cell = sheet.getCell(row, 2 + c);
      cell.value = fx(`IFERROR(((${proceeds})/(${equity0}))^(1/${S('exitYear')})-1,"n/a")`);
      cell.numFmt = FMT_PCT;
    });
  });
}
