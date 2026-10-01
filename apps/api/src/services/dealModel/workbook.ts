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

import ExcelJS from 'exceljs';
import type { HistoricalRow, ModelAssumptions, ResolvedAssumptions } from './assumptions.js';
import { resolveAssumptions } from './assumptions.js';
import { selectBasePeriod } from './basePeriod.js';
import { buildLineCatalogue, baseColumnValues, type LineCatalogue } from './lineCatalogue.js';
import { buildRegistry, type Registry } from './workbook/registry.js';
import { writeAssumptions } from './workbook/assumptionsSheet.js';
import { writeHistoricals } from './workbook/historicals.js';
import { writeProjections } from './workbook/projections.js';
import { writeReturns } from './workbook/returns.js';
import { writeSensitivity } from './workbook/sensitivity.js';
import { writeCover, writeNotes } from './workbook/coverNotes.js';
import { SHEETS, type WorkbookContext } from './workbook/xlsx.js';

export { SHEETS, type WorkbookContext };
export { RETURNS_ROWS } from './workbook/returns.js';
export { buildRegistry, SCALAR_KEYS, type Registry } from './workbook/registry.js';

export interface BuildModelInput {
  /** Saved or edited assumptions — partial / pre-E1 sets are resolved against the catalogue. */
  assumptions: Partial<ModelAssumptions> | ResolvedAssumptions;
  history: HistoricalRow[];
  context: WorkbookContext;
}

export interface ModelLayout {
  catalogue: LineCatalogue;
  assumptions: ResolvedAssumptions;
  registry: Registry;
}

/** The catalogue, resolved assumptions and cell registry a workbook is built on. */
export function buildModelLayout(input: Pick<BuildModelInput, 'assumptions' | 'history'>): ModelLayout {
  const catalogue = buildLineCatalogue(input.history);
  const assumptions = resolveAssumptions(input.assumptions as Partial<ModelAssumptions>, input.history, {}, catalogue);
  return { catalogue, assumptions, registry: buildRegistry(catalogue.lines, assumptions.projectionYears) };
}

export async function buildModelWorkbook(input: BuildModelInput): Promise<Buffer> {
  const { history, context } = input;
  const { catalogue, assumptions, registry } = buildModelLayout(input);
  const base = selectBasePeriod(history);
  const baseCol = baseColumnValues(catalogue, history, base, context.fallbackEntryEbitda);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Avise';
  wb.created = new Date(context.generatedAt);

  writeCover(wb.addWorksheet(SHEETS.cover), context);
  writeAssumptions(wb.addWorksheet(SHEETS.assumptions), assumptions, registry);
  const checks = writeHistoricals(wb.addWorksheet(SHEETS.historicals), history, catalogue, registry, context);
  writeProjections(wb.addWorksheet(SHEETS.projections), assumptions, registry, base, baseCol, context);
  writeReturns(wb.addWorksheet(SHEETS.returns), assumptions, registry, base, baseCol, context);
  writeSensitivity(wb.addWorksheet(SHEETS.sensitivity), assumptions, registry);
  writeNotes(wb.addWorksheet(SHEETS.notes), { ctx: context, history, base, baseCol, cat: catalogue, reg: registry, checks });

  // No cached results are written; make Excel / Sheets compute on open so
  // previews don't show blanks.
  wb.calcProperties.fullCalcOnLoad = true;
  for (const sheet of wb.worksheets) sheet.properties.showGridLines = false;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
