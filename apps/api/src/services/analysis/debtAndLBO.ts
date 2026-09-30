/**
 * Debt Capacity & LBO Quick Screen
 * Analyzes debt capacity and runs 12-scenario LBO screen.
 */

import { PreparedData, DebtCapacity, LBOScreen } from './types.js';
import { li, safeDiv, round2, comparablePeriods, ebitdaOf } from './helpers.js';

export function computeDebtCapacity(data: PreparedData): DebtCapacity | undefined {
  const { income, balance, cashflow } = data;
  // Leverage and coverage need a full year's EBITDA, never a partial YTD.
  const periods = comparablePeriods(data);
  if (periods.length === 0) return undefined;

  const latestP = periods[periods.length - 1];
  const inc = income.get(latestP) ?? {};
  const bal = balance.get(latestP) ?? {};
  const cf = cashflow.get(latestP) ?? {};

  const ebitda = ebitdaOf(inc);
  const ebit = li(inc, 'ebit');
  const interest = li(inc, 'interest_expense');
  const capex = li(cf, 'capex');
  const stDebt = li(bal, 'short_term_debt') ?? 0;
  const ltDebt = li(bal, 'long_term_debt') ?? 0;
  const cash = li(bal, 'cash') ?? 0;
  const totalDebt = stDebt + ltDebt;
  const netDebt = totalDebt - cash;

  if (ebitda == null || ebitda <= 0) return undefined;

  const currentLeverage = round2(netDebt / ebitda);
  const maxDebt3x = round2(ebitda * 3);
  const maxDebt4x = round2(ebitda * 4);
  const maxDebt5x = round2(ebitda * 5);

  const capexAbs = capex != null ? Math.abs(capex) : 0;
  const principal = stDebt;
  const dscr = interest != null && (interest + principal) > 0
    ? round2((ebitda - capexAbs) / (interest + principal))
    : null;

  const interestCoverage = round2(safeDiv(ebit ?? ebitda, interest));
  const debtHeadroom = round2(maxDebt4x! - totalDebt);

  return { currentLeverage, maxDebt3x, maxDebt4x, maxDebt5x, dscr, interestCoverage, debtHeadroom };
}

export function computeLBOScreen(data: PreparedData): LBOScreen | undefined {
  const { income } = data;
  const periods = comparablePeriods(data);
  if (periods.length < 2) return undefined;

  const latestP = periods[periods.length - 1];
  const latestInc = income.get(latestP) ?? {};
  const entryEbitda = ebitdaOf(latestInc);

  if (entryEbitda == null || entryEbitda <= 0) return undefined;

  const ebitdas = periods.map(p => ebitdaOf(income.get(p) ?? {})).filter((e): e is number => e != null);
  const histGrowth = ebitdas.length >= 2
    ? ((ebitdas[ebitdas.length - 1] / ebitdas[0]) ** (1 / (ebitdas.length - 1)) - 1)
    : 0.08;
  const growthRate = Math.min(Math.max(histGrowth, 0.03), 0.25);

  const scenarios: LBOScreen['scenarios'] = [];
  const entryMultiples = [5, 6, 7, 8];
  const exitMultiples = [6, 7, 8];

  for (const entry of entryMultiples) {
    for (const exit of exitMultiples) {
      const tev = entry * entryEbitda;
      const debtPct = 0.6;
      const equityRequired = round2(tev * (1 - debtPct));
      const debt = tev * debtPct;

      const exitEbitda = round2(entryEbitda * Math.pow(1 + growthRate, 5));
      const exitTEV = round2(exitEbitda! * exit);

      const remainingDebt = debt * 0.8;
      const exitEquity = exitTEV! - remainingDebt;

      const moic = equityRequired != null && equityRequired > 0
        ? round2(exitEquity / equityRequired)
        : null;

      const irr = moic != null && moic > 0
        ? round2((Math.pow(moic, 1 / 5) - 1) * 100)
        : null;

      scenarios.push({
        entryMultiple: entry,
        exitMultiple: exit,
        growthRate: round2(growthRate * 100)!,
        equityRequired,
        exitEbitda,
        exitTEV,
        moic,
        irr,
      });
    }
  }

  const passesScreen = scenarios.some(s =>
    s.irr != null && s.irr >= 20 && s.moic != null && s.moic >= 2.5
  );

  return { entryEbitda: round2(entryEbitda), scenarios, passesScreen };
}
