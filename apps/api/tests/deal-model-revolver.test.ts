/**
 * Fix plan H2 — revolving credit facility. Off by default (size 0: the model
 * is unchanged). With a size: draws only to hold the minimum cash, is repaid
 * first from cash above the minimum (before the sweep), and charges interest
 * on the opening drawn balance plus a fee on the undrawn commitment — both on
 * the opening balance, so no circular reference.
 */
import { describe, it, expect } from 'vitest';
import { debtScheduler, projectModel } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults, resolveAssumptions, assumptionsSchema } from '../src/services/dealModel/assumptions.js';
import { buildModelWorkbook, buildModelLayout, SHEETS } from '../src/services/dealModel/workbook.js';
import { baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { SRM_FULL_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { findCycle } from './helpers/workbookGraph.js';
import ExcelJS from 'exceljs';

const terms = (over: Partial<Parameters<typeof debtScheduler>[0]> = {}) => ({
  senior: 10, seniorRate: 10, seniorAmort: 0, second: 0, secondRate: 0, secondAmort: 0,
  minCash: 1, sweepPct: 100, revolver: 5, revolverRate: 8, revolverFee: 0.5, ...over,
});

describe('debtScheduler — revolver', () => {
  it('draws to hold minimum cash when levered FCF is negative, up to the commitment', () => {
    const lfcf = [-2, -10, 3, 3];
    const d = debtScheduler(terms(), (y) => lfcf[y]);
    expect(d.year(0).drawR).toBeCloseTo(2, 9);       // 1 + (−2) → −1 short of the 1 minimum → draw 2
    expect(d.year(0).cashClose).toBeCloseTo(1, 9);
    expect(d.year(1).drawR).toBeCloseTo(3, 9);       // needs 10, only 5 − 2 = 3 left
    expect(d.year(1).closeR).toBeCloseTo(5, 9);
    expect(d.year(1).cashClose).toBeCloseTo(1 - 10 + 3, 9); // the rest is a funding shortfall
  });

  it('repays the revolver from cash above the minimum before any sweep', () => {
    const lfcf = [-2, 3, 3];
    const d = debtScheduler(terms(), (y) => lfcf[y]);
    expect(d.year(1).repayR).toBeCloseTo(2, 9);      // 3 spare, all 2 drawn repaid first
    expect(d.year(1).available).toBeCloseTo(1, 9);   // only the remaining 1 is swept
    expect(d.year(1).closeR).toBeCloseTo(0, 9);
  });

  it('charges interest on the opening drawn balance and a fee on the undrawn commitment', () => {
    const lfcf = [-2, 3];
    const d = debtScheduler(terms(), (y) => lfcf[y]);
    expect(d.year(0).intR).toBeCloseTo(0 * 0.08 + 5 * 0.005, 9);
    expect(d.year(1).intR).toBeCloseTo(2 * 0.08 + 3 * 0.005, 9);
    expect(d.year(1).interest).toBeCloseTo(d.year(1).int1 + d.year(1).int2 + d.year(1).intR, 9);
    expect(d.year(1).closing).toBeCloseTo(d.year(1).close1 + d.year(1).close2 + d.year(1).closeR, 9);
  });

  it('with no revolver (size 0) is the schedule it always was', () => {
    const lfcf = [-2, 3, 3];
    const off = debtScheduler(terms({ revolver: 0 }), (y) => lfcf[y]);
    for (let y = 0; y < 3; y++) {
      expect(off.year(y).drawR).toBe(0);
      expect(off.year(y).intR).toBe(0);
    }
    expect(off.year(0).cashClose).toBeCloseTo(1 - 2, 9); // shortfall, as before
  });
});

describe('model with a revolver', () => {
  const history = normaliseStatements(SRM_FULL_STATEMENTS).rows;
  const base = deriveDefaults(history);
  // Heavy debt makes levered FCF negative early, so the revolver is drawn.
  const stressed = { ...base, debtQuantumMode: 'ABSOLUTE' as const, debtQuantum: 25, interestRate: 15, minCash: 1, revolverSize: 6, revolverRate: 9, revolverFeePct: 0.5 };

  it('defaults to off, and older saved models load with it off', () => {
    expect(base.revolverSize).toBe(0);
    expect(resolveAssumptions({ entryMultiple: 6 }, history).revolverSize).toBe(0);
    expect(assumptionsSchema.safeParse({ ...base, revolverSize: 5, revolverRate: 8, revolverFeePct: 0.5 }).success).toBe(true);
  });

  it('is drawn in the stressed case and carried into exit debt', () => {
    const layout = buildModelLayout({ assumptions: stressed, history });
    const baseCol = baseColumnValues(layout.catalogue, history, selectBasePeriod(history));
    const p = projectModel(layout.catalogue.lines, baseCol.values, layout.assumptions, layout.opening);
    expect(p.debtSchedule.some((d) => d.drawR > 0)).toBe(true);
    const exit = p.debtSchedule[layout.assumptions.exitYear - 1];
    expect(p.exitDebt).toBeCloseTo(exit.close1 + exit.close2 + exit.closeR, 9);
  });

  it('keeps the workbook free of circular references with the revolver on', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildModelWorkbook({ assumptions: stressed, history, context: SRM_CONTEXT })) as never);
    expect(findCycle(wb)).toBeNull();
    const text = JSON.stringify(wb.getWorksheet(SHEETS.returns)!.getSheetValues());
    expect(text).toContain('Revolver');
  });
});
