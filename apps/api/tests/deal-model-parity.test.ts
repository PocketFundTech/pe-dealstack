/**
 * The Build model panel's live preview (projectModel in @ai-crm/shared) and
 * the downloaded workbook's formulas are two implementations of one model.
 * Until now only their formula SHAPES were tested, separately. The workbook
 * now carries a computed value for every formula (calc.ts), so this checks
 * the NUMBERS agree: entry, every projected year, the debt and cash
 * schedule, exit and returns. Any change to the model's arithmetic must
 * change both, or this fails.
 */
import { describe, it, expect } from 'vitest';
import { projectModel, summariseCase, MODEL_CASES } from '@ai-crm/shared';
import { normaliseStatements, deriveDefaults, type ResolvedAssumptions } from '../src/services/dealModel/assumptions.js';
import { buildModelWorkbook, buildModelLayout, scenarioLayout, SHEETS, RETURNS_ROWS as R } from '../src/services/dealModel/workbook.js';
import { baseColumnValues } from '../src/services/dealModel/lineCatalogue.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { colLetter } from '../src/services/dealModel/workbook/xlsx.js';
import { SRM_FULL_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { readWorkbookXml, cellNumber } from './helpers/xlsxXml.js';

const history = normaliseStatements(SRM_FULL_STATEMENTS).rows;
const base = deriveDefaults(history);

const CASES: Array<[string, ResolvedAssumptions]> = [
  ['defaults', base],
  ['two tranches, minimum cash, partial sweep', { ...base, debt2Quantum: 1, debt2AmortPct: 2, debt2InterestRate: 13, minCash: 0.5, cashSweepPct: 60 }],
  ['revenue entry basis, absolute debt, higher exit', { ...base, entryBasis: 'REVENUE', entryMultiple: 0.9, debtQuantumMode: 'ABSOLUTE', debtQuantum: 8, exitMultiple: 7, exitYear: 4 }],
  ['revolver drawn (heavy debt, negative early FCF)', {
    ...base, debtQuantumMode: 'ABSOLUTE', debtQuantum: 25, interestRate: 15, minCash: 1, revolverSize: 6, revolverRate: 9, revolverFeePct: 0.5,
  }],
  ['% of revenue working capital, single capex', {
    ...base, balanceDrivers: { ...base.balanceDrivers, nwcMethod: 'PCT_REVENUE', capexMethod: 'TOTAL' },
  }],
];

describe.each(CASES)('workbook = live preview (%s)', (_name, assumptions) => {
  it('agrees on entry, every projected year, the debt schedule and the returns', async () => {
    const layout = buildModelLayout({ assumptions, history });
    const baseCol = baseColumnValues(layout.catalogue, history, selectBasePeriod(history));
    const p = projectModel(layout.catalogue.lines, baseCol.values, layout.assumptions, layout.opening);
    // Normal deals must actually compute returns, so the IRR checks below run.
    if (!_name.startsWith('revolver')) expect(p.irr).not.toBeNull();
    if (_name.startsWith('revolver')) expect(p.debtSchedule.some((d) => d.drawR > 0)).toBe(true);

    const { sheets } = await readWorkbookXml(await buildModelWorkbook({ assumptions, history, context: SRM_CONTEXT }));
    const ret = sheets.get(SHEETS.returns)!;
    const proj = sheets.get(SHEETS.projections)!;
    const close = (sheetXml: string, address: string, expected: number, what: string) => {
      const got = cellNumber(sheetXml, address);
      expect(Number.isNaN(got), `${what} (${address}) has no cached number`).toBe(false);
      expect(got, `${what} (${address})`).toBeCloseTo(expected, 6);
    };

    close(ret, `B${R.entryEv}`, p.entryEv, 'entry EV');
    close(ret, `B${R.equity}`, p.equity, 'equity cheque');
    close(ret, `B${R.totalDebt}`, p.debt, 'total new debt');

    const PL = layout.registry.pl.row;
    for (let y = 0; y < layout.assumptions.projectionYears; y++) {
      const col = colLetter(3 + y);
      close(proj, `${col}${PL.revenue}`, p.revenue[y], `Y${y + 1} revenue`);
      close(proj, `${col}${PL.ebitda}`, p.ebitda[y], `Y${y + 1} EBITDA`);
      close(proj, `${col}${PL.net_income}`, p.values.net_income[y], `Y${y + 1} net income`);
      const d = p.debtSchedule[y];
      const rc = colLetter(2 + y);
      close(ret, `${rc}${R.interest}`, d.interest, `Y${y + 1} interest`);
      close(ret, `${rc}${R.cashClose}`, d.cashClose, `Y${y + 1} closing cash`);
      close(ret, `${rc}${R.drawR}`, d.drawR, `Y${y + 1} revolver drawn`);
      close(ret, `${rc}${R.closeR}`, d.closeR, `Y${y + 1} revolver closing`);
      close(proj, `${col}${layout.registry.pl.lfcf}`, d.lfcf, `Y${y + 1} levered FCF`);
    }

    close(ret, `B${R.exitEv}`, p.exitEv, 'exit EV');
    close(ret, `B${R.exitDebt}`, p.exitDebt, 'exit debt');
    close(ret, `B${R.exitCash}`, p.exitCash, 'exit cash');
    close(ret, `B${R.exitEquity}`, p.exitEquity, 'exit equity');
    if (p.mom !== null) close(ret, `B${R.mom}`, p.mom, 'MoM');
    if (p.irr !== null) close(ret, `B${R.irr}`, p.irr, 'IRR');

    // Scenarios sheet: each case's summary = summariseCase on that case.
    const scen = sheets.get(SHEETS.scenarios)!;
    const sl = scenarioLayout(layout.registry);
    for (const c of MODEL_CASES) {
      const sum = summariseCase(layout.catalogue.lines, baseCol.values, layout.cases[c], layout.opening);
      const col = colLetter(sl.summaryCol[c]);
      close(scen, `${col}${sl.summaryRow.entryEv}`, sum.entryEv, `${c} entry EV`);
      close(scen, `${col}${sl.summaryRow.exitEv}`, sum.exitEv, `${c} exit EV`);
      if (sum.mom !== null) close(scen, `${col}${sl.summaryRow.mom}`, sum.mom, `${c} MoM`);
      if (sum.irr !== null) close(scen, `${col}${sl.summaryRow.irr}`, sum.irr, `${c} IRR`);
    }

    // Sensitivity: the centre cell is the live case's IRR (same entry and exit multiple).
    if (p.irr !== null) close(sheets.get(SHEETS.sensitivity)!, 'D7', p.irr, 'sensitivity centre IRR');
  });
});
