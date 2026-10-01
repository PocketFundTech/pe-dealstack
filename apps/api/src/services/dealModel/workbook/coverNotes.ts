// Cover sheet and Notes & caveats.

import type ExcelJS from 'exceljs';
import type { HistoricalRow } from '../assumptions.js';
import type { BasePeriod } from '../basePeriod.js';
import type { BaseColumn, LineCatalogue } from '../lineCatalogue.js';
import type { Registry } from './registry.js';
import { SHEETS, type WorkbookContext } from './xlsx.js';

export function writeCover(sheet: ExcelJS.Worksheet, ctx: WorkbookContext) {
  sheet.columns = [{ width: 26 }, { width: 60 }];
  sheet.getCell('A1').value = ctx.companyName || ctx.dealName;
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF003366' } };

  const rows: Array<[string, string]> = [
    ['Deal', ctx.dealName],
    ['Company', ctx.companyName || '—'],
    ['Currency', ctx.currency],
    ['Units', ctx.unitScale === 'MILLIONS' ? 'Millions' : 'Thousands'],
    ['Generated', ctx.generatedAt.slice(0, 10)],
    ['Source documents', ctx.sourceDocuments.length ? ctx.sourceDocuments.join(', ') : 'None recorded'],
  ];
  rows.forEach(([k, v], i) => {
    sheet.getCell(i + 3, 1).value = k;
    sheet.getCell(i + 3, 1).font = { bold: true };
    sheet.getCell(i + 3, 2).value = v;
  });

  const disclaimerRow = rows.length + 5;
  sheet.getCell(disclaimerRow, 1).value = 'Before you rely on this';
  sheet.getCell(disclaimerRow, 1).font = { bold: true };
  sheet.getCell(disclaimerRow + 1, 1).value =
    'This model was built from figures extracted automatically from the source documents listed above. ' +
    'Verify every historical figure against the source document before relying on it. ' +
    'Blue cells on the Assumptions sheet are inputs — change them and the whole model recalculates.';
  sheet.getCell(disclaimerRow + 1, 1).alignment = { wrapText: true, vertical: 'top' };
  sheet.mergeCells(disclaimerRow + 1, 1, disclaimerRow + 3, 2);
}

/**
 * The deal record's EBITDA (often adjusted, from the CIM or a valuation) can
 * differ a lot from the statements' — on SRM 6.1 vs a derived 2.21. Say so
 * rather than silently picking one: it moves entry EV and every return.
 */
function ebitdaGapNote(base: BasePeriod | null, ctx: WorkbookContext, reg: Registry): string[] {
  const own = base?.row.ebitda;
  const deal = ctx.fallbackEntryEbitda;
  if (typeof own !== 'number' || typeof deal !== 'number' || own <= 0 || deal <= 0) return [];
  const gap = Math.abs(deal - own) / own;
  if (gap < 0.25) return [];
  return [
    `CHECK: base-period EBITDA from the statements is ${own.toFixed(2)}${base?.row.ebitdaDerived ? ' (derived)' : ''}, ` +
    `but the deal record says ${deal.toFixed(2)} — a ${Math.round(gap * 100)}% difference (e.g. adjusted vs reported EBITDA). ` +
    `The model uses the statements figure (${SHEETS.projections}!B${reg.pl.row.ebitda}); adjust the base-column cost lines if the adjusted figure is the right entry basis.`,
  ];
}

export interface NotesInput {
  ctx: WorkbookContext;
  history: HistoricalRow[];
  base: BasePeriod | null;
  baseCol: BaseColumn;
  cat: LineCatalogue;
  reg: Registry;
  checks: string[];
  extra?: string[];
}

export function writeNotes(sheet: ExcelJS.Worksheet, n: NotesInput) {
  const { ctx, history, base, baseCol, cat, reg } = n;
  sheet.columns = [{ width: 110 }];
  sheet.getCell('A1').value = 'Notes & caveats';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  const accounts = reg.lines.filter((l) => l.level > 0 && !l.key.endsWith('__other')).length;
  const costKey = baseCol.implied.find((k) => reg.lines.some((l) => l.key === k && l.costLine));
  const costCell = costKey ? `${SHEETS.projections}!B${reg.pl.row[costKey]}` : 'the base-column cost line on Projections';

  const lines = [
    `Historical periods included: ${history.map((h) => h.period).join(', ') || 'none'}.`,
    'Historical figures were extracted automatically and normalised to a single currency and unit scale. Verify them against the source documents.',
    `Every P&L line is modelled (${reg.lines.length} lines, ${accounts} of them individual accounts nested under their parent). Each input line has its own driver on the Assumptions sheet; parents are the sum of their accounts and subtotals are formulas.`,
    'Drivers were seeded from full fiscal years only (partial / YTD periods are shown for information): revenue at the trailing CAGR, costs at their average % of revenue, other income / expense at their average amount.',
    'Projections, the debt schedule, returns and the sensitivity grid are all live formulas driven by the Assumptions sheet.',
    'The debt structure is a single senior tranche: straight-line amortisation plus a cash sweep of unlevered free cash flow. Multi-tranche structures are not modelled.',
    ...(base ? [base.note] : []),
    ...(base?.row.ebitdaDerived ? ['Base-period EBITDA was not printed in the source; it was derived (EBIT + D&A, or equivalent).'] : []),
    ...ebitdaGapNote(base, ctx, reg),
    ...(baseCol.entrySource === 'deal' ? [`The base period has no EBITDA — entry EBITDA uses the deal's recorded EBITDA, entered through an implied operating-cost figure (${costCell}). Verify it.`] : []),
    ...(baseCol.entrySource === 'missing' ? [`WARNING: no entry EBITDA could be found or derived, so entry EV, debt and equity are 0 and returns are not meaningful. Enter the base-period costs on the Projections sheet (${costCell}) or extract a P&L with EBITDA.`] : []),
    ...(cat.periods.some((p) => p.implied.length) ? ['Grey italic figures in Historicals were not printed; they are implied by the statement (e.g. COGS = revenue − gross profit, operating costs = gross profit − EBITDA).'] : []),
    ...(reg.lines.some((l) => l.key.endsWith('__other')) ? ['"Other (unallocated)" lines hold the difference between a printed total and the sum of its itemised accounts, so every parent ties to the statement.'] : []),
    ...(cat.unclassified.length ? [`Accounts with no recognisable parent line (${cat.unclassified.join(', ')}) are not modelled individually; where a printed total includes them, they sit in "Other (unallocated)".`] : []),
    ...n.checks.map((c) => `CHECK: ${c}`),
    'Blank cells in Historicals mean the figure was not present in the source documents — they are not zeros.',
    ...(n.extra ?? []),
    ...ctx.notes,
  ];
  lines.forEach((text, i) => {
    const cell = sheet.getCell(3 + i, 1);
    cell.value = `• ${text}`;
    cell.alignment = { wrapText: true, vertical: 'top' };
  });
}
