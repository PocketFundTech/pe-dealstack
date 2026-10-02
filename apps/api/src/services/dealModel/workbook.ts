// ─── Deal model — workbook builder ────────────────────────────────
// Produces the .xlsx a deal team actually sends to its IC and its lender.
//
// Demo-call origin: Evan M15 ("a model, not text — a Google-Sheets-like UI
// he + partner can see and edit"), Himanshu M11, Daniel Callahan. Asked
// unprompted in three separate calls.
//
// THE INVARIANT: every derived cell is a LIVE EXCEL FORMULA referencing the
// Assumptions sheet. A workbook of hard-coded computed values would satisfy
// a screenshot and fail the actual request — the whole point is that the
// partner changes the exit multiple and watches IRR move. If you find
// yourself writing `cell.value = revenue * margin`, stop: it should be a
// formula built from the registry's addresses.
//
// Layout is generated from the deal's P&L line catalogue (fix plan E1):
// workbook/registry.ts hands out every address, so nothing here hard-codes
// a row. Sheets live in workbook/*.ts.
//
// Scenarios (fix plan E2): the Assumptions sheet carries Low / Base / High
// columns per input and an "Active case" switch; every main-model formula
// reads the Live column (CHOOSE on the active case). The Scenarios sheet
// computes all three cases side by side.
//
// Balance sheet and cash flow (fix plan E3): working capital (DSO / DIO /
// DPO, or % of revenue), capex, levered FCF, opening net debt into sources
// & uses, a two-tranche debt schedule and a cash balance — see
// workbook/workingCapital.ts, workbook/debtSchedule.ts and returns.ts.

import ExcelJS from 'exceljs';
import type { ModelCase } from '@ai-crm/shared';
import type { HistoricalRow, ModelAssumptions, ResolvedAssumptions } from './assumptions.js';
import { resolveAssumptions } from './assumptions.js';
import { alignToBase, seedScenario, SCENARIO_DELTAS, type CaseSet } from './scenarios.js';
import { writeScenarios } from './workbook/scenariosSheet.js';
import { selectBasePeriod } from './basePeriod.js';
import { buildLineCatalogue, baseColumnValues, type LineCatalogue } from './lineCatalogue.js';
import { openingBalances } from './balanceItems.js';
import type { OpeningBalances } from '@ai-crm/shared';
import { buildRegistry, type Registry } from './workbook/registry.js';
import { writeAssumptions } from './workbook/assumptionsSheet.js';
import { writeHistoricals } from './workbook/historicals.js';
import { writeProjections } from './workbook/projections.js';
import { writeReturns } from './workbook/returns.js';
import { writeSensitivity } from './workbook/sensitivity.js';
import { writeCover, writeNotes } from './workbook/coverNotes.js';
import { fillCachedResults } from './workbook/calc.js';
import { SHEETS, type WorkbookContext } from './workbook/xlsx.js';

export { SHEETS, type WorkbookContext };
export { RETURNS_ROWS } from './workbook/returns.js';
export { buildRegistry, SCALAR_KEYS, type Registry } from './workbook/registry.js';
export { scenarioLayout } from './workbook/scenariosSheet.js';

type AnyAssumptions = Partial<ModelAssumptions> | ResolvedAssumptions;

export interface BuildModelInput {
  /** Base case — saved or edited; partial / pre-E1 sets are resolved against the catalogue. */
  assumptions: AnyAssumptions;
  /** Low / High (and optionally Base) sets; a missing case is seeded from Base. */
  cases?: Partial<Record<ModelCase, AnyAssumptions | null>>;
  /** Which case the workbook opens on (the Active case cell). Default Base. */
  activeCase?: ModelCase;
  history: HistoricalRow[];
  context: WorkbookContext;
}

export interface ModelLayout {
  catalogue: LineCatalogue;
  /** The Base case. */
  assumptions: ResolvedAssumptions;
  cases: CaseSet;
  registry: Registry;
  /** Latest full-year balance sheet: Days working-capital base and the net debt refinanced at entry. */
  opening: OpeningBalances;
}

/** The catalogue, resolved cases and cell registry a workbook is built on. */
export function buildModelLayout(input: Pick<BuildModelInput, 'assumptions' | 'history' | 'cases'>): ModelLayout {
  const { history } = input;
  const catalogue = buildLineCatalogue(history);
  const base = resolveAssumptions((input.cases?.Base ?? input.assumptions) as Partial<ModelAssumptions>, history, {}, catalogue);
  const side = (c: 'Low' | 'High') => {
    const given = input.cases?.[c];
    return given ? alignToBase(given as Partial<ModelAssumptions>, base, history, {}, catalogue) : seedScenario(base, catalogue.lines, c);
  };
  const cases: CaseSet = { Low: side('Low'), Base: base, High: side('High') };
  return {
    catalogue, assumptions: base, cases, opening: openingBalances(history),
    registry: buildRegistry(catalogue.lines, base.projectionYears, base.balanceDrivers),
  };
}

export async function buildModelWorkbook(input: BuildModelInput): Promise<Buffer> {
  const { history, context } = input;
  const { catalogue, assumptions, cases, registry, opening } = buildModelLayout(input);
  const base = selectBasePeriod(history);
  const baseCol = baseColumnValues(catalogue, history, base, context.fallbackEntryEbitda);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Avise';
  wb.created = new Date(context.generatedAt);

  writeCover(wb.addWorksheet(SHEETS.cover), context);
  writeAssumptions(wb.addWorksheet(SHEETS.assumptions), cases, input.activeCase ?? 'Base', registry);
  const scenarioSheet = wb.addWorksheet(SHEETS.scenarios);
  const checks = writeHistoricals(wb.addWorksheet(SHEETS.historicals), history, catalogue, registry, context);
  writeProjections(wb.addWorksheet(SHEETS.projections), assumptions, registry, base, baseCol, opening, context);
  writeReturns(wb.addWorksheet(SHEETS.returns), assumptions, registry, base, baseCol, opening, context);
  writeSensitivity(wb.addWorksheet(SHEETS.sensitivity), assumptions, registry);
  writeScenarios(scenarioSheet, cases, registry, context);
  writeNotes(wb.addWorksheet(SHEETS.notes), { ctx: context, history, base, baseCol, cat: catalogue, reg: registry, checks,
    extra: [
      `Scenarios: switch the Active case on the Assumptions sheet (Low / Base / High) and the whole model follows; the Scenarios sheet shows all three at once. ` +
      `Unsaved Low / High cases were seeded from Base: revenue growth ${SCENARIO_DELTAS.Low.revenueGrowthPp}pp / +${SCENARIO_DELTAS.High.revenueGrowthPp}pp, ` +
      `EBITDA margin ${SCENARIO_DELTAS.Low.ebitdaMarginPp}pp / +${SCENARIO_DELTAS.High.ebitdaMarginPp}pp (through the % of revenue cost lines), ` +
      `exit multiple ${SCENARIO_DELTAS.Low.exitMultipleX}x / +${SCENARIO_DELTAS.High.exitMultipleX}x; working capital, capex and debt start equal to Base. Every case value is an editable input.`,
      ...balanceNotes(assumptions, opening),
    ] });

  // Every formula carries its computed value, so previews and Protected View
  // show numbers (calc.ts); Excel / Sheets still recompute on open.
  const uncached = fillCachedResults(wb);
  if (uncached.length) console.warn(`[dealModel] ${uncached.length} workbook formulas left uncached, e.g. ${uncached.slice(0, 5).join(', ')}`);
  wb.calcProperties.fullCalcOnLoad = true;
  for (const sheet of wb.worksheets) sheet.properties.showGridLines = false;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Notes on the balance-sheet side of the model (fix plan E3). */
function balanceNotes(a: ResolvedAssumptions, opening: OpeningBalances): string[] {
  const bd = a.balanceDrivers;
  const bs = opening.period ? `the ${opening.period} balance sheet` : 'no balance sheet (none extracted)';
  return [
    bd.nwcMethod === 'DAYS'
      ? `Working capital: receivables, inventory and payables start from ${bs} and are projected with DSO (of revenue), DIO and DPO (of COGS) seeded from full fiscal years; the increase in net working capital is a use of cash.`
      : 'Working capital is held at a % of revenue (the balance sheet did not give receivables / payables the model could turn into days, or the model was saved before days were available).',
    bd.capexMethod === 'SPLIT'
      ? 'Capex is maintenance + growth, each a % of revenue seeded from the cash flow statement (outflows read as positive amounts).'
      : 'Capex is a % of revenue, seeded from the cash flow statement where it was reported (3% otherwise).',
    `Entry is cash-free, debt-free: existing net debt from ${bs} is refinanced at entry (Returns, sources & uses), so the equity cheque is EV + fees + minimum cash − new debt.`,
    'Debt: a senior tranche and an optional second tranche (both sized at entry), with mandatory amortisation and a year-end cash sweep of levered FCF (after interest and tax) above the minimum cash — senior first. ' +
      'Interest is charged on the average balance after scheduled amortisation (opening − mandatory / 2), so it never depends on that year\'s sweep: no circular reference and no iterative calculation is needed. ' +
      'Closing cash below zero means a funding shortfall (no revolver is modelled). The integrated balance sheet is not modelled.',
  ];
}
