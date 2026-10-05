// Cash-flow block (fix plan E3): working capital balances, ΔNWC, capex,
// unlevered and levered FCF — under the P&L on Projections and inside each
// Scenarios block, from the same builders. Every projected cell is a
// formula on the block's own P&L rows and the Live (or one case's) drivers.
//
//   AR  = revenue × DSO / 365      inventory = COGS × DIO / 365
//   AP  = COGS × DPO / 365         NWC = AR + inventory − AP   (Days)
//   NWC = revenue × NWC %                                     (% of revenue)
//   ΔNWC = NWC − prior NWC; capex = revenue × capex % (or maintenance + growth)
//   Unlevered FCF = EBIT × (1 − tax) + D&A − capex − ΔNWC   (DCF)
//   Levered FCF   = net income + D&A − capex − ΔNWC         (cash sweep)

import type ExcelJS from 'exceljs';
import type { DriverRefs } from './projections.js';
import { bsKey, type BalanceMethods, type CfKey } from './registry.js';
import { FMT_MONEY, colLetter, fx, label, put } from './xlsx.js';

export const CF_LABELS: Record<CfKey, string> = {
  ar: 'Accounts receivable',
  inventory: 'Inventory',
  ap: 'Accounts payable',
  nwc: 'Net working capital',
  dNwc: 'Increase / (decrease) in NWC',
  capexMaint: 'Maintenance capex',
  capexGrowth: 'Growth capex',
  capex: 'Capex',
  ufcf: 'Unlevered FCF',
  lfcf: 'Levered FCF (after interest and tax)',
};

export interface CashFlowBlock {
  rows: Partial<Record<CfKey, number>>;
  methods: BalanceMethods;
  /** P&L row of a line in the same sheet (undefined when the catalogue has no such line). */
  line: (key: string) => number | undefined;
  refs: DriverRefs;
  years: number;
  /** Base-column (B) receivables / inventory / payables under Days: values or references. */
  baseBalance: (k: 'ar' | 'inventory' | 'ap') => ExcelJS.CellValue;
  /** Blue input font for base values. */
  baseFont?: Partial<ExcelJS.Font>;
}

/** Formula for one cash-flow row in projected year y (column `col`, prior column `prev`). */
export function cashFlowFormula(k: CfKey, y: number, col: string, prev: string, b: CashFlowBlock): string {
  const r = (key: CfKey) => `${col}${b.rows[key]}`;
  const pl = (key: string) => { const row = b.line(key); return row === undefined ? '0' : `${col}${row}`; };
  const v = (s: Parameters<typeof bsKey>[0]) => b.refs.value(bsKey(s), y);
  switch (k) {
    case 'ar': return `${pl('revenue')}*${v('dso')}/365`;
    case 'inventory': return `${pl('cogs')}*${v('dio')}/365`;
    case 'ap': return `${pl('cogs')}*${v('dpo')}/365`;
    case 'nwc': return b.methods.nwcMethod === 'DAYS' ? `${r('ar')}+${r('inventory')}-${r('ap')}` : `${pl('revenue')}*${v('nwcPct')}`;
    case 'dNwc': return `${r('nwc')}-${prev}${b.rows.nwc}`;
    case 'capexMaint': return `${pl('revenue')}*${v('capexMaintPct')}`;
    case 'capexGrowth': return `${pl('revenue')}*${v('capexGrowthPct')}`;
    case 'capex': return b.methods.capexMethod === 'SPLIT' ? `${r('capexMaint')}+${r('capexGrowth')}` : `${pl('revenue')}*${v('capexPct')}`;
    case 'ufcf': return `${pl('ebit')}*(1-${b.refs.scalar('taxRate')})+${pl('da')}-${r('capex')}-${r('dNwc')}`;
    case 'lfcf': return `${pl('net_income')}+${pl('da')}-${r('capex')}-${r('dNwc')}`;
  }
}

/** Labels, the base column (B) and projected columns (C..) of a cash-flow block. */
export function writeCashFlowBlock(sheet: ExcelJS.Worksheet, b: CashFlowBlock) {
  for (const [k, row] of Object.entries(b.rows) as Array<[CfKey, number]>) {
    label(sheet, row, CF_LABELS[k], k === 'ufcf' || k === 'lfcf', k === 'capexMaint' || k === 'capexGrowth' ? 1 : 0);

    // Base column: opening balances (Days) or base revenue × Y1 NWC % — what ΔNWC in Y1 is measured from.
    if (b.methods.nwcMethod === 'DAYS' && (k === 'ar' || k === 'inventory' || k === 'ap')) {
      const cell = put(sheet, row, 2, b.baseBalance(k), FMT_MONEY);
      if (b.baseFont) cell.font = b.baseFont;
    } else if (k === 'nwc') {
      put(sheet, row, 2, fx(cashFlowFormula('nwc', 0, 'B', 'B', b)), FMT_MONEY);
    }

    for (let y = 0; y < b.years; y++) {
      put(sheet, row, 3 + y, fx(cashFlowFormula(k, y, colLetter(3 + y), colLetter(2 + y), b)), FMT_MONEY);
    }
  }
}
