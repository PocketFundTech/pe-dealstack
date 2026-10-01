// Historicals: every catalogue line per period. Accounts are plain values
// (history is fact, not model output); parents and subtotals are formulas
// wherever all their lines are present, so a corrected figure flows through.

import type ExcelJS from 'exceljs';
import type { ModelLine } from '@ai-crm/shared';
import type { HistoricalRow } from '../assumptions.js';
import { evaluateLine, rowLines, type LineCatalogue } from '../lineCatalogue.js';
import type { Registry } from './registry.js';
import { writeBalanceHistory } from './balanceHistory.js';
import {
  FMT_MONEY, FMT_PCT, IMPLIED_FONT, colLetter, fx, label, styleHeaderRow, title, unitsText, type WorkbookContext,
} from './xlsx.js';

const SOURCE_TEXT: Record<ModelLine['kind'], string> = {
  INPUT: 'Extracted from source documents',
  COMPUTED: 'Extracted from source documents',
  SUM: 'Sum of its accounts',
  SUBTOTAL: 'Subtotal — formula where all its lines are present',
};

/** Formula for a parent / subtotal in one column, or null if a line is missing. */
export function rollupFormula(line: ModelLine, col: string, reg: Registry, present: (key: string) => boolean): string | null {
  const comps = line.components ?? [];
  if (!comps.length) return null;
  if (line.kind === 'SUM') {
    if (!comps.some((c) => present(c.key))) return null;
    return `SUM(${comps.map((c) => `${col}${reg.pl.row[c.key]}`).join(',')})`;
  }
  if (!comps.every((c) => present(c.key))) return null;
  return comps
    .map((c, i) => `${c.sign < 0 ? '-' : i === 0 ? '' : '+'}${col}${reg.pl.row[c.key]}`)
    .join('');
}

export function writeMarginRows(sheet: ExcelJS.Worksheet, reg: Registry, col: number, guardBlank: boolean) {
  const c = colLetter(col);
  const rev = `${c}${reg.pl.row.revenue}`;
  const rows: Array<[number | null, string]> = [[reg.pl.grossMargin, 'gross_profit'], [reg.pl.ebitdaMargin, 'ebitda']];
  for (const [row, key] of rows) {
    if (row === null) continue;
    const num = `${c}${reg.pl.row[key]}`;
    // Blank EBITDA is "not reported", not 0% — don't print a fake margin.
    const guard = guardBlank ? `OR(${rev}=0,ISBLANK(${num}))` : `${rev}=0`;
    const cell = sheet.getCell(row, col);
    cell.value = fx(`IF(${guard},"",${num}/${rev})`);
    cell.numFmt = FMT_PCT;
  }
}

export function writeHistoricals(
  sheet: ExcelJS.Worksheet,
  history: HistoricalRow[],
  cat: LineCatalogue,
  reg: Registry,
  ctx: WorkbookContext,
): string[] {
  const checks: string[] = [];
  sheet.columns = [{ width: 34 }, ...history.map(() => ({ width: 22 })), { width: 40 }];
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  title(sheet, 'Historicals', unitsText(ctx));

  const header = sheet.getRow(reg.pl.header);
  header.getCell(1).value = 'Period';
  history.forEach((h, i) => { header.getCell(2 + i).value = h.period; });
  header.getCell(2 + history.length).value = 'Source';
  styleHeaderRow(header);

  for (const line of reg.lines) {
    const row = reg.pl.row[line.key];
    label(sheet, row, line.label, line.kind === 'SUBTOTAL', line.level);
    if (line.level) sheet.getRow(row).outlineLevel = line.level;
    sheet.getCell(row, 2 + history.length).value = SOURCE_TEXT[line.kind];
  }

  history.forEach((h, i) => {
    const col = 2 + i;
    const c = colLetter(col);
    const { values, implied } = cat.periods[i];
    const printed = rowLines(h);
    const present = (key: string) => values[key] !== undefined;
    for (const line of reg.lines) {
      const cell = sheet.getCell(reg.pl.row[line.key], col);
      const formula = line.kind === 'SUM' || line.kind === 'SUBTOTAL' ? rollupFormula(line, c, reg, present) : null;
      if (formula) {
        cell.value = fx(formula);
        const computed = evaluateLine(reg.lines, values, line.key);
        const raw = printed[line.key];
        if (typeof raw === 'number' && Math.abs(computed - raw) > Math.max(0.01, Math.abs(raw) * 0.01)) {
          checks.push(`${h.period}: ${line.label} adds up to ${computed.toFixed(2)} from its lines, but the statement prints ${raw.toFixed(2)}.`);
        }
      } else if (present(line.key)) {
        // Missing figures stay BLANK — a gap beats a silent zero.
        cell.value = values[line.key];
        if (implied.includes(line.key)) cell.font = IMPLIED_FONT;
      } else continue;
      cell.numFmt = FMT_MONEY;
    }
    writeMarginRows(sheet, reg, col, true);
  });

  if (reg.pl.grossMargin !== null) label(sheet, reg.pl.grossMargin, 'Gross margin');
  label(sheet, reg.pl.ebitdaMargin, 'EBITDA margin');
  const foot = reg.pl.ebitdaMargin + 2;
  sheet.getCell(foot, 1).value = 'Grey italic figures were not printed — they are implied by the statement (e.g. COGS = revenue − gross profit, operating costs = gross profit − EBITDA).';
  sheet.getCell(foot, 1).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
  writeBalanceHistory(sheet, history, reg, foot + 2);

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: reg.pl.header }];
  return checks;
}
