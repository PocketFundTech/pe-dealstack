// Historicals: the balance-sheet and cash-flow items the model reads (fix
// plan E3), under the P&L, with the days / capex ratios the drivers were
// seeded from as formulas — full fiscal years only (a 9-month revenue
// against a period-end balance would overstate the days).

import type ExcelJS from 'exceljs';
import type { HistoricalRow } from '../assumptions.js';
import type { BalanceItems } from '../balanceItems.js';
import { isFullYearRow } from '../basePeriod.js';
import type { Registry } from './registry.js';
import { FMT_MONEY, FMT_PCT, colLetter, fx, label, put } from './xlsx.js';

const ITEMS: Array<[keyof BalanceItems, string, number?]> = [
  ['ar', 'Accounts receivable'],
  ['inventory', 'Inventory'],
  ['ap', 'Accounts payable'],
  ['ppe', 'PP&E (net)'],
  ['cash', 'Cash'],
  ['stDebt', 'Short-term debt'],
  ['ltDebt', 'Long-term debt'],
  ['debt', 'Total debt'],
  ['capex', 'Capex (cash flow; shown as a positive amount)'],
  ['capexMaintenance', 'Maintenance capex', 1],
  ['capexGrowth', 'Growth capex', 1],
];

/** Writes the block from `start`; returns the next free row. */
export function writeBalanceHistory(sheet: ExcelJS.Worksheet, history: HistoricalRow[], reg: Registry, start: number): number {
  const present = ITEMS.filter(([k]) => history.some((h) => h.balance?.[k] !== undefined));
  if (!present.length) return start;
  label(sheet, start, 'Balance sheet & cash flow', true);
  const rowOf: Partial<Record<keyof BalanceItems, number>> = {};
  present.forEach(([k, text, indent], i) => {
    const row = start + 1 + i;
    rowOf[k] = row;
    label(sheet, row, text, false, indent ?? 0);
    history.forEach((h, j) => {
      const v = h.balance?.[k];
      if (v !== undefined) put(sheet, row, 2 + j, v, FMT_MONEY);
    });
  });

  // Ratios the drivers were seeded from, full years only.
  const ratios: Array<[string, keyof BalanceItems, string | undefined, string, string]> = [
    ['DSO (days)', 'ar', 'revenue', '*365', '0.0'],
    ['DIO (days of COGS)', 'inventory', 'cogs', '*365', '0.0'],
    ['DPO (days of COGS)', 'ap', 'cogs', '*365', '0.0'],
    ['Capex (% of revenue)', 'capex', 'revenue', '', FMT_PCT],
  ];
  let row = start + present.length + 1;
  for (const [text, item, denomKey, scale, fmt] of ratios) {
    const denom = denomKey ? reg.pl.row[denomKey] : undefined;
    if (rowOf[item] === undefined || denom === undefined) continue;
    label(sheet, row, text);
    history.forEach((h, j) => {
      if (!isFullYearRow(h) || h.balance?.[item] === undefined) return;
      const c = colLetter(2 + j);
      put(sheet, row, 2 + j, fx(`IF(${c}${denom}=0,"",${c}${rowOf[item]}/${c}${denom}${scale})`), fmt);
    });
    row++;
  }
  sheet.getCell(row, 1).value = 'Ratios are shown for full fiscal years only — they seed the working capital and capex drivers.';
  sheet.getCell(row, 1).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
  return row + 1;
}
