// Shared exceljs helpers for the deal-model workbook sheets.

import type ExcelJS from 'exceljs';

export const SHEETS = {
  cover: 'Cover',
  assumptions: 'Assumptions',
  historicals: 'Historicals',
  projections: 'Projections',
  returns: 'Returns',
  sensitivity: 'Sensitivity',
  notes: 'Notes',
} as const;

// Banking convention: blue text = an input you may change.
export const INPUT_FONT = { color: { argb: 'FF0000CC' } } as const;
export const IMPLIED_FONT = { italic: true, color: { argb: 'FF6B7280' } } as const;
export const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
export const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } } as const;

export const FMT_MONEY = '#,##0.0;(#,##0.0)';
export const FMT_PCT = '0.0%';
export const FMT_MULT = '0.0"x"';

export interface WorkbookContext {
  dealName: string;
  companyName?: string | null;
  currency: string;
  unitScale: 'MILLIONS' | 'THOUSANDS';
  sourceDocuments: string[];
  generatedAt: string;
  notes: string[];
  /** Deal.ebitda (millions) — used as entry EBITDA only when the base period has none. */
  fallbackEntryEbitda?: number | null;
}

export function colLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function fx(formula: string): ExcelJS.CellFormulaValue {
  return { formula } as ExcelJS.CellFormulaValue;
}

export function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
}

export function label(sheet: ExcelJS.Worksheet, row: number, text: string, bold = false, indent = 0) {
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  if (bold) cell.font = { bold: true };
  if (indent) cell.alignment = { indent };
  return cell;
}

export function title(sheet: ExcelJS.Worksheet, text: string, subtitle?: string) {
  sheet.getCell('A1').value = text;
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  if (subtitle) {
    sheet.getCell('A2').value = subtitle;
    sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
  }
}

export function unitsText(ctx: WorkbookContext): string {
  return `${ctx.currency} in ${ctx.unitScale === 'MILLIONS' ? 'millions' : 'thousands'}`;
}

/** Write a formula / value with a number format. */
export function put(sheet: ExcelJS.Worksheet, row: number, col: number, value: ExcelJS.CellValue, numFmt?: string) {
  const cell = sheet.getCell(row, col);
  cell.value = value;
  if (numFmt) cell.numFmt = numFmt;
  return cell;
}
