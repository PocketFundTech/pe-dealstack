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
// yourself writing `cell.value = revenue * margin`, stop: it should be
// `{ formula: 'Projections!C5*Assumptions!$B$12' }`.
//
// Layout is fixed and the anchors are exported, because the formulas
// reference cells by address. Moving a row means updating ASSUMPTION_CELLS.

import ExcelJS from 'exceljs';
import type { ModelAssumptions, HistoricalRow } from './assumptions.js';

export const SHEETS = {
  cover: 'Cover',
  assumptions: 'Assumptions',
  historicals: 'Historicals',
  projections: 'Projections',
  returns: 'Returns',
  sensitivity: 'Sensitivity',
  notes: 'Notes',
} as const;

// Banking convention: blue text = an input you may change.
const INPUT_FONT = { color: { argb: 'FF0000CC' } } as const;
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' },
};
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } } as const;

const FMT_MONEY = '#,##0.0;(#,##0.0)';
const FMT_PCT = '0.0%';
const FMT_MULT = '0.0"x"';

export interface WorkbookContext {
  dealName: string;
  companyName?: string | null;
  currency: string;
  unitScale: 'MILLIONS' | 'THOUSANDS';
  sourceDocuments: string[];
  generatedAt: string;
  notes: string[];
}

export interface BuildModelInput {
  assumptions: ModelAssumptions;
  history: HistoricalRow[];
  context: WorkbookContext;
}

/**
 * Fixed addresses on the Assumptions sheet. Every formula elsewhere points
 * here, so this map and writeAssumptions() must stay in lockstep.
 */
const A = SHEETS.assumptions;
export const ASSUMPTION_CELLS = {
  entryMultiple: `${A}!$B$4`,
  transactionFeesPct: `${A}!$B$5`,
  debtQuantum: `${A}!$B$6`,
  interestRate: `${A}!$B$7`,
  amortPctPerYear: `${A}!$B$8`,
  cashSweepPct: `${A}!$B$9`,
  capexPctRevenue: `${A}!$B$10`,
  nwcPctRevenue: `${A}!$B$11`,
  taxRate: `${A}!$B$12`,
  daPctRevenue: `${A}!$B$13`,
  exitMultiple: `${A}!$B$14`,
  exitYear: `${A}!$B$15`,
  wacc: `${A}!$B$16`,
  dscrTarget: `${A}!$B$17`,
  /** Row 20 = growth by year, row 21 = margin by year; column B onward. */
  growthRow: 20,
  growthFirstCol: 2,
  marginRow: 21,
  marginFirstCol: 2,
} as const;

function colLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function growthRef(yearIndex: number): string {
  return `${A}!$${colLetter(ASSUMPTION_CELLS.growthFirstCol + yearIndex)}$${ASSUMPTION_CELLS.growthRow}`;
}
function marginRef(yearIndex: number): string {
  return `${A}!$${colLetter(ASSUMPTION_CELLS.marginFirstCol + yearIndex)}$${ASSUMPTION_CELLS.marginRow}`;
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
}

function label(sheet: ExcelJS.Worksheet, row: number, text: string, bold = false) {
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  if (bold) cell.font = { bold: true };
  return cell;
}

// ============================================================
// Sheets
// ============================================================

function writeCover(sheet: ExcelJS.Worksheet, ctx: WorkbookContext) {
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

function writeAssumptions(sheet: ExcelJS.Worksheet, a: ModelAssumptions) {
  sheet.columns = [{ width: 30 }, ...Array.from({ length: 10 }, () => ({ width: 12 }))];

  sheet.getCell('A1').value = 'Assumptions';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  sheet.getCell('A2').value = 'Blue cells are inputs. Everything else in this workbook derives from them.';
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  // Order here MUST match ASSUMPTION_CELLS above.
  const scalar: Array<[string, number, string]> = [
    ['Entry multiple', a.entryMultiple, FMT_MULT],
    ['Transaction fees (% of EV)', a.transactionFeesPct / 100, FMT_PCT],
    ['Debt (x EBITDA)', a.debtQuantum, FMT_MULT],
    ['Interest rate', a.interestRate / 100, FMT_PCT],
    ['Amortisation (% / yr)', a.amortPctPerYear / 100, FMT_PCT],
    ['Cash sweep (% of FCF)', a.cashSweepPct / 100, FMT_PCT],
    ['Capex (% of revenue)', a.capexPctRevenue / 100, FMT_PCT],
    ['NWC (% of revenue)', a.nwcPctRevenue / 100, FMT_PCT],
    ['Tax rate', a.taxRate / 100, FMT_PCT],
    ['D&A (% of revenue)', a.daPctRevenue / 100, FMT_PCT],
    ['Exit multiple', a.exitMultiple, FMT_MULT],
    ['Exit year', a.exitYear, '0'],
    ['WACC', a.wacc / 100, FMT_PCT],
    ['DSCR target', a.dscrTarget, '0.00"x"'],
  ];
  scalar.forEach(([name, value, fmt], i) => {
    const row = 4 + i;
    label(sheet, row, name);
    const cell = sheet.getCell(row, 2);
    cell.value = value;
    cell.numFmt = fmt;
    cell.font = INPUT_FONT;
  });

  label(sheet, 19, 'By projected year', true);
  for (let y = 0; y < a.projectionYears; y++) {
    sheet.getCell(19, 2 + y).value = `Y${y + 1}`;
    sheet.getCell(19, 2 + y).font = { bold: true };
  }

  label(sheet, ASSUMPTION_CELLS.growthRow, 'Revenue growth');
  label(sheet, ASSUMPTION_CELLS.marginRow, 'EBITDA margin');
  for (let y = 0; y < a.projectionYears; y++) {
    const g = sheet.getCell(ASSUMPTION_CELLS.growthRow, 2 + y);
    g.value = (a.revenueGrowthPct[y] ?? 0) / 100;
    g.numFmt = FMT_PCT;
    g.font = INPUT_FONT;

    const m = sheet.getCell(ASSUMPTION_CELLS.marginRow, 2 + y);
    m.value = (a.ebitdaMarginPct[y] ?? 0) / 100;
    m.numFmt = FMT_PCT;
    m.font = INPUT_FONT;
  }
}

/** Row anchors shared by Historicals and Projections so they line up.
 *  Exported so tests assert on the real layout rather than magic numbers. */
export const PL_ROWS = {
  header: 3,
  revenue: 4,
  cogs: 5,
  grossProfit: 6,
  ebitda: 7,
  da: 8,
  ebit: 9,
  netIncome: 10,
  ebitdaMargin: 12,
} as const;

function writeHistoricals(sheet: ExcelJS.Worksheet, history: HistoricalRow[], ctx: WorkbookContext) {
  sheet.columns = [{ width: 26 }, ...history.map(() => ({ width: 14 })), { width: 34 }];

  sheet.getCell('A1').value = 'Historicals';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  sheet.getCell('A2').value = `${ctx.currency} in ${ctx.unitScale === 'MILLIONS' ? 'millions' : 'thousands'}`;
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  const header = sheet.getRow(PL_ROWS.header);
  header.getCell(1).value = 'Period';
  history.forEach((h, i) => { header.getCell(2 + i).value = h.period; });
  header.getCell(2 + history.length).value = 'Source';
  styleHeaderRow(header);

  const lines: Array<[number, string, keyof HistoricalRow]> = [
    [PL_ROWS.revenue, 'Revenue', 'revenue'],
    [PL_ROWS.cogs, 'COGS', 'cogs'],
    [PL_ROWS.grossProfit, 'Gross profit', 'grossProfit'],
    [PL_ROWS.ebitda, 'EBITDA', 'ebitda'],
    [PL_ROWS.da, 'D&A', 'da'],
    [PL_ROWS.netIncome, 'Net income', 'netIncome'],
  ];

  for (const [rowIdx, name, key] of lines) {
    label(sheet, rowIdx, name);
    history.forEach((h, i) => {
      const cell = sheet.getCell(rowIdx, 2 + i);
      const v = h[key];
      // Missing metric stays BLANK — rendering a gap explicitly beats
      // shifting rows and silently mis-aligning periods.
      if (typeof v === 'number') {
        cell.value = v;
        cell.numFmt = FMT_MONEY;
      }
    });
    sheet.getCell(rowIdx, 2 + history.length).value = 'Extracted from source documents';
  }

  // Margin is derived even here — it's arithmetic on the actuals, and a
  // live formula lets a user correct a figure and see the margin follow.
  label(sheet, PL_ROWS.ebitdaMargin, 'EBITDA margin');
  history.forEach((_, i) => {
    const col = colLetter(2 + i);
    const cell = sheet.getCell(PL_ROWS.ebitdaMargin, 2 + i);
    cell.value = {
      formula: `IF(${col}${PL_ROWS.revenue}=0,"",${col}${PL_ROWS.ebitda}/${col}${PL_ROWS.revenue})`,
    } as ExcelJS.CellFormulaValue;
    cell.numFmt = FMT_PCT;
  });

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: PL_ROWS.header }];
}

function writeProjections(
  sheet: ExcelJS.Worksheet,
  a: ModelAssumptions,
  history: HistoricalRow[],
  ctx: WorkbookContext,
) {
  const years = a.projectionYears;
  sheet.columns = [{ width: 26 }, ...Array.from({ length: years + 1 }, () => ({ width: 14 }))];

  sheet.getCell('A1').value = 'Projections';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  sheet.getCell('A2').value = `${ctx.currency} in ${ctx.unitScale === 'MILLIONS' ? 'millions' : 'thousands'} — every figure derives from Assumptions`;
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  const lastActual = history.at(-1);
  const header = sheet.getRow(PL_ROWS.header);
  header.getCell(1).value = 'Period';
  header.getCell(2).value = lastActual ? `${lastActual.period}A` : 'Base';
  for (let y = 0; y < years; y++) header.getCell(3 + y).value = `Y${y + 1}`;
  styleHeaderRow(header);

  // Column B is the anchor: the last actual, carried in as a value.
  label(sheet, PL_ROWS.revenue, 'Revenue');
  sheet.getCell(PL_ROWS.revenue, 2).value = lastActual?.revenue ?? 0;
  sheet.getCell(PL_ROWS.revenue, 2).numFmt = FMT_MONEY;

  label(sheet, PL_ROWS.ebitda, 'EBITDA');
  sheet.getCell(PL_ROWS.ebitda, 2).value = lastActual?.ebitda ?? 0;
  sheet.getCell(PL_ROWS.ebitda, 2).numFmt = FMT_MONEY;

  label(sheet, PL_ROWS.da, 'D&A');
  label(sheet, PL_ROWS.ebit, 'EBIT');
  label(sheet, PL_ROWS.netIncome, 'Unlevered FCF');
  label(sheet, PL_ROWS.ebitdaMargin, 'EBITDA margin');

  for (let y = 0; y < years; y++) {
    const col = colLetter(3 + y);
    const prev = colLetter(2 + y);

    // Revenue = prior year x (1 + growth for this year)
    const rev = sheet.getCell(PL_ROWS.revenue, 3 + y);
    rev.value = { formula: `${prev}${PL_ROWS.revenue}*(1+${growthRef(y)})` } as ExcelJS.CellFormulaValue;
    rev.numFmt = FMT_MONEY;

    // EBITDA = revenue x margin for this year
    const ebitda = sheet.getCell(PL_ROWS.ebitda, 3 + y);
    ebitda.value = { formula: `${col}${PL_ROWS.revenue}*${marginRef(y)}` } as ExcelJS.CellFormulaValue;
    ebitda.numFmt = FMT_MONEY;

    const da = sheet.getCell(PL_ROWS.da, 3 + y);
    da.value = { formula: `${col}${PL_ROWS.revenue}*${ASSUMPTION_CELLS.daPctRevenue}` } as ExcelJS.CellFormulaValue;
    da.numFmt = FMT_MONEY;

    const ebit = sheet.getCell(PL_ROWS.ebit, 3 + y);
    ebit.value = { formula: `${col}${PL_ROWS.ebitda}-${col}${PL_ROWS.da}` } as ExcelJS.CellFormulaValue;
    ebit.numFmt = FMT_MONEY;

    // Unlevered FCF = EBIT x (1-tax) + D&A - capex - change in NWC
    const fcf = sheet.getCell(PL_ROWS.netIncome, 3 + y);
    fcf.value = {
      formula:
        `${col}${PL_ROWS.ebit}*(1-${ASSUMPTION_CELLS.taxRate})+${col}${PL_ROWS.da}` +
        `-${col}${PL_ROWS.revenue}*${ASSUMPTION_CELLS.capexPctRevenue}` +
        `-(${col}${PL_ROWS.revenue}-${prev}${PL_ROWS.revenue})*${ASSUMPTION_CELLS.nwcPctRevenue}`,
    } as ExcelJS.CellFormulaValue;
    fcf.numFmt = FMT_MONEY;

    const margin = sheet.getCell(PL_ROWS.ebitdaMargin, 3 + y);
    margin.value = {
      formula: `IF(${col}${PL_ROWS.revenue}=0,"",${col}${PL_ROWS.ebitda}/${col}${PL_ROWS.revenue})`,
    } as ExcelJS.CellFormulaValue;
    margin.numFmt = FMT_PCT;
  }

  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: PL_ROWS.header }];
}

const R = {
  entryEbitda: 4,
  entryEv: 5,
  fees: 6,
  debt: 7,
  equity: 8,
  debtHeader: 11,
  opening: 12,
  interest: 13,
  amort: 14,
  closing: 15,
  dscr: 16,
  dscrHeadroom: 17,
  exitHeader: 19,
  exitEbitda: 20,
  exitEv: 21,
  exitDebt: 22,
  exitEquity: 23,
  cfHeader: 26,
  cashflow: 27,
  irr: 29,
  mom: 30,
  dcfHeader: 32,
  dcfValue: 33,
  dcfVsEntry: 34,
} as const;

function writeReturns(sheet: ExcelJS.Worksheet, a: ModelAssumptions, ctx: WorkbookContext) {
  const years = a.projectionYears;
  const P = SHEETS.projections;
  sheet.columns = [{ width: 30 }, ...Array.from({ length: years + 2 }, () => ({ width: 14 }))];

  sheet.getCell('A1').value = 'Sources, uses & returns';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  sheet.getCell('A2').value = `${ctx.currency} in ${ctx.unitScale === 'MILLIONS' ? 'millions' : 'thousands'}`;
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  const lastActualCol = 'B';
  label(sheet, R.entryEbitda, 'Entry EBITDA (LTM)');
  sheet.getCell(R.entryEbitda, 2).value = { formula: `${P}!${lastActualCol}${PL_ROWS.ebitda}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.entryEbitda, 2).numFmt = FMT_MONEY;

  label(sheet, R.entryEv, 'Entry enterprise value');
  sheet.getCell(R.entryEv, 2).value = { formula: `B${R.entryEbitda}*${ASSUMPTION_CELLS.entryMultiple}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.entryEv, 2).numFmt = FMT_MONEY;

  label(sheet, R.fees, 'Transaction fees');
  sheet.getCell(R.fees, 2).value = { formula: `B${R.entryEv}*${ASSUMPTION_CELLS.transactionFeesPct}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.fees, 2).numFmt = FMT_MONEY;

  label(sheet, R.debt, 'Debt raised');
  sheet.getCell(R.debt, 2).value = { formula: `B${R.entryEbitda}*${ASSUMPTION_CELLS.debtQuantum}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.debt, 2).numFmt = FMT_MONEY;

  label(sheet, R.equity, 'Equity cheque', true);
  sheet.getCell(R.equity, 2).value = { formula: `B${R.entryEv}+B${R.fees}-B${R.debt}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.equity, 2).numFmt = FMT_MONEY;

  // ── Debt schedule ────────────────────────────────────────────
  label(sheet, R.debtHeader, 'Debt schedule', true);
  for (let y = 0; y < years; y++) sheet.getCell(R.debtHeader, 2 + y).value = `Y${y + 1}`;

  label(sheet, R.opening, 'Opening debt');
  label(sheet, R.interest, 'Interest');
  label(sheet, R.amort, 'Amortisation');
  label(sheet, R.closing, 'Closing debt');
  label(sheet, R.dscr, 'DSCR');

  for (let y = 0; y < years; y++) {
    const col = colLetter(2 + y);
    const prev = colLetter(1 + y);
    const projCol = colLetter(3 + y);

    const opening = sheet.getCell(R.opening, 2 + y);
    opening.value = {
      formula: y === 0 ? `B${R.debt}` : `${prev}${R.closing}`,
    } as ExcelJS.CellFormulaValue;
    opening.numFmt = FMT_MONEY;

    const interest = sheet.getCell(R.interest, 2 + y);
    interest.value = { formula: `${col}${R.opening}*${ASSUMPTION_CELLS.interestRate}` } as ExcelJS.CellFormulaValue;
    interest.numFmt = FMT_MONEY;

    // Scheduled amortisation plus a cash sweep out of that year's free
    // cash flow, capped at the opening balance so debt can't go negative.
    const amort = sheet.getCell(R.amort, 2 + y);
    amort.value = {
      formula:
        `MIN(${col}${R.opening},B${R.debt}*${ASSUMPTION_CELLS.amortPctPerYear}` +
        `+MAX(0,${P}!${projCol}${PL_ROWS.netIncome})*${ASSUMPTION_CELLS.cashSweepPct})`,
    } as ExcelJS.CellFormulaValue;
    amort.numFmt = FMT_MONEY;

    const closing = sheet.getCell(R.closing, 2 + y);
    closing.value = { formula: `${col}${R.opening}-${col}${R.amort}` } as ExcelJS.CellFormulaValue;
    closing.numFmt = FMT_MONEY;

    // DSCR = EBITDA / (interest + amortisation). Lenders live on this line.
    const dscr = sheet.getCell(R.dscr, 2 + y);
    dscr.value = {
      formula: `IF((${col}${R.interest}+${col}${R.amort})=0,"",${P}!${projCol}${PL_ROWS.ebitda}/(${col}${R.interest}+${col}${R.amort}))`,
    } as ExcelJS.CellFormulaValue;
    dscr.numFmt = '0.00"x"';

    // Headroom against the covenant the lender will actually set. Negative
    // means this year breaches at the modelled assumptions.
    const headroom = sheet.getCell(R.dscrHeadroom, 2 + y);
    headroom.value = {
      formula: `IF(${col}${R.dscr}="","",${col}${R.dscr}-${ASSUMPTION_CELLS.dscrTarget})`,
    } as ExcelJS.CellFormulaValue;
    headroom.numFmt = '0.00"x";[Red]-0.00"x"';
  }
  label(sheet, R.dscrHeadroom, 'DSCR headroom vs target');

  // ── Exit ─────────────────────────────────────────────────────
  const exitCol = colLetter(2 + a.exitYear); // Projections column for exit year
  label(sheet, R.exitHeader, 'Exit', true);
  label(sheet, R.exitEbitda, 'Exit-year EBITDA');
  sheet.getCell(R.exitEbitda, 2).value = { formula: `${P}!${exitCol}${PL_ROWS.ebitda}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.exitEbitda, 2).numFmt = FMT_MONEY;

  label(sheet, R.exitEv, 'Exit enterprise value');
  sheet.getCell(R.exitEv, 2).value = { formula: `B${R.exitEbitda}*${ASSUMPTION_CELLS.exitMultiple}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.exitEv, 2).numFmt = FMT_MONEY;

  label(sheet, R.exitDebt, 'Debt at exit');
  sheet.getCell(R.exitDebt, 2).value = {
    formula: `INDEX(${colLetter(2)}${R.closing}:${colLetter(1 + years)}${R.closing},1,${ASSUMPTION_CELLS.exitYear})`,
  } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.exitDebt, 2).numFmt = FMT_MONEY;

  label(sheet, R.exitEquity, 'Equity proceeds', true);
  sheet.getCell(R.exitEquity, 2).value = { formula: `B${R.exitEv}-B${R.exitDebt}` } as ExcelJS.CellFormulaValue;
  sheet.getCell(R.exitEquity, 2).numFmt = FMT_MONEY;

  // ── Equity cash flows + returns ──────────────────────────────
  label(sheet, R.cfHeader, 'Equity cash flows', true);
  sheet.getCell(R.cfHeader, 2).value = 'Y0';
  for (let y = 1; y <= years; y++) sheet.getCell(R.cfHeader, 2 + y).value = `Y${y}`;

  label(sheet, R.cashflow, 'Cash flow');
  const outflow = sheet.getCell(R.cashflow, 2);
  outflow.value = { formula: `-B${R.equity}` } as ExcelJS.CellFormulaValue;
  outflow.numFmt = FMT_MONEY;

  for (let y = 1; y <= years; y++) {
    const cell = sheet.getCell(R.cashflow, 2 + y);
    // Proceeds land in the exit year only; other years are zero for the
    // equity holder in this simplified structure.
    cell.value = { formula: `IF(${y}=${ASSUMPTION_CELLS.exitYear},B${R.exitEquity},0)` } as ExcelJS.CellFormulaValue;
    cell.numFmt = FMT_MONEY;
  }

  const cfRange = `B${R.cashflow}:${colLetter(2 + years)}${R.cashflow}`;
  label(sheet, R.irr, 'IRR', true);
  const irr = sheet.getCell(R.irr, 2);
  irr.value = { formula: `IFERROR(IRR(${cfRange}),"n/a")` } as ExcelJS.CellFormulaValue;
  irr.numFmt = FMT_PCT;

  label(sheet, R.mom, 'MoM', true);
  const mom = sheet.getCell(R.mom, 2);
  mom.value = { formula: `IF(B${R.equity}=0,"",B${R.exitEquity}/B${R.equity})` } as ExcelJS.CellFormulaValue;
  mom.numFmt = FMT_MULT;

  // ── DCF cross-check ──────────────────────────────────────────
  // Evan (M15) asked for WACC by name. This is the sanity check a buyer
  // runs against the multiple: what are the cash flows actually worth?
  label(sheet, R.dcfHeader, 'DCF cross-check (unlevered)', true);
  label(sheet, R.dcfValue, 'PV of unlevered FCF + terminal');
  // Sheet name goes on the range ONCE — `Sheet!A1:Sheet!B2` is tolerated by
  // Excel but rejected by Google Sheets, and this file has to open in both.
  const fcfRange = `${P}!${colLetter(3)}${PL_ROWS.netIncome}:${colLetter(2 + years)}${PL_ROWS.netIncome}`;
  const terminal = `(${P}!${colLetter(2 + years)}${PL_ROWS.ebitda}*${ASSUMPTION_CELLS.exitMultiple})/((1+${ASSUMPTION_CELLS.wacc})^${years})`;
  const dcf = sheet.getCell(R.dcfValue, 2);
  dcf.value = {
    formula: `IFERROR(NPV(${ASSUMPTION_CELLS.wacc},${fcfRange})+${terminal},"n/a")`,
  } as ExcelJS.CellFormulaValue;
  dcf.numFmt = FMT_MONEY;

  label(sheet, R.dcfVsEntry, 'Premium / (discount) to entry EV');
  const gap = sheet.getCell(R.dcfVsEntry, 2);
  gap.value = {
    formula: `IF(B${R.entryEv}=0,"",B${R.dcfValue}/B${R.entryEv}-1)`,
  } as ExcelJS.CellFormulaValue;
  gap.numFmt = '0.0%;[Red](0.0%)';
}

function writeSensitivity(sheet: ExcelJS.Worksheet, a: ModelAssumptions) {
  sheet.columns = [{ width: 22 }, ...Array.from({ length: 6 }, () => ({ width: 12 }))];

  sheet.getCell('A1').value = 'Sensitivity — IRR';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };
  sheet.getCell('A2').value = 'Entry multiple (rows) against exit multiple (columns)';
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  const steps = [-1, -0.5, 0, 0.5, 1];
  const headerRow = 4;
  sheet.getCell(headerRow, 1).value = 'Entry \\ Exit';
  sheet.getCell(headerRow, 1).font = { bold: true };

  steps.forEach((s, i) => {
    const cell = sheet.getCell(headerRow, 2 + i);
    cell.value = { formula: `${ASSUMPTION_CELLS.exitMultiple}+${s}` } as ExcelJS.CellFormulaValue;
    cell.numFmt = FMT_MULT;
    cell.font = { bold: true };
  });

  const Rt = SHEETS.returns;
  steps.forEach((entryStep, r) => {
    const row = headerRow + 1 + r;
    const rowHead = sheet.getCell(row, 1);
    rowHead.value = { formula: `${ASSUMPTION_CELLS.entryMultiple}+${entryStep}` } as ExcelJS.CellFormulaValue;
    rowHead.numFmt = FMT_MULT;
    rowHead.font = { bold: true };

    steps.forEach((exitStep, c) => {
      const cell = sheet.getCell(row, 2 + c);
      // Closed-form MoM-implied IRR at this (entry, exit) pair, expressed
      // as formulas so the grid recalculates when the base model changes.
      // equity0 = EV(entry) + fees - debt ; proceeds = EV(exit) - exit debt
      const entryEv = `${Rt}!$B$${R.entryEbitda}*(${ASSUMPTION_CELLS.entryMultiple}+${entryStep})`;
      const equity0 = `(${entryEv})*(1+${ASSUMPTION_CELLS.transactionFeesPct})-${Rt}!$B$${R.debt}`;
      const proceeds = `${Rt}!$B$${R.exitEbitda}*(${ASSUMPTION_CELLS.exitMultiple}+${exitStep})-${Rt}!$B$${R.exitDebt}`;
      cell.value = {
        formula: `IFERROR(((${proceeds})/(${equity0}))^(1/${ASSUMPTION_CELLS.exitYear})-1,"n/a")`,
      } as ExcelJS.CellFormulaValue;
      cell.numFmt = FMT_PCT;
    });
  });
}

function writeNotes(sheet: ExcelJS.Worksheet, ctx: WorkbookContext, history: HistoricalRow[]) {
  sheet.columns = [{ width: 100 }];
  sheet.getCell('A1').value = 'Notes & caveats';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF003366' } };

  const lines = [
    `Historical periods included: ${history.map((h) => h.period).join(', ') || 'none'}.`,
    'Historical figures were extracted automatically and normalised to a single currency and unit scale. Verify them against the source documents.',
    'Projections, the debt schedule, returns and the sensitivity grid are all live formulas driven by the Assumptions sheet.',
    'The debt structure is a single senior tranche with straight-line amortisation. Multi-tranche structures and cash sweeps are not modelled.',
    'Blank cells in Historicals mean the figure was not present in the source documents — they are not zeros.',
    ...ctx.notes,
  ];
  lines.forEach((text, i) => {
    const cell = sheet.getCell(3 + i, 1);
    cell.value = `• ${text}`;
    cell.alignment = { wrapText: true, vertical: 'top' };
  });
}

// ============================================================
// Entry point
// ============================================================

export async function buildModelWorkbook(input: BuildModelInput): Promise<Buffer> {
  const { assumptions, history, context } = input;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Avise';
  wb.created = new Date(context.generatedAt);

  writeCover(wb.addWorksheet(SHEETS.cover), context);
  writeAssumptions(wb.addWorksheet(SHEETS.assumptions), assumptions);
  writeHistoricals(wb.addWorksheet(SHEETS.historicals), history, context);
  writeProjections(wb.addWorksheet(SHEETS.projections), assumptions, history, context);
  writeReturns(wb.addWorksheet(SHEETS.returns), assumptions, context);
  writeSensitivity(wb.addWorksheet(SHEETS.sensitivity), assumptions);
  writeNotes(wb.addWorksheet(SHEETS.notes), context, history);

  for (const sheet of wb.worksheets) sheet.properties.showGridLines = false;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
