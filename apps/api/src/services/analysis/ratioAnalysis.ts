/**
 * Financial Ratio Analysis
 * 18 ratios across 4 categories + DuPont decomposition.
 */

import { PreparedData, RatioGroup, Ratio, DuPontDecomposition } from './types.js';
import { li, safeDiv, round2, comparableTrend, ebitdaOf } from './helpers.js';

export function computeRatios(data: PreparedData): RatioGroup[] {
  const { income, balance, cashflow, periods } = data;
  const groups: RatioGroup[] = [];

  const byPeriod = (fn: (p: string) => number | null): { period: string; value: number | null }[] =>
    periods.map(p => ({ period: p, value: round2(fn(p)) }));

  // ── 1. Profitability Ratios ──
  const profitability: Ratio[] = [
    {
      name: 'Gross Margin',
      key: 'gross_margin',
      periods: byPeriod(p => {
        const rev = li(income.get(p) ?? {}, 'revenue');
        const gp = li(income.get(p) ?? {}, 'gross_profit');
        return safeDiv(gp, rev) != null ? safeDiv(gp, rev)! * 100 : null;
      }),
      benchmark: { low: 30, mid: 45, high: 65 },
      unit: '%',
      trend: 'insufficient',
      description: 'Gross Profit / Revenue — measures pricing power and COGS efficiency',
    },
    {
      name: 'EBITDA Margin',
      key: 'ebitda_margin',
      periods: byPeriod(p => {
        const rev = li(income.get(p) ?? {}, 'revenue');
        const ebitda = ebitdaOf(income.get(p) ?? {});
        if (safeDiv(ebitda, rev) != null) return safeDiv(ebitda, rev)! * 100;
        return li(income.get(p) ?? {}, 'ebitda_margin_pct');
      }),
      benchmark: { low: 10, mid: 20, high: 35 },
      unit: '%',
      trend: 'insufficient',
      description: 'EBITDA / Revenue — core operating profitability before D&A, interest, tax',
    },
    {
      name: 'Net Profit Margin',
      key: 'net_margin',
      periods: byPeriod(p => {
        const rev = li(income.get(p) ?? {}, 'revenue');
        const ni = li(income.get(p) ?? {}, 'net_income');
        return safeDiv(ni, rev) != null ? safeDiv(ni, rev)! * 100 : null;
      }),
      benchmark: { low: 5, mid: 12, high: 25 },
      unit: '%',
      trend: 'insufficient',
      description: 'Net Income / Revenue — bottom-line profitability',
    },
    {
      name: 'Return on Assets',
      key: 'roa',
      periods: byPeriod(p => {
        const ni = li(income.get(p) ?? {}, 'net_income');
        const ta = li(balance.get(p) ?? {}, 'total_assets');
        return safeDiv(ni, ta) != null ? safeDiv(ni, ta)! * 100 : null;
      }),
      benchmark: { low: 3, mid: 8, high: 15 },
      unit: '%',
      trend: 'insufficient',
      description: 'Net Income / Total Assets — asset utilization efficiency',
    },
    {
      name: 'Return on Equity',
      key: 'roe',
      periods: byPeriod(p => {
        const ni = li(income.get(p) ?? {}, 'net_income');
        const eq = li(balance.get(p) ?? {}, 'total_equity');
        return safeDiv(ni, eq) != null ? safeDiv(ni, eq)! * 100 : null;
      }),
      benchmark: { low: 8, mid: 15, high: 25 },
      unit: '%',
      trend: 'insufficient',
      description: 'Net Income / Total Equity — return to shareholders',
    },
  ];

  profitability.forEach(r => {
    r.trend = comparableTrend(data, r.periods);
  });
  groups.push({ category: 'Profitability', icon: 'monitoring', ratios: profitability });

  // ── 2. Liquidity Ratios ──
  const liquidity: Ratio[] = [
    {
      name: 'Current Ratio',
      key: 'current_ratio',
      periods: byPeriod(p => {
        const ca = li(balance.get(p) ?? {}, 'total_current_assets');
        const cl = li(balance.get(p) ?? {}, 'total_current_liabilities');
        return safeDiv(ca, cl);
      }),
      benchmark: { low: 1.0, mid: 1.5, high: 2.5 },
      unit: 'x',
      trend: 'insufficient',
      description: 'Current Assets / Current Liabilities — short-term solvency',
    },
    {
      name: 'Quick Ratio',
      key: 'quick_ratio',
      periods: byPeriod(p => {
        const bal = balance.get(p) ?? {};
        const ca = li(bal, 'total_current_assets');
        const inv = li(bal, 'inventory') ?? 0;
        const cl = li(bal, 'total_current_liabilities');
        if (ca == null || cl == null || cl === 0) return null;
        return round2((ca - inv) / cl);
      }),
      benchmark: { low: 0.8, mid: 1.2, high: 2.0 },
      unit: 'x',
      trend: 'insufficient',
      description: '(Current Assets - Inventory) / Current Liabilities — liquid solvency',
    },
    {
      name: 'Cash Ratio',
      key: 'cash_ratio',
      periods: byPeriod(p => {
        const cash = li(balance.get(p) ?? {}, 'cash');
        const cl = li(balance.get(p) ?? {}, 'total_current_liabilities');
        return safeDiv(cash, cl);
      }),
      benchmark: { low: 0.1, mid: 0.3, high: 0.8 },
      unit: 'x',
      trend: 'insufficient',
      description: 'Cash / Current Liabilities — immediate payment ability',
    },
  ];

  liquidity.forEach(r => { r.trend = comparableTrend(data, r.periods); });
  groups.push({ category: 'Liquidity', icon: 'water_drop', ratios: liquidity });

  // ── 3. Leverage Ratios ──
  const leverage: Ratio[] = [
    {
      name: 'Debt-to-Equity',
      key: 'debt_to_equity',
      periods: byPeriod(p => {
        const bal = balance.get(p) ?? {};
        const debt = (li(bal, 'short_term_debt') ?? 0) + (li(bal, 'long_term_debt') ?? 0);
        const eq = li(bal, 'total_equity');
        return safeDiv(debt, eq);
      }),
      benchmark: { low: 0.3, mid: 1.0, high: 2.5 },
      unit: 'x',
      trend: 'insufficient',
      description: 'Total Debt / Total Equity — capital structure risk',
    },
    {
      name: 'Net Debt / EBITDA',
      key: 'net_debt_ebitda',
      periods: byPeriod(p => {
        const bal = balance.get(p) ?? {};
        const debt = (li(bal, 'short_term_debt') ?? 0) + (li(bal, 'long_term_debt') ?? 0);
        const cash = li(bal, 'cash') ?? 0;
        const ebitda = ebitdaOf(income.get(p) ?? {});
        return safeDiv(debt - cash, ebitda);
      }),
      benchmark: { low: 0.5, mid: 2.5, high: 4.5 },
      unit: 'x',
      trend: 'insufficient',
      description: '(Total Debt - Cash) / EBITDA — leveraged buyout capacity',
    },
    {
      name: 'Interest Coverage',
      key: 'interest_coverage',
      periods: byPeriod(p => {
        const ebit = li(income.get(p) ?? {}, 'ebit');
        const interest = li(income.get(p) ?? {}, 'interest_expense');
        return safeDiv(ebit, interest);
      }),
      benchmark: { low: 2.0, mid: 5.0, high: 10.0 },
      unit: 'x',
      trend: 'insufficient',
      description: 'EBIT / Interest Expense — ability to service debt',
    },
    {
      name: 'Debt-to-Assets',
      key: 'debt_to_assets',
      periods: byPeriod(p => {
        const bal = balance.get(p) ?? {};
        const tl = li(bal, 'total_liabilities');
        const ta = li(bal, 'total_assets');
        return safeDiv(tl, ta);
      }),
      benchmark: { low: 0.2, mid: 0.5, high: 0.7 },
      unit: 'x',
      trend: 'insufficient',
      description: 'Total Liabilities / Total Assets — overall indebtedness',
    },
  ];

  leverage.forEach(r => { r.trend = comparableTrend(data, r.periods); });
  groups.push({ category: 'Leverage', icon: 'balance', ratios: leverage });

  // ── 4. Efficiency Ratios ──
  const efficiency: Ratio[] = [
    {
      name: 'Asset Turnover',
      key: 'asset_turnover',
      periods: byPeriod(p => {
        const rev = li(income.get(p) ?? {}, 'revenue');
        const ta = li(balance.get(p) ?? {}, 'total_assets');
        return safeDiv(rev, ta);
      }),
      benchmark: { low: 0.3, mid: 0.8, high: 1.5 },
      unit: 'x',
      trend: 'insufficient',
      description: 'Revenue / Total Assets — how efficiently assets generate revenue',
    },
    {
      name: 'Days Sales Outstanding',
      key: 'dso',
      periods: byPeriod(p => {
        const ar = li(balance.get(p) ?? {}, 'accounts_receivable');
        const rev = li(income.get(p) ?? {}, 'revenue');
        if (ar == null || rev == null || rev === 0) return null;
        return round2((ar / rev) * 365);
      }),
      benchmark: { low: 25, mid: 45, high: 75 },
      unit: 'days',
      trend: 'insufficient',
      description: '(AR / Revenue) × 365 — average collection period',
    },
    {
      name: 'Days Payable Outstanding',
      key: 'dpo',
      periods: byPeriod(p => {
        const ap = li(balance.get(p) ?? {}, 'accounts_payable');
        const cogs = li(income.get(p) ?? {}, 'cogs');
        if (ap == null || cogs == null || cogs === 0) return null;
        return round2((ap / cogs) * 365);
      }),
      benchmark: { low: 20, mid: 40, high: 70 },
      unit: 'days',
      trend: 'insufficient',
      description: '(AP / COGS) × 365 — average payment period',
    },
    {
      name: 'Days Inventory Outstanding',
      key: 'dio',
      periods: byPeriod(p => {
        const inv = li(balance.get(p) ?? {}, 'inventory');
        const cogs = li(income.get(p) ?? {}, 'cogs');
        if (inv == null || cogs == null || cogs === 0) return null;
        return round2((inv / cogs) * 365);
      }),
      benchmark: { low: 15, mid: 45, high: 90 },
      unit: 'days',
      trend: 'insufficient',
      description: '(Inventory / COGS) × 365 — average days to sell inventory',
    },
    {
      name: 'Cash Conversion Cycle',
      key: 'ccc',
      periods: byPeriod(p => {
        const ar = li(balance.get(p) ?? {}, 'accounts_receivable');
        const inv = li(balance.get(p) ?? {}, 'inventory') ?? 0;
        const ap = li(balance.get(p) ?? {}, 'accounts_payable');
        const rev = li(income.get(p) ?? {}, 'revenue');
        const cogs = li(income.get(p) ?? {}, 'cogs');
        if (ar == null || rev == null || rev === 0 || cogs == null || cogs === 0) return null;
        const dso = (ar / rev) * 365;
        const dio = (inv / cogs) * 365;
        const dpo = ap != null ? (ap / cogs) * 365 : 0;
        return round2(dso + dio - dpo);
      }),
      benchmark: { low: 10, mid: 45, high: 90 },
      unit: 'days',
      trend: 'insufficient',
      description: 'DSO + DIO - DPO — total days cash is tied up in operations',
    },
  ];

  efficiency.forEach(r => { r.trend = comparableTrend(data, r.periods); });
  groups.push({ category: 'Efficiency', icon: 'speed', ratios: efficiency });

  return groups;
}

export function computeDuPont(data: PreparedData): DuPontDecomposition | undefined {
  const { income, balance, periods } = data;

  const duPontPeriods = periods.map(p => {
    const inc = income.get(p) ?? {};
    const bal = balance.get(p) ?? {};

    const rev = li(inc, 'revenue');
    const ni = li(inc, 'net_income');
    const ta = li(bal, 'total_assets');
    const eq = li(bal, 'total_equity');

    const netProfitMargin = safeDiv(ni, rev) != null ? round2(safeDiv(ni, rev)! * 100) : null;
    const assetTurnover = round2(safeDiv(rev, ta));
    const equityMultiplier = round2(safeDiv(ta, eq));
    const roe = netProfitMargin != null && assetTurnover != null && equityMultiplier != null
      ? round2(netProfitMargin * assetTurnover * equityMultiplier / 100)
      : null;

    return { period: p, netProfitMargin, assetTurnover, equityMultiplier, roe };
  });

  const hasData = duPontPeriods.some(p => p.roe != null);
  return hasData ? { periods: duPontPeriods } : undefined;
}
