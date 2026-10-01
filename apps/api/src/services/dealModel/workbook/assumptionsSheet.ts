// Assumptions sheet: blue scalar inputs, then one driver row per P&L line.

import type ExcelJS from 'exceljs';
import { DRIVER_METHOD_LABELS, allowedMethods, type LineDriver } from '@ai-crm/shared';
import type { ResolvedAssumptions } from '../assumptions.js';
import { SCALAR_KEYS, DRIVER_METHOD_COL, DRIVER_FIRST_YEAR_COL, type Registry, type ScalarKey } from './registry.js';
import { INPUT_FONT, FMT_MONEY, FMT_PCT, FMT_MULT, label, title } from './xlsx.js';

/** Label, cell value and format for a scalar. Percentages are written as fractions. */
export function scalarCell(a: ResolvedAssumptions, key: ScalarKey): [string, number, string] {
  const pct = (v: number) => v / 100;
  switch (key) {
    case 'entryMultiple': return [a.entryBasis === 'REVENUE' ? 'Entry multiple (x revenue)' : 'Entry multiple (x EBITDA)', a.entryMultiple, FMT_MULT];
    case 'transactionFeesPct': return ['Transaction fees (% of EV)', pct(a.transactionFeesPct), FMT_PCT];
    case 'debtQuantum': return a.debtQuantumMode === 'ABSOLUTE'
      ? [`Debt raised (${a.currency}, ${a.unitScale.toLowerCase()})`, a.debtQuantum, FMT_MONEY]
      : ['Debt (x EBITDA)', a.debtQuantum, FMT_MULT];
    case 'interestRate': return ['Interest rate', pct(a.interestRate), FMT_PCT];
    case 'amortPctPerYear': return ['Amortisation (% / yr)', pct(a.amortPctPerYear), FMT_PCT];
    case 'cashSweepPct': return ['Cash sweep (% of FCF)', pct(a.cashSweepPct), FMT_PCT];
    case 'capexPctRevenue': return ['Capex (% of revenue)', pct(a.capexPctRevenue), FMT_PCT];
    case 'nwcPctRevenue': return ['NWC (% of revenue)', pct(a.nwcPctRevenue), FMT_PCT];
    case 'taxRate': return ['Tax rate', pct(a.taxRate), FMT_PCT];
    case 'exitMultiple': return ['Exit multiple', a.exitMultiple, FMT_MULT];
    case 'exitYear': return ['Exit year', a.exitYear, '0'];
    case 'wacc': return ['WACC', pct(a.wacc), FMT_PCT];
    case 'dscrTarget': return ['DSCR target', a.dscrTarget, '0.00"x"'];
  }
}

/** Method label + per-year cell values (fractions for % methods, millions for Fixed). */
export function driverCells(d: LineDriver): { method: string; values: number[]; numFmt: string } {
  const method = d.method === 'SUBTOTAL' ? DRIVER_METHOD_LABELS.FIXED : DRIVER_METHOD_LABELS[d.method];
  const isPct = d.method === 'GROWTH' || d.method === 'PCT_REVENUE';
  return { method, values: d.values.map((v) => (isPct ? v / 100 : v)), numFmt: isPct ? '0.00%' : FMT_MONEY };
}

export function methodValidation(revenueLine: boolean | undefined): ExcelJS.DataValidation {
  const opts = revenueLine
    ? [DRIVER_METHOD_LABELS.GROWTH, DRIVER_METHOD_LABELS.FIXED]
    : [DRIVER_METHOD_LABELS.GROWTH, DRIVER_METHOD_LABELS.PCT_REVENUE, DRIVER_METHOD_LABELS.FIXED];
  return { type: 'list', allowBlank: false, formulae: [`"${opts.join(',')}"`] };
}

export function writeAssumptions(sheet: ExcelJS.Worksheet, a: ResolvedAssumptions, reg: Registry) {
  const years = reg.years;
  sheet.columns = [{ width: 34 }, { width: 14 }, ...Array.from({ length: years }, () => ({ width: 11 }))];
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  title(sheet, 'Assumptions', 'Blue cells are inputs. Everything else in this workbook derives from them.');

  for (const key of SCALAR_KEYS) {
    const [name, value, fmt] = scalarCell(a, key);
    const row = reg.assumptions.scalarRow[key];
    label(sheet, row, name);
    const cell = sheet.getCell(row, 2);
    cell.value = value;
    cell.numFmt = fmt;
    cell.font = INPUT_FONT;
  }

  const h = reg.assumptions.driverHeaderRow;
  label(sheet, h, 'P&L drivers by line', true);
  sheet.getCell(h, DRIVER_METHOD_COL).value = 'Method';
  sheet.getCell(h, DRIVER_METHOD_COL).font = { bold: true };
  for (let y = 0; y < years; y++) {
    sheet.getCell(h, DRIVER_FIRST_YEAR_COL + y).value = `Y${y + 1}`;
    sheet.getCell(h, DRIVER_FIRST_YEAR_COL + y).font = { bold: true };
  }

  for (const line of reg.driverLines) {
    const row = reg.assumptions.driverRow[line.key];
    label(sheet, row, line.label, false, line.level);
    if (line.level) sheet.getRow(row).outlineLevel = line.level;
    writeDriverRow(sheet, row, a.lineDrivers[line.key] ?? { method: allowedMethods(line)[0], values: [] }, years, line.revenueLine);
  }

  const notesRow = h + reg.driverLines.length + 2;
  sheet.getCell(notesRow, 1).value =
    'Method: "Growth %" grows last year\'s figure; "% of revenue" applies to that year\'s revenue; "Fixed" is an amount. ' +
    'Percentages are entered as %, Fixed amounts in the model\'s units. Subtotals (gross profit, EBITDA, EBIT, EBT, net income), ' +
    'accounts\' parents, interest (debt schedule) and tax (tax rate) are formulas on the Projections sheet.';
  sheet.getCell(notesRow, 1).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
}

export function writeDriverRow(
  sheet: ExcelJS.Worksheet, row: number, d: LineDriver, years: number, revenueLine?: boolean,
  methodCol = DRIVER_METHOD_COL, firstYearCol = DRIVER_FIRST_YEAR_COL,
) {
  const cells = driverCells(d);
  const m = sheet.getCell(row, methodCol);
  m.value = cells.method;
  m.font = INPUT_FONT;
  m.dataValidation = methodValidation(revenueLine);
  for (let y = 0; y < years; y++) {
    const c = sheet.getCell(row, firstYearCol + y);
    c.value = cells.values[y] ?? 0;
    c.numFmt = cells.numFmt;
    c.font = INPUT_FONT;
  }
}
