/**
 * Fix plan H3 — integrated balance sheet with a balance check. Entry is
 * purchase accounting with a goodwill plug (founder's choice): goodwill =
 * entry EV − the net operating assets bought; fees expensed at close; no
 * dividends. Every projected year must balance (check = 0).
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { projectModel, projectBalanceSheet } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults, type ResolvedAssumptions } from '../src/services/dealModel/assumptions.js';
import { buildModelLayout, buildModelWorkbook, SHEETS } from '../src/services/dealModel/workbook.js';
import { baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { openingBalances, otherNetOperatingAssets } from '../src/services/dealModel/balanceItems.js';
import { SRM_FULL_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { findCycle } from './helpers/workbookGraph.js';

const history = normaliseStatements(SRM_FULL_STATEMENTS).rows;
const base = deriveDefaults(history);

const run = (a: ResolvedAssumptions) => {
  const layout = buildModelLayout({ assumptions: a, history });
  const baseCol = baseColumnValues(layout.catalogue, history, selectBasePeriod(history));
  const p = projectModel(layout.catalogue.lines, baseCol.values, layout.assumptions, layout.opening);
  return { p, bs: projectBalanceSheet(p, layout.assumptions, layout.opening), opening: layout.opening };
};

describe('other net operating assets from the seller balance sheet', () => {
  it('is total assets less the itemised assets, less the other liabilities', () => {
    expect(otherNetOperatingAssets({
      totalAssets: 20, cash: 2, ar: 3, inventory: 1, ppe: 8, goodwill: 1, intangibles: 1,
      totalLiabilities: 12, debt: 6, ap: 2,
    })).toBeCloseTo((20 - 2 - 3 - 1 - 8 - 1 - 1) - (12 - 6 - 2), 9);
    // Total liabilities from total equity when not printed.
    expect(otherNetOperatingAssets({ totalAssets: 20, totalEquity: 8, debt: 6, ap: 2 })).toBeCloseTo(20 - (12 - 8), 9);
    expect(otherNetOperatingAssets({ cash: 2 })).toBeUndefined();
  });

  it('carries PP&E into the opening balances', () => {
    expect(openingBalances(history).ppe).toBeDefined();
  });
});

describe.each<[string, ResolvedAssumptions]>([
  ['defaults', base],
  ['two tranches + minimum cash', { ...base, debt2Quantum: 1, debt2AmortPct: 2, minCash: 0.5, cashSweepPct: 70 }],
  ['revolver drawn', { ...base, debtQuantumMode: 'ABSOLUTE', debtQuantum: 25, interestRate: 15, minCash: 1, revolverSize: 6 }],
  ['% of revenue working capital', { ...base, balanceDrivers: { ...base.balanceDrivers, nwcMethod: 'PCT_REVENUE' } }],
])('integrated balance sheet (%s)', (_name, a) => {
  const { p, bs, opening } = run(a);

  it('opens with a goodwill plug: EV less the net operating assets bought', () => {
    expect(bs.entry.goodwill).toBeCloseTo(p.entryEv - p.nwcBase - (opening.ppe ?? 0) - (opening.otherNet ?? 0), 9);
    expect(bs.entry.cash).toBeCloseTo(p.minCash, 9);
    expect(bs.entry.debt).toBeCloseTo(p.debt, 9);
    expect(bs.entry.equity).toBeCloseTo(p.equity - p.entryEv * a.transactionFeesPct / 100, 9); // fees expensed
    expect(bs.entry.check).toBeCloseTo(0, 9);
  });

  it('balances every projected year', () => {
    bs.years.forEach((y, i) => expect(y.check, `Y${i + 1}`).toBeCloseTo(0, 9));
  });

  it('rolls PP&E with capex less D&A and equity with net income', () => {
    const y1 = bs.years[0];
    expect(y1.ppe).toBeCloseTo(bs.entry.ppe + p.capex[0] - (p.values.da?.[0] ?? 0), 9);
    expect(y1.equity).toBeCloseTo(bs.entry.equity + p.values.net_income[0], 9);
    expect(y1.debt).toBeCloseTo(p.debtClosing[0], 9);
  });
});

describe('Balance Sheet sheet in the workbook', () => {
  it('is there, after Returns, with no circular references', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildModelWorkbook({ assumptions: base, history, context: SRM_CONTEXT })) as never);
    const names = wb.worksheets.map((w) => w.name);
    expect(names.indexOf(SHEETS.balanceSheet)).toBe(names.indexOf(SHEETS.returns) + 1);
    expect(findCycle(wb)).toBeNull();
  });
});
