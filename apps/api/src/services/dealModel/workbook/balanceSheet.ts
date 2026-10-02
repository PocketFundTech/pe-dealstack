// Balance Sheet (fix plan H3): a net-assets balance sheet at the closing
// date and each projected year, tied to Projections and the Returns debt
// schedule, with a check row that must be 0. Mirrors projectBalanceSheet in
// @ai-crm/shared (deal-model-parity.test.ts checks the numbers agree).
//
// Entry: purchase accounting with a goodwill plug — goodwill = entry EV −
// NWC − PP&E − other net operating assets; equity = sponsor equity − fees
// (expensed at close). Years: PP&E rolls with capex − D&A, goodwill and
// other net assets are held, equity grows by net income (no dividends).

import type ExcelJS from 'exceljs';
import type { OpeningBalances } from '@ai-crm/shared';
import type { Registry } from './registry.js';
import { RETURNS_ROWS as R } from './returns.js';
import {
  SHEETS, FMT_MONEY, INPUT_FONT, colLetter, fx, label, put, styleHeaderRow, title, unitsText, type WorkbookContext,
} from './xlsx.js';

export const BS_ROWS = {
  header: 4,
  cash: 5,
  nwc: 6,
  ppe: 7,
  goodwill: 8,
  otherNet: 9,
  totalNetAssets: 10,
  debt: 12,
  equity: 13,
  totalCapital: 14,
  check: 16,
} as const;

export function writeBalanceSheet(
  sheet: ExcelJS.Worksheet, reg: Registry, opening: OpeningBalances, ctx: WorkbookContext,
) {
  const B = BS_ROWS;
  const P = SHEETS.projections;
  const Rt = SHEETS.returns;
  const years = reg.years;
  const pl = (key: string, col: string) => (reg.pl.row[key] === undefined ? '0' : `${P}!${col}${reg.pl.row[key]}`);
  sheet.columns = [{ width: 40 }, ...Array.from({ length: years + 1 }, () => ({ width: 14 }))];
  title(sheet, 'Balance sheet', `${unitsText(ctx)} — net assets at closing and each projected year; the check row must be 0`);

  const head = sheet.getRow(B.header);
  head.getCell(1).value = 'Net assets';
  head.getCell(2).value = 'Closing';
  for (let y = 0; y < years; y++) head.getCell(3 + y).value = `Y${y + 1}`;
  styleHeaderRow(head);

  label(sheet, B.cash, 'Cash');
  label(sheet, B.nwc, 'Net working capital');
  label(sheet, B.ppe, 'PP&E (net)');
  label(sheet, B.goodwill, 'Goodwill (price paid over net assets bought)');
  label(sheet, B.otherNet, 'Other net operating assets');
  label(sheet, B.totalNetAssets, 'Total net assets', true);
  label(sheet, B.debt, 'Total debt (incl. revolver)');
  label(sheet, B.equity, 'Equity');
  label(sheet, B.totalCapital, 'Total debt + equity', true);
  label(sheet, B.check, 'Check: net assets − (debt + equity) — must be 0', true);

  // ── Closing date (column B) ─────────────────────────────────────
  put(sheet, B.cash, 2, fx(`${Rt}!$B$${R.minCash}`), FMT_MONEY);
  put(sheet, B.nwc, 2, fx(`${P}!B${reg.pl.cf.nwc}`), FMT_MONEY);
  put(sheet, B.ppe, 2, opening.ppe ?? 0, FMT_MONEY).font = INPUT_FONT;
  put(sheet, B.otherNet, 2, opening.otherNet ?? 0, FMT_MONEY).font = INPUT_FONT;
  put(sheet, B.goodwill, 2, fx(`${Rt}!$B$${R.entryEv}-B${B.nwc}-B${B.ppe}-B${B.otherNet}`), FMT_MONEY);
  put(sheet, B.debt, 2, fx(`${Rt}!$B$${R.totalDebt}`), FMT_MONEY);
  put(sheet, B.equity, 2, fx(`${Rt}!$B$${R.equity}-${Rt}!$B$${R.fees}`), FMT_MONEY);

  // ── Projected years ─────────────────────────────────────────────
  for (let y = 0; y < years; y++) {
    const c = colLetter(3 + y);
    const prev = colLetter(2 + y);
    const ret = colLetter(2 + y); // Returns schedule: year y is column 2 + y
    put(sheet, B.cash, 3 + y, fx(`${Rt}!${ret}${R.cashClose}`), FMT_MONEY);
    put(sheet, B.nwc, 3 + y, fx(`${P}!${c}${reg.pl.cf.nwc}`), FMT_MONEY);
    put(sheet, B.ppe, 3 + y, fx(`${prev}${B.ppe}+${P}!${c}${reg.pl.cf.capex}-${pl('da', c)}`), FMT_MONEY);
    put(sheet, B.goodwill, 3 + y, fx(`${prev}${B.goodwill}`), FMT_MONEY);
    put(sheet, B.otherNet, 3 + y, fx(`${prev}${B.otherNet}`), FMT_MONEY);
    put(sheet, B.debt, 3 + y, fx(`${Rt}!${ret}${R.closing}`), FMT_MONEY);
    put(sheet, B.equity, 3 + y, fx(`${prev}${B.equity}+${pl('net_income', c)}`), FMT_MONEY);
  }

  for (let col = 2; col <= 2 + years; col++) {
    const c = colLetter(col);
    put(sheet, B.totalNetAssets, col, fx(`SUM(${c}${B.cash}:${c}${B.otherNet})`), FMT_MONEY).font = { bold: true };
    put(sheet, B.totalCapital, col, fx(`${c}${B.debt}+${c}${B.equity}`), FMT_MONEY).font = { bold: true };
    // Rounded so float dust shows as 0.0, not -0.0.
    put(sheet, B.check, col, fx(`ROUND(${c}${B.totalNetAssets}-${c}${B.totalCapital},6)`), FMT_MONEY).font = { bold: true };
  }
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: B.header }];
}
