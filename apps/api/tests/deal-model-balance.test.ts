/**
 * Fix plan E3 — balance-sheet and cash-flow inputs: reading AR / inventory /
 * AP / PP&E / cash / debt and (split) capex from full fiscal years, seeding
 * DSO / DIO / DPO and capex %, the fallbacks, ΔNWC and levered FCF in the
 * shared calculator, and loading models saved before E3.
 */
import { describe, it, expect } from 'vitest';
import { projectModel, summariseCase } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults, resolveAssumptions } from '../src/services/dealModel/assumptions.js';
import { buildLineCatalogue, baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { openingBalances, seedBalanceDrivers } from '../src/services/dealModel/balanceItems.js';
import { resolveCases, seedScenario } from '../src/services/dealModel/scenarios.js';
import { SRM_FULL_STATEMENTS, SRM_STATEMENTS, srmStatement } from './helpers/srmModelFixture.js';

const history = normaliseStatements(SRM_FULL_STATEMENTS).rows;
const cat = buildLineCatalogue(history);
const baseValues = baseColumnValues(cat, history, selectBasePeriod(history)).values;
const opening = openingBalances(history);
const avg = (...xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

describe('reading the balance sheet and cash flow (normaliseStatements)', () => {
  it('attaches them to the P&L of the same canonical period, without adding columns', () => {
    expect(history.map((h) => h.period)).toEqual(['FY2023 (Jan - Dec 2023)', 'FY2024 (Jan - Dec 2024)', '2025 YTD (Jan - Sep 2025)']);
    expect(history[1].balance).toEqual({
      ar: 3.6, inventory: 1.1, ap: 2.2, ppe: 7, cash: 0.9, stDebt: 0.6, ltDebt: 4, debt: 4.6,
      capex: 1.6, capexGrowth: 0.7, capexMaintenance: 0.9,
    });
  });

  it('sums split capex lines (growth / maintenance / replacement) as positive amounts when no total is printed', () => {
    const b = history[0].balance!;
    expect(b.capex).toBeCloseTo(1.3, 9);
    expect(b.capexGrowth).toBeCloseTo(0.6, 9);
    expect(b.capexMaintenance).toBeCloseTo(0.7, 9); // maintenance + replacement
    expect(b.debt).toBeCloseTo(4.0, 9);              // short + long term, no total_debt printed
  });

  it('rescales THOUSANDS, and drops a statement in another currency or for a period with no P&L', () => {
    const rows = normaliseStatements([
      ...SRM_STATEMENTS,
      { ...srmStatement('FY2024', { accounts_receivable: 3600 }), statementType: 'BALANCE_SHEET', unitScale: 'THOUSANDS' },
      { ...srmStatement('FY2023', { accounts_receivable: 99 }), statementType: 'BALANCE_SHEET', currency: 'EUR' },
      { ...srmStatement('FY2021', { accounts_receivable: 1 }), statementType: 'BALANCE_SHEET' },
    ]).rows;
    expect(rows).toHaveLength(3);
    expect(rows[1].balance).toEqual({ ar: 3.6 });
    expect(rows[0].balance).toBeUndefined();
  });

  it('takes the opening balances from the latest FULL year, never the YTD', () => {
    expect(opening).toEqual({ period: 'FY2024 (Jan - Dec 2024)', ar: 3.6, inventory: 1.1, ap: 2.2, cash: 0.9, debt: 4.6 });
  });
});

describe('seeding working capital and capex drivers', () => {
  const bd = deriveDefaults(history, {}, cat).balanceDrivers;

  it('seeds DSO / DIO / DPO from full years only (revenue / COGS from the P&L)', () => {
    expect(bd.nwcMethod).toBe('DAYS');
    expect(bd.dso).toEqual(Array(5).fill(r(avg(2.9 / 21 * 365, 3.6 / 27.3 * 365), 1)));
    expect(bd.dio[0]).toBe(r(avg(0.8 / 15.4 * 365, 1.1 / 20 * 365), 1));
    expect(bd.dpo[0]).toBe(r(avg(1.7 / 15.4 * 365, 2.2 / 20 * 365), 1));
    // The 9-month YTD (AR 4.4 on 29.0 of revenue) would have pushed DSO past 50.
    expect(bd.dso[0]).toBeLessThan(50);
  });

  it('seeds capex % of revenue from the cash flow, split into maintenance and growth', () => {
    expect(bd.capexMethod).toBe('SPLIT');
    expect(bd.capexPct[0]).toBe(r(avg(1.3 / 21, 1.6 / 27.3) * 100, 2));
    expect(bd.capexMaintPct[0]).toBe(r(avg(0.7 / 21, 0.9 / 27.3) * 100, 2));
    expect(bd.capexGrowthPct[0]).toBe(r(avg(0.6 / 21, 0.7 / 27.3) * 100, 2));
  });

  it('falls back to the pre-E3 10% NWC and 3% capex when there is no balance sheet or cash flow', () => {
    const plain = normaliseStatements(SRM_STATEMENTS).rows;
    const d = seedBalanceDrivers(plain, buildLineCatalogue(plain), 5);
    expect(d.nwcMethod).toBe('PCT_REVENUE');
    expect(d.nwcPct).toEqual([10, 10, 10, 10, 10]);
    expect(d.capexMethod).toBe('TOTAL');
    expect(d.capexPct).toEqual([3, 3, 3, 3, 3]);
  });

  it('uses % of revenue from the balance sheet when payables exist but the P&L has no COGS', () => {
    const rows = normaliseStatements([
      srmStatement('FY2024', { revenue: 20, ebitda: 3 }),
      { ...srmStatement('FY2024', { accounts_receivable: 4, accounts_payable: 1 }), statementType: 'BALANCE_SHEET' },
    ]).rows;
    const d = seedBalanceDrivers(rows, buildLineCatalogue(rows), 3);
    expect(d.nwcMethod).toBe('PCT_REVENUE');
    expect(d.nwcPct).toEqual([15, 15, 15]);
    expect(d.dso).toEqual([73, 73, 73]); // still seeded, for a later switch
  });
});

describe('projectModel — working capital, capex, levered FCF', () => {
  const a = deriveDefaults(history, {}, cat);
  const p = projectModel(cat.lines, baseValues, a, opening);
  const bd = a.balanceDrivers;

  it('projects AR / inventory / AP from days and measures ΔNWC from the opening balances', () => {
    expect(p.nwcBase).toBeCloseTo(3.6 + 1.1 - 2.2, 9);
    const rev = p.revenue[0];
    const cogs = p.values.cogs[0];
    const nwc0 = rev * bd.dso[0] / 365 + cogs * bd.dio[0] / 365 - cogs * bd.dpo[0] / 365;
    expect(p.nwc[0]).toBeCloseTo(nwc0, 9);
    expect(p.deltaNwc[0]).toBeCloseTo(nwc0 - 2.5, 9);
    expect(p.deltaNwc[1]).toBeCloseTo(p.nwc[1] - p.nwc[0], 9);
  });

  it('drives capex from maintenance + growth % of revenue', () => {
    expect(p.capex[2]).toBeCloseTo(p.revenue[2] * (bd.capexMaintPct[2] + bd.capexGrowthPct[2]) / 100, 9);
  });

  it('computes unlevered FCF for the DCF and levered FCF (after interest and tax) for the sweep', () => {
    for (let y = 0; y < 5; y++) {
      const cash = p.values.da[y] - p.capex[y] - p.deltaNwc[y];
      expect(p.fcf[y]).toBeCloseTo(p.values.ebit[y] * (1 - a.taxRate / 100) + cash, 9);
      expect(p.leveredFcf[y]).toBeCloseTo(p.values.net_income[y] + cash, 9);
    }
  });
});

describe('backward-compatible loading of models saved before E3', () => {
  const { balanceDrivers: _b, debt2Quantum: _d, debt2InterestRate: _r, debt2AmortPct: _m, minCash: _c, ...rest } = deriveDefaults(history, {}, cat);
  const legacy = { ...rest, capexPctRevenue: 4, nwcPctRevenue: 12 };

  it('turns scalar NWC / capex % into the equivalent per-year drivers, no second tranche, no minimum cash', () => {
    const a = resolveAssumptions(legacy, history, {}, cat);
    expect(a.balanceDrivers.nwcMethod).toBe('PCT_REVENUE');
    expect(a.balanceDrivers.nwcPct).toEqual([12, 12, 12, 12, 12]);
    expect(a.balanceDrivers.capexMethod).toBe('TOTAL');
    expect(a.balanceDrivers.capexPct).toEqual([4, 4, 4, 4, 4]);
    expect([a.debt2Quantum, a.debt2AmortPct, a.minCash]).toEqual([0, 0, 0]);
    expect('nwcPctRevenue' in a || 'capexPctRevenue' in a).toBe(false);
    // The other series are still seeded from history, ready for a switch to Days.
    expect(a.balanceDrivers.dso[0]).toBeGreaterThan(40);
  });

  it('reproduces the pre-E3 cash flows exactly: FCF = EBIT(1−t) + D&A − capex% × revenue − NWC% × Δrevenue', () => {
    const a = resolveAssumptions(legacy, history, {}, cat);
    const p = projectModel(cat.lines, baseValues, a, opening);
    const prevRev = (y: number) => (y === 0 ? p.base.revenue : p.revenue[y - 1]);
    for (let y = 0; y < 5; y++) {
      const old = p.values.ebit[y] * (1 - a.taxRate / 100) + p.values.da[y]
        - p.revenue[y] * 0.04 - (p.revenue[y] - prevRev(y)) * 0.12;
      expect(p.fcf[y]).toBeCloseTo(old, 9);
    }
  });

  it('still loads through the calculator when the panel sends an object without the E3 fields', () => {
    const p = projectModel(cat.lines, baseValues, { ...legacy, lineDrivers: deriveDefaults(history, {}, cat).lineDrivers });
    expect(p.capex[0]).toBeCloseTo(p.revenue[0] * 0.04, 9);
    expect(p.secondDebt).toBe(0);
    expect(p.irr).not.toBeNull();
  });
});

describe('scenarios — E3 drivers', () => {
  const base = deriveDefaults(history, {}, cat);

  it('seeds Low / High with the same working capital, capex and debt as Base (independent copies)', () => {
    const low = seedScenario(base, cat.lines, 'Low');
    expect(low.balanceDrivers).toEqual(base.balanceDrivers);
    expect([low.debt2Quantum, low.minCash]).toEqual([base.debt2Quantum, base.minCash]);
    low.balanceDrivers.dso[0] = 99;
    expect(base.balanceDrivers.dso[0]).not.toBe(99);
  });

  it('forces a saved case onto the Base methods, keeping its own figures for them', () => {
    const cases = resolveCases({
      Low: { balanceDrivers: { ...base.balanceDrivers, nwcMethod: 'PCT_REVENUE', dso: [70, 70, 70, 70, 70] } },
    }, history, {}, cat);
    expect(cases.Low.balanceDrivers.nwcMethod).toBe('DAYS');
    expect(cases.Low.balanceDrivers.dso[0]).toBe(70);
  });

  it('longer receivable days lower IRR; a second tranche raises leverage and cuts the equity cheque', () => {
    const slow = { ...base, balanceDrivers: { ...base.balanceDrivers, dso: base.balanceDrivers.dso.map((d) => d + 30) } };
    const s0 = summariseCase(cat.lines, baseValues, base, opening);
    expect(summariseCase(cat.lines, baseValues, slow, opening).irr!).toBeLessThan(s0.irr!);
    const levered = summariseCase(cat.lines, baseValues, { ...base, debt2Quantum: 1 }, opening);
    expect(levered.equity).toBeCloseTo(s0.equity - 1 * 2.8, 6);
  });
});
