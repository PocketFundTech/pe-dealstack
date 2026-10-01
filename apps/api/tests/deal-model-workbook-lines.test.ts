/**
 * Fix plan E1 on the SRM shape — the generated workbook models every P&L
 * line: per-line drivers on Assumptions, live per-line formulas on
 * Projections, subtotals as formulas on Historicals AND Projections, and
 * accounts outlined under their parent. Opened back with exceljs and
 * asserted against the registry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { normaliseStatements, deriveDefaults } from '../src/services/dealModel/assumptions.js';
import { buildModelWorkbook, buildModelLayout, SHEETS, RETURNS_ROWS } from '../src/services/dealModel/workbook.js';
import { SRM_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { findCycle } from './helpers/workbookGraph.js';

const history = normaliseStatements(SRM_STATEMENTS).rows;
const assumptions = deriveDefaults(history);
const { registry: reg } = buildModelLayout({ assumptions, history });
const PL = reg.pl.row;
let wb: ExcelJS.Workbook;
const f = (v: unknown) => (v as { formula?: string })?.formula ?? '';
const sheet = (name: string) => wb.getWorksheet(name)!;

beforeAll(async () => {
  wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildModelWorkbook({ assumptions, history, context: SRM_CONTEXT })) as never);
});

describe('Assumptions — a driver row per line', () => {
  it('writes method + per-year values as blue inputs, % as fractions', () => {
    const a = sheet(SHEETS.assumptions);
    const row = reg.assumptions.driverRow.cogs_cement.Base;
    expect(a.getCell(row, 1).value).toBe('Cement');
    expect(a.getCell(row, 2).value).toBe('Base');
    expect(a.getCell(row, 3).value).toBe('% of revenue');
    expect(a.getCell(row, 4).value).toBeCloseTo(assumptions.lineDrivers.cogs_cement.values[0] / 100, 6);
    expect(a.getCell(row, 4).font?.color?.argb).toBe('FF0000CC');
    expect(a.getRow(row).outlineLevel).toBe(1);
  });

  it('offers the allowed methods as a dropdown — no % of revenue on revenue lines', () => {
    const a = sheet(SHEETS.assumptions);
    const cost = a.getCell(reg.assumptions.driverRow.cogs_cement.Low, 3).dataValidation;
    const rev = a.getCell(reg.assumptions.driverRow.revenue_sales.High, 3).dataValidation;
    expect(cost?.type).toBe('list');
    expect(cost?.formulae?.[0]).toContain('% of revenue');
    expect(rev?.formulae?.[0]).not.toContain('% of revenue');
  });

  it('has no driver row for a subtotal or a parent', () => {
    for (const k of ['revenue', 'cogs', 'gross_profit', 'total_opex', 'ebitda', 'ebit', 'ebt', 'net_income', 'interest_expense', 'tax']) {
      expect(reg.assumptions.driverRow[k]).toBeUndefined();
    }
  });
});

describe('Historicals — every line, subtotals as formulas', () => {
  it('writes each account as a plain value under its parent', () => {
    const h = sheet(SHEETS.historicals);
    expect(h.getCell(PL.cogs_cement, 3).value).toBe(8.2);
    expect(h.getCell(PL.cogs_fly_ash, 1).value).toBe('Fly ash');
    expect(h.getRow(PL.cogs_fly_ash).outlineLevel).toBe(1);
    expect(h.getRow(PL.cogs).outlineLevel ?? 0).toBe(0);
  });

  it('makes parents and subtotals formulas', () => {
    const h = sheet(SHEETS.historicals);
    const cogs = f(h.getCell(PL.cogs, 3).value);
    expect(cogs).toMatch(/^SUM\(/);
    expect(cogs).toContain(`C${PL.cogs_cement}`);
    expect(cogs).toContain(`C${PL.cogs__other}`);
    expect(f(h.getCell(PL.gross_profit, 3).value)).toBe(`C${PL.revenue}-C${PL.cogs}`);
    expect(f(h.getCell(PL.ebitda, 3).value)).toBe(`C${PL.gross_profit}-C${PL.total_opex}`);
    expect(f(h.getCell(PL.ebit, 3).value)).toBe(`C${PL.ebitda}-C${PL.da}`);
    expect(f(h.getCell(PL.net_income, 3).value)).toBe(`C${PL.ebt}-C${PL.tax}`);
  });

  it('keeps the 9-month YTD column for information, with the subtotals it can compute', () => {
    const h = sheet(SHEETS.historicals);
    expect(h.getCell(reg.pl.header, 4).value).toBe('2025 YTD (Jan - Sep 2025)');
    // No interest / tax printed for the YTD → EBT is not formula-built.
    expect(f(h.getCell(PL.ebt, 4).value)).toBe('');
  });
});

describe('Projections — live formulas from each driver', () => {
  const p = () => sheet(SHEETS.projections);

  it('projects every input line from its own driver', () => {
    const r = PL.cogs_cement;
    const m = reg.method('cogs_cement');
    const v = reg.value('cogs_cement', 0);
    expect(f(p().getCell(r, 3).value)).toBe(
      `IF(${m}="Growth %",B${r}*(1+${v}),IF(${m}="% of revenue",C${PL.revenue}*${v},${v}))`,
    );
    expect(f(p().getCell(r, 7).value)).toContain(reg.value('cogs_cement', 4));
  });

  it('sums accounts into parents and builds subtotals, in the base column too', () => {
    expect(f(p().getCell(PL.revenue, 3).value)).toBe(`SUM(C${PL.revenue_sales},C${PL.revenue_discounts})`);
    expect(f(p().getCell(PL.gross_profit, 2).value)).toBe(`B${PL.revenue}-B${PL.cogs}`);
    expect(f(p().getCell(PL.ebitda, 2).value)).toBe(`B${PL.gross_profit}-B${PL.total_opex}`);
    expect(p().getCell(PL.cogs_cement, 2).value).toBe(8.2); // base = FY2024, never the YTD
  });

  it('links interest to the debt schedule and tax to the tax rate', () => {
    expect(f(p().getCell(PL.interest_expense, 3).value)).toBe(`${SHEETS.returns}!B${RETURNS_ROWS.interest}`);
    expect(f(p().getCell(PL.tax, 4).value)).toBe(`MAX(0,D${PL.ebt})*${reg.scalar('taxRate')}`);
    expect(f(p().getCell(PL.ebt, 3).value)).toBe(`C${PL.ebit}-C${PL.interest_expense}+C${PL.other_income}`);
  });

  it('feeds the new EBITDA row to returns, debt and DCF', () => {
    const r = sheet(SHEETS.returns);
    expect(f(r.getCell(RETURNS_ROWS.entryEbitda, 2).value)).toBe(`${SHEETS.projections}!B${PL.ebitda}`);
    expect(f(r.getCell(RETURNS_ROWS.exitEbitda, 2).value)).toContain(`${SHEETS.projections}!C${PL.ebitda}:G${PL.ebitda}`);
    // The sweep runs on levered FCF (after interest and tax), not unlevered (E3).
    expect(f(r.getCell(RETURNS_ROWS.lfcf, 2).value)).toBe(`${SHEETS.projections}!C${reg.pl.lfcf}`);
    expect(f(r.getCell(RETURNS_ROWS.available, 2).value)).toContain(`B${RETURNS_ROWS.lfcf}`);
    expect(f(r.getCell(RETURNS_ROWS.dcfValue, 2).value)).toContain(`${SHEETS.projections}!C${reg.pl.fcf}:G${reg.pl.fcf}`);
    expect(f(r.getCell(RETURNS_ROWS.dscr, 2).value)).toContain(`${SHEETS.projections}!C${PL.ebitda}`);
  });

  it('never references the revenue row from a revenue account (it is their sum)', () => {
    for (const k of ['revenue_sales', 'revenue_discounts']) {
      expect(f(p().getCell(PL[k], 3).value)).not.toContain(`C${PL.revenue}`);
    }
  });

  it('has no circular references — checked statically, as Google Sheets does', () => {
    expect(findCycle(wb)).toBeNull();
  });

  it('notes the line structure on the Notes sheet', () => {
    const notes = JSON.stringify(sheet(SHEETS.notes).getSheetValues());
    expect(notes).toContain('Every P&L line is modelled');
    expect(notes).toContain('Other (unallocated)');
  });
});

