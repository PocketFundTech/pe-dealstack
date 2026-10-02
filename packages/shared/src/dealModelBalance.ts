// ─── Deal model — integrated balance sheet (fix plan H3) ──────────
// A net-assets balance sheet at the closing date and each projected year,
// tied to the model's own cash flow and debt schedule, with a check that
// must be 0 every year. Mirrored by the workbook's Balance Sheet sheet
// (apps/api/.../workbook/balanceSheet.ts); deal-model-parity.test.ts checks
// the two agree.
//
// Entry (closing date), purchase accounting with a goodwill plug:
//   cash          = minimum cash funded at entry (cash-free, debt-free deal)
//   NWC           = the model's base net working capital
//   PP&E          = the seller's latest net PP&E
//   other net     = the seller's other assets − other liabilities
//   goodwill      = entry EV − NWC − PP&E − other net   (the plug)
//   debt          = new debt raised (the revolver starts undrawn)
//   equity        = sponsor equity − transaction fees (expensed at close)
// Each projected year:
//   cash = closing cash (debt schedule); NWC = the model's NWC;
//   PP&E = prior + capex − D&A; goodwill and other net held flat;
//   debt = closing debt incl. revolver; equity = prior + net income
//   (no dividends during the hold).
// It balances by construction: Δcash = levered FCF + Δdebt and levered FCF
// = net income + D&A − capex − ΔNWC, so Δnet assets = net income + Δdebt.
// Money in millions.

import type { CalcAssumptions, ModelProjection } from './dealModel.js';
import type { OpeningBalances } from './dealModelCash.js';

export interface BalanceSheetColumn {
  cash: number;
  nwc: number;
  ppe: number;
  goodwill: number;
  otherNet: number;
  totalNetAssets: number;
  debt: number;
  equity: number;
  totalCapital: number;
  /** Net assets − (debt + equity): 0 when the model is internally consistent. */
  check: number;
}

export interface ProjectedBalanceSheet {
  entry: BalanceSheetColumn;
  years: BalanceSheetColumn[];
}

const column = (c: Omit<BalanceSheetColumn, 'totalNetAssets' | 'totalCapital' | 'check'>): BalanceSheetColumn => {
  const totalNetAssets = c.cash + c.nwc + c.ppe + c.goodwill + c.otherNet;
  const totalCapital = c.debt + c.equity;
  return { ...c, totalNetAssets, totalCapital, check: totalNetAssets - totalCapital };
};

export function projectBalanceSheet(
  p: ModelProjection,
  a: Pick<CalcAssumptions, 'transactionFeesPct'>,
  opening: OpeningBalances = {},
): ProjectedBalanceSheet {
  const fees = p.entryEv * (a.transactionFeesPct / 100);
  const ppe0 = opening.ppe ?? 0;
  const otherNet = opening.otherNet ?? 0;
  const entry = column({
    cash: p.minCash,
    nwc: p.nwcBase,
    ppe: ppe0,
    goodwill: p.entryEv - p.nwcBase - ppe0 - otherNet,
    otherNet,
    debt: p.debt,
    equity: p.equity - fees,
  });

  const years: BalanceSheetColumn[] = [];
  let prev = entry;
  for (let y = 0; y < p.revenue.length; y++) {
    const da = p.values.da?.[y] ?? 0;
    const netIncome = p.values.net_income?.[y] ?? 0;
    const col = column({
      cash: p.cashClosing[y],
      nwc: p.nwc[y],
      ppe: prev.ppe + p.capex[y] - da,
      goodwill: prev.goodwill,
      otherNet: prev.otherNet,
      debt: p.debtClosing[y],
      equity: prev.equity + netIncome,
    });
    years.push(col);
    prev = col;
  }
  return { entry, years };
}
