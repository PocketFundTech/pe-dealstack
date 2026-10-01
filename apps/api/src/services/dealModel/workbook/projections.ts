// Projections: column B is the base period (LTM or last full year — never a
// YTD) carried in as values; every projected cell is a live formula driven
// by the line's driver on Assumptions. Parents are sums of their accounts,
// subtotals are formulas, interest comes from the debt schedule and tax from
// the tax rate. Below the P&L, the cash-flow block (fix plan E3): working
// capital, capex, unlevered and levered FCF (workingCapital.ts).

import type ExcelJS from 'exceljs';
import { DRIVER_METHOD_LABELS, type ModelLine, type OpeningBalances } from '@ai-crm/shared';
import type { ResolvedAssumptions } from '../assumptions.js';
import type { BasePeriod } from '../basePeriod.js';
import type { BaseColumn } from '../lineCatalogue.js';
import type { Registry, ScalarKey } from './registry.js';
import { RETURNS_ROWS } from './returns.js';
import {
  SHEETS, FMT_MONEY, INPUT_FONT, colLetter, fx, label, styleHeaderRow, title, unitsText, type WorkbookContext,
} from './xlsx.js';
import { writeMarginRows } from './historicals.js';
import { writeCashFlowBlock } from './workingCapital.js';

/** Where a block's formulas read drivers and scalars from. */
export interface DriverRefs {
  method(key: string): string;
  value(key: string, y: number): string;
  scalar(name: ScalarKey): string;
  /** Interest for projected year y (debt schedule). Omit for blocks that stop at EBIT. */
  interest?(y: number): string;
}

/** Formula for one line in one projected column, or null for history-only rows. */
export function projectedLineFormula(
  line: ModelLine, y: number, col: string, prev: string, row: (key: string) => number, refs: DriverRefs,
): string | null {
  if (line.historicalOnly) return null;
  const at = (key: string, c = col) => `${c}${row(key)}`;
  switch (line.kind) {
    case 'INPUT': {
      const m = refs.method(line.key);
      const v = refs.value(line.key, y);
      // Revenue accounts never reference the revenue row: it is their sum, and
      // even an untaken IF branch is a circular reference to Google Sheets.
      if (line.revenueLine) return `IF(${m}="${DRIVER_METHOD_LABELS.GROWTH}",${at(line.key, prev)}*(1+${v}),${v})`;
      return `IF(${m}="${DRIVER_METHOD_LABELS.GROWTH}",${at(line.key, prev)}*(1+${v}),` +
        `IF(${m}="${DRIVER_METHOD_LABELS.PCT_REVENUE}",${at('revenue')}*${v},${v}))`;
    }
    case 'SUM':
      return `SUM(${(line.components ?? []).map((c) => at(c.key)).join(',')})`;
    case 'SUBTOTAL':
      return (line.components ?? [])
        .map((c, i) => `${c.sign < 0 ? '-' : i === 0 ? '' : '+'}${at(c.key)}`)
        .join('') || '0';
    case 'COMPUTED':
      if (line.computed === 'TAX') return `MAX(0,${at('ebt')})*${refs.scalar('taxRate')}`;
      return refs.interest ? refs.interest(y) : null;
  }
}

/** Live refs: the Assumptions inputs the main model runs on. */
export function liveRefs(reg: Registry): DriverRefs {
  return {
    method: reg.method,
    value: reg.value,
    scalar: reg.scalar,
    interest: (y) => `${SHEETS.returns}!${colLetter(2 + y)}${RETURNS_ROWS.interest}`,
  };
}

export function writeProjections(
  sheet: ExcelJS.Worksheet,
  a: ResolvedAssumptions,
  reg: Registry,
  base: BasePeriod | null,
  baseCol: BaseColumn,
  opening: OpeningBalances,
  ctx: WorkbookContext,
) {
  const years = a.projectionYears;
  sheet.columns = [{ width: 34 }, { width: 22 }, ...Array.from({ length: years }, () => ({ width: 14 }))];
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  title(sheet, 'Projections', `${unitsText(ctx)} — every projected figure derives from Assumptions`);

  const header = sheet.getRow(reg.pl.header);
  header.getCell(1).value = 'Period';
  header.getCell(2).value = base ? base.label : 'Base';
  for (let y = 0; y < years; y++) header.getCell(3 + y).value = `Y${y + 1}`;
  styleHeaderRow(header);

  const row = (key: string) => reg.pl.row[key];
  const refs = liveRefs(reg);

  for (const line of reg.lines) {
    const r = row(line.key);
    label(sheet, r, line.label, line.kind === 'SUBTOTAL', line.level);
    if (line.level) sheet.getRow(r).outlineLevel = line.level;
    if (line.historicalOnly) continue;

    // Column B: the base period. Inputs are values (blue — the entry basis
    // can be corrected here); parents and subtotals stay formulas.
    const b = sheet.getCell(r, 2);
    if (line.kind === 'SUM' || line.kind === 'SUBTOTAL') {
      b.value = fx(projectedLineFormula(line, 0, 'B', 'B', row, refs)!);
    } else if (typeof baseCol.values[line.key] === 'number') {
      b.value = baseCol.values[line.key];
      if (line.kind === 'INPUT') b.font = INPUT_FONT;
    }
    b.numFmt = FMT_MONEY;

    for (let y = 0; y < years; y++) {
      const formula = projectedLineFormula(line, y, colLetter(3 + y), colLetter(2 + y), row, refs);
      if (!formula) continue;
      const cell = sheet.getCell(r, 3 + y);
      cell.value = fx(formula);
      cell.numFmt = FMT_MONEY;
    }
  }

  if (reg.pl.grossMargin !== null) label(sheet, reg.pl.grossMargin, 'Gross margin');
  label(sheet, reg.pl.ebitdaMargin, 'EBITDA margin');
  for (let col = 2; col <= 2 + years; col++) writeMarginRows(sheet, reg, col, false);

  label(sheet, reg.pl.cfHeader, reg.methods.nwcMethod === 'DAYS'
    ? `Cash flow — working capital from the ${opening.period ?? 'latest'} balance sheet (blue), then DSO / DIO / DPO`
    : 'Cash flow — working capital as % of revenue', true);
  writeCashFlowBlock(sheet, {
    rows: reg.pl.cf, methods: reg.methods, line: (key) => reg.pl.row[key], refs, years,
    baseBalance: (k) => opening[k] ?? 0, baseFont: INPUT_FONT,
  });

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: reg.pl.header }];
}
