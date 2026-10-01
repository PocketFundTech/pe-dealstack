/**
 * Fix plan E2 — Low / Base / High scenarios: seeding Low / High from Base,
 * the workbook's "Active case" switch (CHOOSE into a Live column that every
 * formula reads), and the Scenarios sheet's per-case summary.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { summariseCase } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults } from '../src/services/dealModel/assumptions.js';
import { buildLineCatalogue, baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import {
  parseCase, seedScenario, resolveCases, SCENARIO_DELTAS,
} from '../src/services/dealModel/scenarios.js';
import { buildModelWorkbook, buildModelLayout, scenarioLayout, SHEETS, SCALAR_KEYS, RETURNS_ROWS } from '../src/services/dealModel/workbook.js';
import { SRM_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { findCycle } from './helpers/workbookGraph.js';

const history = normaliseStatements(SRM_STATEMENTS).rows;
const cat = buildLineCatalogue(history);
const base = deriveDefaults(history, {}, cat);
const baseValues = baseColumnValues(cat, history, selectBasePeriod(history)).values;
const costLines = cat.lines.filter((l) => l.kind === 'INPUT' && l.costLine).map((l) => l.key);
const costTotal = (a: typeof base, y = 0) => costLines.reduce((t, k) => t + a.lineDrivers[k].values[y], 0);
const f = (v: unknown) => (v as { formula?: string })?.formula ?? '';

describe('parseCase', () => {
  it('accepts Low / Base / High in any case, defaults to Base, rejects the rest', () => {
    expect(parseCase(undefined)).toBe('Base');
    expect(parseCase('low')).toBe('Low');
    expect(parseCase('High case')).toBe('High');
    expect(parseCase('Upside')).toBeNull();
    expect(parseCase(['Low'])).toBeNull();
  });
});

describe('seeding Low / High from Base', () => {
  it('moves growth, margin and exit multiple by the documented deltas', () => {
    const low = seedScenario(base, cat.lines, 'Low');
    const high = seedScenario(base, cat.lines, 'High');
    expect(low.lineDrivers.revenue_sales.values[0]).toBeCloseTo(base.lineDrivers.revenue_sales.values[0] - 3, 6);
    expect(high.lineDrivers.revenue_discounts.values[2]).toBeCloseTo(base.lineDrivers.revenue_discounts.values[2] + 3, 6);
    // EBITDA margin −2pp / +2pp, taken through the % of revenue cost lines.
    expect(costTotal(low)).toBeCloseTo(costTotal(base) + 2, 3);
    expect(costTotal(high)).toBeCloseTo(costTotal(base) - 2, 3);
    // …in proportion: cement keeps its share of costs.
    expect(low.lineDrivers.cogs_cement.values[0] / costTotal(low)).toBeCloseTo(base.lineDrivers.cogs_cement.values[0] / costTotal(base), 4);
    expect(low.exitMultiple).toBe(base.exitMultiple + SCENARIO_DELTAS.Low.exitMultipleX);
    expect(high.exitMultiple).toBe(base.exitMultiple + 1);
    // Base untouched.
    expect(base.lineDrivers.revenue_sales.values[0]).toBe(30);
  });

  it('never seeds an exit multiple below 0.5x', () => {
    expect(seedScenario({ ...base, exitMultiple: 1 }, cat.lines, 'Low').exitMultiple).toBe(0.5);
  });

  it('orders the cases: Low < Base < High on IRR, MoM and exit EV', () => {
    const cases = resolveCases({}, history, {}, cat);
    const [lo, mid, hi] = (['Low', 'Base', 'High'] as const).map((c) => summariseCase(cat.lines, baseValues, cases[c]));
    expect(lo.irr!).toBeLessThan(mid.irr!);
    expect(mid.irr!).toBeLessThan(hi.irr!);
    expect(lo.mom!).toBeLessThan(mid.mom!);
    expect(lo.exitEv).toBeLessThan(mid.exitEv);
    expect(mid.exitEv).toBeLessThan(hi.exitEv);
    expect(lo.entryEv).toBeCloseTo(mid.entryEv, 9); // same entry — the deal price doesn't change with the case
  });

  it('uses a saved case as-is, on the Base case structure', () => {
    const cases = resolveCases({ Low: { exitMultiple: 3, projectionYears: 3 } }, history, {}, cat);
    expect(cases.Low.exitMultiple).toBe(3);
    expect(cases.Low.projectionYears).toBe(base.projectionYears);
    expect(cases.Low.lineDrivers.cogs_cement.values).toHaveLength(base.projectionYears);
    expect(cases.High.exitMultiple).toBe(base.exitMultiple + 1); // still seeded
  });
});

describe('workbook — active-case switch', () => {
  let wb: ExcelJS.Workbook;
  const layout = buildModelLayout({ assumptions: base, history });
  const reg = layout.registry;
  const scen = scenarioLayout(reg);

  beforeAll(async () => {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildModelWorkbook({ assumptions: base, history, context: SRM_CONTEXT, activeCase: 'High' })) as never);
  });

  it('has a blue Active case input with a Low / Base / High dropdown, and its number', () => {
    const a = wb.getWorksheet(SHEETS.assumptions)!;
    const cell = a.getCell(reg.assumptions.activeCase.split('!')[1].replace(/\$/g, ''));
    expect(cell.value).toBe('High');
    expect(cell.dataValidation?.formulae?.[0]).toBe('"Low,Base,High"');
    const idx = a.getCell(reg.assumptions.activeIndex.split('!')[1].replace(/\$/g, ''));
    expect(f(idx.value)).toBe('MATCH($B$4,$B$7:$D$7,0)');
  });

  it('writes each case as blue inputs and a Live column via CHOOSE', () => {
    const a = wb.getWorksheet(SHEETS.assumptions)!;
    const r = reg.assumptions.scalarRow.exitMultiple;
    expect(a.getCell(r, 2).value).toBe(layout.cases.Low.exitMultiple);
    expect(a.getCell(r, 3).value).toBe(base.exitMultiple);
    expect(a.getCell(r, 4).value).toBe(layout.cases.High.exitMultiple);
    expect(f(a.getCell(r, 5).value)).toBe(`CHOOSE($B$5,B${r},C${r},D${r})`);

    const rows = reg.assumptions.driverRow.cogs_cement;
    expect(f(a.getCell(rows.Live, 3).value)).toBe(`CHOOSE($B$5,C${rows.Low},C${rows.Base},C${rows.High})`);
    expect(f(a.getCell(rows.Live, 4).value)).toBe(`CHOOSE($B$5,D${rows.Low},D${rows.Base},D${rows.High})`);
    expect(a.getCell(rows.Low, 4).value).toBeCloseTo(layout.cases.Low.lineDrivers.cogs_cement.values[0] / 100, 9);
  });

  it('points every main-model formula at Live, never at a single case', () => {
    const caseRefs = (['Low', 'Base', 'High'] as const).flatMap((c) => [
      ...SCALAR_KEYS.map((k) => reg.scalar(k, c)),
      // P&L and working-capital / capex driver cells (E3) of each case.
      ...Object.keys(reg.assumptions.driverRow).flatMap((k) => Array.from({ length: reg.years }, (_, y) => reg.value(k, y, c))),
    ]);
    const offenders: string[] = [];
    for (const name of [SHEETS.projections, SHEETS.returns, SHEETS.sensitivity]) {
      wb.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => {
        const formula = f(cell.value);
        // Whole references only — Assumptions!$D$8 is a prefix of a Live driver cell like $D$80.
        if (caseRefs.some((ref) => new RegExp(`${ref.replace(/\$/g, '\\$')}(?!\\d)`).test(formula))) offenders.push(`${name}!${cell.address}`);
      }));
    }
    expect(offenders).toEqual([]);
    expect(f(wb.getWorksheet(SHEETS.returns)!.getCell('B5').value)).toContain(reg.scalar('entryMultiple'));
  });

  it('shows revenue, EBITDA, exit EV, IRR and MoM for every case at once', () => {
    const s = wb.getWorksheet(SHEETS.scenarios)!;
    expect(s.getCell(4, 2).value).toBe('Low');
    expect(s.getCell(4, 4).value).toBe('High');
    for (const c of ['Low', 'Base', 'High'] as const) {
      const col = scen.summaryCol[c];
      const block = scen.block[c];
      expect(f(s.getCell(scen.summaryRow.irr, col).value)).toBe(`B${block.row.irr}`);
      expect(f(s.getCell(scen.summaryRow.exitEv, col).value)).toBe(`B${block.row.exitEv}`);
      expect(f(s.getCell(scen.summaryRow.mom, col).value)).toBe(`B${block.row.mom}`);
      expect(f(s.getCell(scen.summaryRow.exitEbitda, col).value)).toBe(`B${block.row.exitEbitda}`);
      expect(f(s.getCell(scen.summaryRow.exitRevenue, col).value)).toContain(reg.scalar('exitYear', c));
      // Each block reads its own case column.
      expect(f(s.getCell(block.line.cogs_cement, 3).value)).toContain(reg.value('cogs_cement', 0, c));
      expect(f(s.getCell(block.row.exitEv, 2).value)).toBe(`B${block.row.exitEbitda}*${reg.scalar('exitMultiple', c)}`);
      expect(f(s.getCell(block.row.irr, 2).value)).toMatch(/^IFERROR\(IRR\(B\d+:G\d+\),"n\/a"\)$/);
    }
    expect(f(s.getCell(scen.liveIrrRow, 2).value)).toBe(`${SHEETS.returns}!B${RETURNS_ROWS.irr}`);
  });

  it('keeps the whole workbook free of circular references', () => {
    expect(findCycle(wb)).toBeNull();
  });
});
