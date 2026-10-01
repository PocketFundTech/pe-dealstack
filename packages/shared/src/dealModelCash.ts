// ─── Deal model — working capital, capex, debt (fix plan E3) ──────
// The balance-sheet and cash-flow side of the model, shared by the API
// (seeding, scenario summary) and the web panel (live preview).
//
// Working capital (per projected year):
//   DAYS         AR = revenue × DSO / 365, inventory = COGS × DIO / 365,
//                AP = COGS × DPO / 365, NWC = AR + inventory − AP;
//                the base column holds the latest full-year balances.
//   PCT_REVENUE  NWC = revenue × p (base NWC = base revenue × Y1 p) — the
//                pre-E3 behaviour, and the fallback when the balance sheet
//                has no receivables / payables.
//   ΔNWC = NWC_y − NWC_(y−1); an increase is a use of cash.
// Capex: revenue × % (TOTAL), or maintenance % + growth % (SPLIT) when the
// cash flow statement carried both.
//
// Debt: a senior tranche and an optional second tranche, both sized at
// entry (× entry EBITDA, or an amount). Each year:
//   mandatory  = MIN(opening, original × amortisation %)
//   interest   = rate × (opening − mandatory / 2)
//                i.e. on the average balance, with scheduled amortisation
//                paid through the year and the cash sweep at year end. The
//                sweep is not in the average, so interest never depends on
//                the sweep — no circular reference, no iteration.
//   levered FCF = net income + D&A − capex − ΔNWC (after interest and tax)
//   swept cash = MAX(0, opening cash + levered FCF − mandatory − minimum
//                cash) × sweep %, senior first, then the second tranche
//   closing cash = opening cash + levered FCF − mandatory − sweep
// Opening cash is the minimum cash, funded at entry (a use of funds); a
// negative closing cash is a funding shortfall (no revolver is modelled).
// Percentages are percent numbers (5 = 5%), money in millions.

export type NwcMethod = 'DAYS' | 'PCT_REVENUE';
export type CapexMethod = 'TOTAL' | 'SPLIT';

export interface BalanceDrivers {
  nwcMethod: NwcMethod;
  /** Days of revenue / COGS / COGS, one per projected year (DAYS). */
  dso: number[];
  dio: number[];
  dpo: number[];
  /** NWC as % of revenue, one per projected year (PCT_REVENUE). */
  nwcPct: number[];
  capexMethod: CapexMethod;
  /** Capex as % of revenue (TOTAL). */
  capexPct: number[];
  /** Maintenance and growth capex as % of revenue (SPLIT). */
  capexMaintPct: number[];
  capexGrowthPct: number[];
}

export type BalanceSeriesKey = 'dso' | 'dio' | 'dpo' | 'nwcPct' | 'capexPct' | 'capexMaintPct' | 'capexGrowthPct';
export const BALANCE_SERIES_KEYS: BalanceSeriesKey[] = ['dso', 'dio', 'dpo', 'nwcPct', 'capexPct', 'capexMaintPct', 'capexGrowthPct'];

export const BALANCE_SERIES_LABELS: Record<BalanceSeriesKey, { label: string; unit: 'days' | '%' }> = {
  dso: { label: 'DSO (receivable days, of revenue)', unit: 'days' },
  dio: { label: 'DIO (inventory days, of COGS)', unit: 'days' },
  dpo: { label: 'DPO (payable days, of COGS)', unit: 'days' },
  nwcPct: { label: 'Net working capital (% of revenue)', unit: '%' },
  capexPct: { label: 'Capex (% of revenue)', unit: '%' },
  capexMaintPct: { label: 'Maintenance capex (% of revenue)', unit: '%' },
  capexGrowthPct: { label: 'Growth capex (% of revenue)', unit: '%' },
};

/** The per-year series the chosen methods use — the workbook's driver rows. */
export function activeBalanceKeys(bd: Pick<BalanceDrivers, 'nwcMethod' | 'capexMethod'>): BalanceSeriesKey[] {
  return [
    ...(bd.nwcMethod === 'DAYS' ? (['dso', 'dio', 'dpo'] as const) : (['nwcPct'] as const)),
    ...(bd.capexMethod === 'SPLIT' ? (['capexMaintPct', 'capexGrowthPct'] as const) : (['capexPct'] as const)),
  ];
}

/** Latest full-year balance sheet: the base for DAYS working capital and the net debt refinanced at entry. */
export interface OpeningBalances {
  period?: string;
  ar?: number;
  inventory?: number;
  ap?: number;
  cash?: number;
  debt?: number;
}

export const DAYS_IN_YEAR = 365;
/** Pre-E3 defaults — also the fallback when the statements carry no data. */
export const DEFAULT_NWC_PCT = 10;
export const DEFAULT_CAPEX_PCT = 3;

const series = (years: number, v: number) => Array.from({ length: years }, () => v);

/** Pre-E3 scalar NWC / capex % → the equivalent per-year drivers (identical outputs). */
export function legacyBalanceDrivers(years: number, nwcPctRevenue = DEFAULT_NWC_PCT, capexPctRevenue = DEFAULT_CAPEX_PCT): BalanceDrivers {
  return {
    nwcMethod: 'PCT_REVENUE', dso: series(years, 0), dio: series(years, 0), dpo: series(years, 0),
    nwcPct: series(years, nwcPctRevenue),
    capexMethod: 'TOTAL', capexPct: series(years, capexPctRevenue),
    capexMaintPct: series(years, 0), capexGrowthPct: series(years, 0),
  };
}

export interface CashFlowAssumptionFields {
  projectionYears: number;
  balanceDrivers?: BalanceDrivers;
  /** Pre-E3 scalars — used only when balanceDrivers is absent. */
  capexPctRevenue?: number;
  nwcPctRevenue?: number;
}

export function balanceDriversOf(a: CashFlowAssumptionFields): BalanceDrivers {
  return a.balanceDrivers ?? legacyBalanceDrivers(a.projectionYears, a.nwcPctRevenue, a.capexPctRevenue);
}

export interface DebtYear {
  cashOpen: number;
  open1: number; mand1: number; int1: number; sweep1: number; close1: number;
  open2: number; mand2: number; int2: number; sweep2: number; close2: number;
  lfcf: number;
  available: number;
  interest: number;
  closing: number;
  cashClose: number;
}

export interface DebtTerms {
  senior: number; seniorRate: number; seniorAmort: number;
  second: number; secondRate: number; secondAmort: number;
  minCash: number; sweepPct: number;
}

/**
 * Debt schedule, built year by year. `lfcfAt(y)` may call back into
 * `interestAt(y)` (net income needs interest), which only needs the
 * schedule up to y − 1 — the same dependency order as the workbook.
 */
export function debtScheduler(t: DebtTerms, lfcfAt: (y: number) => number) {
  const pct = (v: number) => v / 100;
  const done: DebtYear[] = [];

  const opening = (y: number) => {
    const prev = y > 0 ? ensure(y - 1) : null;
    const open1 = prev ? prev.close1 : t.senior;
    const open2 = prev ? prev.close2 : t.second;
    const mand1 = Math.min(open1, t.senior * pct(t.seniorAmort));
    const mand2 = Math.min(open2, t.second * pct(t.secondAmort));
    return {
      cashOpen: prev ? prev.cashClose : t.minCash,
      open1, mand1, int1: (open1 - mand1 / 2) * pct(t.seniorRate),
      open2, mand2, int2: (open2 - mand2 / 2) * pct(t.secondRate),
    };
  };

  function ensure(y: number): DebtYear {
    for (let i = done.length; i <= y; i++) {
      const o = opening(i);
      const lfcf = lfcfAt(i);
      const available = Math.max(0, o.cashOpen + lfcf - o.mand1 - o.mand2 - t.minCash) * pct(t.sweepPct);
      const sweep1 = Math.min(o.open1 - o.mand1, available);
      const sweep2 = Math.min(o.open2 - o.mand2, available - sweep1);
      const close1 = o.open1 - o.mand1 - sweep1;
      const close2 = o.open2 - o.mand2 - sweep2;
      done.push({
        ...o, lfcf, available, sweep1, sweep2, close1, close2,
        interest: o.int1 + o.int2,
        closing: close1 + close2,
        cashClose: o.cashOpen + lfcf - o.mand1 - o.mand2 - sweep1 - sweep2,
      });
    }
    return done[y];
  }

  return {
    interestAt: (y: number) => { const o = opening(y); return o.int1 + o.int2; },
    year: ensure,
  };
}
