// Assumptions sheet: blue scalar inputs, then one driver row per P&L line.

import type ExcelJS from 'exceljs';
import {
  BALANCE_SERIES_LABELS, DRIVER_METHOD_LABELS, MODEL_CASES, allowedMethods,
  type LineDriver, type ModelCase,
} from '@ai-crm/shared';
import type { ResolvedAssumptions } from '../assumptions.js';
import type { CaseSet } from '../scenarios.js';
import {
  SCALAR_KEYS, CASE_COLUMNS, SCALAR_CASE_COL, SCALAR_HEADER_ROW, ACTIVE_CASE_ROW, ACTIVE_INDEX_ROW,
  DRIVER_CASE_COL, DRIVER_METHOD_COL, DRIVER_FIRST_YEAR_COL, bsKey, type Registry, type ScalarKey,
} from './registry.js';
import { INPUT_FONT, FMT_MONEY, FMT_PCT, FMT_MULT, colLetter, fx, label, styleHeaderRow, title } from './xlsx.js';

/** Label, cell value and format for a scalar. Percentages are written as fractions. */
export function scalarCell(a: ResolvedAssumptions, key: ScalarKey): [string, number, string] {
  const pct = (v: number) => v / 100;
  const money = `${a.currency}, ${a.unitScale.toLowerCase()}`;
  switch (key) {
    case 'entryMultiple': return [a.entryBasis === 'REVENUE' ? 'Entry multiple (x revenue)' : 'Entry multiple (x EBITDA)', a.entryMultiple, FMT_MULT];
    case 'transactionFeesPct': return ['Transaction fees (% of EV)', pct(a.transactionFeesPct), FMT_PCT];
    case 'debtQuantum': return a.debtQuantumMode === 'ABSOLUTE'
      ? [`Senior debt (${money})`, a.debtQuantum, FMT_MONEY]
      : ['Senior debt (x EBITDA)', a.debtQuantum, FMT_MULT];
    case 'interestRate': return ['Senior interest rate', pct(a.interestRate), FMT_PCT];
    case 'amortPctPerYear': return ['Senior amortisation (% of original / yr)', pct(a.amortPctPerYear), FMT_PCT];
    case 'debt2Quantum': return a.debtQuantumMode === 'ABSOLUTE'
      ? [`Second tranche debt (${money})`, a.debt2Quantum, FMT_MONEY]
      : ['Second tranche debt (x EBITDA)', a.debt2Quantum, FMT_MULT];
    case 'debt2InterestRate': return ['Second tranche interest rate', pct(a.debt2InterestRate), FMT_PCT];
    case 'debt2AmortPct': return ['Second tranche amortisation (% of original / yr)', pct(a.debt2AmortPct), FMT_PCT];
    case 'cashSweepPct': return ['Cash sweep (% of cash above minimum)', pct(a.cashSweepPct), FMT_PCT];
    case 'minCash': return [`Minimum cash (${money})`, a.minCash, FMT_MONEY];
    case 'revolverSize': return [`Revolver commitment (${money}; 0 = none)`, a.revolverSize, FMT_MONEY];
    case 'revolverRate': return ['Revolver interest rate (on drawn)', pct(a.revolverRate), FMT_PCT];
    case 'revolverFeePct': return ['Revolver undrawn fee', pct(a.revolverFeePct), FMT_PCT];
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

export function writeAssumptions(sheet: ExcelJS.Worksheet, cases: CaseSet, active: ModelCase, reg: Registry) {
  const years = reg.years;
  const a = cases.Base; // structure (entry basis, debt mode, years) is the Base case's
  sheet.columns = [{ width: 34 }, { width: 12 }, { width: 14 }, ...Array.from({ length: Math.max(years, 2) }, () => ({ width: 11 }))];
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  title(sheet, 'Assumptions', 'Blue cells are inputs. Pick the Active case — every other sheet follows it; the Scenarios sheet shows all three.');

  // ── Active case switch ───────────────────────────────────────
  label(sheet, ACTIVE_CASE_ROW, 'Active case', true);
  const activeCell = sheet.getCell(ACTIVE_CASE_ROW, 2);
  activeCell.value = active;
  activeCell.font = { ...INPUT_FONT, bold: true };
  activeCell.dataValidation = { type: 'list', allowBlank: false, formulae: [`"${MODEL_CASES.join(',')}"`] };
  label(sheet, ACTIVE_INDEX_ROW, 'Active case number');
  const caseHeaders = `$${colLetter(SCALAR_CASE_COL.Low)}$${SCALAR_HEADER_ROW}:$${colLetter(SCALAR_CASE_COL.High)}$${SCALAR_HEADER_ROW}`;
  sheet.getCell(ACTIVE_INDEX_ROW, 2).value = fx(`MATCH($B$${ACTIVE_CASE_ROW},${caseHeaders},0)`);
  const idx = `$B$${ACTIVE_INDEX_ROW}`;

  // ── Scalars: Low | Base | High | Live ─────────────────────────
  const head = sheet.getRow(SCALAR_HEADER_ROW);
  head.getCell(1).value = 'Assumption';
  for (const c of CASE_COLUMNS) head.getCell(SCALAR_CASE_COL[c]).value = c;
  styleHeaderRow(head);
  for (const key of SCALAR_KEYS) {
    const row = reg.assumptions.scalarRow[key];
    const [name, , fmt] = scalarCell(a, key);
    label(sheet, row, name);
    for (const c of MODEL_CASES) {
      const cell = sheet.getCell(row, SCALAR_CASE_COL[c]);
      cell.value = scalarCell(cases[c], key)[1];
      cell.numFmt = fmt;
      cell.font = INPUT_FONT;
    }
    const live = sheet.getCell(row, SCALAR_CASE_COL.Live);
    live.value = fx(`CHOOSE(${idx},${MODEL_CASES.map((c) => `${colLetter(SCALAR_CASE_COL[c])}${row}`).join(',')})`);
    live.numFmt = fmt;
    live.font = { bold: true };
  }

  // ── Per-line drivers: Low / Base / High rows + a Live row ─────
  const h = reg.assumptions.driverHeaderRow;
  const dh = sheet.getRow(h);
  dh.getCell(1).value = 'P&L drivers by line';
  dh.getCell(DRIVER_CASE_COL).value = 'Case';
  dh.getCell(DRIVER_METHOD_COL).value = 'Method';
  for (let y = 0; y < years; y++) dh.getCell(DRIVER_FIRST_YEAR_COL + y).value = `Y${y + 1}`;
  styleHeaderRow(dh);

  for (const line of reg.driverLines) {
    const rows = reg.assumptions.driverRow[line.key];
    for (const c of CASE_COLUMNS) {
      const row = rows[c];
      label(sheet, row, line.label, c === 'Live', line.level);
      sheet.getCell(row, DRIVER_CASE_COL).value = c;
      if (line.level) sheet.getRow(row).outlineLevel = line.level;
      if (c !== 'Live') {
        writeDriverRow(sheet, row, cases[c].lineDrivers[line.key] ?? { method: allowedMethods(line)[0], values: [] }, years, line.revenueLine);
        continue;
      }
      const base = driverCells(cases.Base.lineDrivers[line.key] ?? { method: 'FIXED', values: [] });
      for (let col = DRIVER_METHOD_COL; col < DRIVER_FIRST_YEAR_COL + years; col++) {
        const L = colLetter(col);
        const cell = sheet.getCell(row, col);
        cell.value = fx(`CHOOSE(${idx},${MODEL_CASES.map((x) => `${L}${rows[x]}`).join(',')})`);
        cell.font = { bold: true };
        if (col >= DRIVER_FIRST_YEAR_COL) cell.numFmt = base.numFmt;
      }
    }
  }

  writeBalanceDrivers(sheet, cases, reg, idx);

  const notesRow = reg.assumptions.notesRow;
  sheet.getCell(notesRow + 1, 1).value =
    'Working capital: "Days" projects receivables = revenue x DSO / 365, inventory = COGS x DIO / 365 and payables = COGS x DPO / 365; ' +
    '"% of revenue" holds net working capital at a share of revenue. Capex is a % of revenue (maintenance + growth when the cash flow split them). ' +
    'Methods are chosen in the app and shared by all three cases.';
  sheet.getCell(notesRow + 1, 1).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
  sheet.getCell(notesRow, 1).value =
    'Method: "Growth %" grows last year\'s figure; "% of revenue" applies to that year\'s revenue; "Fixed" is an amount. ' +
    'Percentages are entered as %, Fixed amounts in the model\'s units. Subtotals (gross profit, EBITDA, EBIT, EBT, net income), ' +
    'accounts\' parents, interest (debt schedule) and tax (tax rate) are formulas on the Projections sheet. ' +
    'Live = the Active case\'s value; edit the Low / Base / High rows, not Live.';
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

/** Days and percentages per working-capital / capex series: Low / Base / High rows + a Live row. */
function writeBalanceDrivers(sheet: ExcelJS.Worksheet, cases: CaseSet, reg: Registry, idx: string) {
  const h = sheet.getRow(reg.assumptions.balanceHeaderRow);
  h.getCell(1).value = 'Working capital & capex drivers';
  h.getCell(DRIVER_CASE_COL).value = 'Case';
  h.getCell(DRIVER_METHOD_COL).value = 'Unit';
  for (let y = 0; y < reg.years; y++) h.getCell(DRIVER_FIRST_YEAR_COL + y).value = `Y${y + 1}`;
  styleHeaderRow(h);

  for (const key of reg.balanceKeys) {
    const rows = reg.assumptions.driverRow[bsKey(key)];
    const { label: name, unit } = BALANCE_SERIES_LABELS[key];
    const fmt = unit === 'days' ? '0.0' : '0.00%';
    for (const c of CASE_COLUMNS) {
      const row = rows[c];
      label(sheet, row, name, c === 'Live');
      sheet.getCell(row, DRIVER_CASE_COL).value = c;
      sheet.getCell(row, DRIVER_METHOD_COL).value = unit === 'days' ? 'Days' : '% of revenue';
      for (let y = 0; y < reg.years; y++) {
        const cell = sheet.getCell(row, DRIVER_FIRST_YEAR_COL + y);
        if (c === 'Live') {
          const L = colLetter(DRIVER_FIRST_YEAR_COL + y);
          cell.value = fx(`CHOOSE(${idx},${MODEL_CASES.map((x) => `${L}${rows[x]}`).join(',')})`);
          cell.font = { bold: true };
        } else {
          cell.value = balanceCellValue(cases[c].balanceDrivers[key], y, unit);
          cell.font = INPUT_FONT;
        }
        cell.numFmt = fmt;
      }
    }
  }
}

/** Days as numbers, percentages as fractions. */
export function balanceCellValue(values: number[], y: number, unit: 'days' | '%'): number {
  const v = values[y] ?? values.at(-1) ?? 0;
  return unit === 'days' ? v : v / 100;
}
