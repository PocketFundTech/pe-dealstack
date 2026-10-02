/**
 * Fix plan D1 (base / entry period) + D2 (entry values, formula fixes),
 * on the Strong Ready Mix shape: FY2023/FY2024 with range labels, a 9-month
 * 2025 YTD, a revenue-only 2021, a bare "2024" from a valuation file, and
 * no printed EBITDA anywhere.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { normaliseStatements, deriveDefaults } from '../src/services/dealModel/assumptions.js';
import { selectBasePeriod } from '../src/services/dealModel/basePeriod.js';
import { buildModelWorkbook, buildModelLayout, SHEETS, RETURNS_ROWS } from '../src/services/dealModel/workbook.js';
import type { HistoricalRow } from '../src/services/dealModel/assumptions.js';
import { entrySeed } from '../src/services/dealModel/entrySeed.js';

/** Registry rows for a history — addresses are generated (fix plan E1). */
const rowsFor = (history: HistoricalRow[]) => buildModelLayout({ assumptions: deriveDefaults(history), history }).registry;

const is = (period: string, lineItems: Record<string, number>) =>
  ({ statementType: 'INCOME_STATEMENT', period, periodType: 'HISTORICAL', unitScale: 'MILLIONS', currency: 'USD', isActive: true, lineItems });

const SRM = [
  is('2021', { revenue: 12.4954 }),
  is('2025 YTD (Jan - Sep 2025)', { revenue: 28.9823, ebit: 3.2, da: 0.8 }),
  is('FY2023 (Jan - Dec 2023)', { revenue: 20.9597, ebit: 1.6, da: 0.6 }),
  is('FY2024 (Jan - Dec 2024)', { revenue: 27.3214, ebit: 2.1, da: 0.7, net_income: -0.12 }),
  is('2024', { revenue: 27.3214 }),
];

const CONTEXT = {
  dealName: 'SRM', companyName: 'Strong Ready Mix', currency: 'USD', unitScale: 'MILLIONS' as const,
  sourceDocuments: [], generatedAt: '2026-09-30T00:00:00Z', notes: [],
};

async function load(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  return wb;
}
const formula = (v: unknown) => (v as { formula?: string })?.formula ?? '';

describe('normaliseStatements (D1)', () => {
  const { rows } = normaliseStatements(SRM);

  it('orders chronologically and merges "2024" into "FY2024 (…)"', () => {
    expect(rows.map((r) => r.period)).toEqual([
      '2021', 'FY2023 (Jan - Dec 2023)', 'FY2024 (Jan - Dec 2024)', '2025 YTD (Jan - Sep 2025)',
    ]);
  });

  it('derives EBITDA that the statement did not print', () => {
    const fy24 = rows.find((r) => r.period.startsWith('FY2024'))!;
    expect(fy24.ebitda).toBeCloseTo(2.8);
    expect(fy24.ebitdaDerived).toBe(true);
  });
});

describe('selectBasePeriod (D1)', () => {
  it('uses the last full year — not the 9-month YTD — when there is no prior-year YTD', () => {
    const base = selectBasePeriod(normaliseStatements(SRM).rows)!;
    expect(base.basis).toBe('FY');
    expect(base.row.period).toBe('FY2024 (Jan - Dec 2024)');
    expect(base.note).toContain('2025 YTD');
  });

  it('builds LTM = FY(n-1) + YTD(n) - YTD(n-1) when the prior-year YTD exists', () => {
    const { rows } = normaliseStatements([...SRM, is('2024 YTD (Jan - Sep 2024)', { revenue: 20.0, ebit: 1.5, da: 0.5 })]);
    const base = selectBasePeriod(rows)!;
    expect(base.basis).toBe('LTM');
    expect(base.label).toBe('LTM Sep 2025');
    expect(base.row.revenue).toBeCloseTo(27.3214 + 28.9823 - 20.0, 2);
    expect(base.row.ebitda).toBeCloseTo(2.8 + 4.0 - 2.0, 3);
  });

  it('seeds growth from full years over the real span, costs from the full-year average', () => {
    const a = deriveDefaults(normaliseStatements(SRM).rows);
    // 2021 → FY2024 is 3 years: (27.32/12.50)^(1/3) - 1 ≈ 29.8%
    expect(a.lineDrivers.revenue.values[0]).toBeCloseTo(29.8, 0);
    // Operating costs implied as revenue − EBITDA; the 9-month YTD is excluded.
    const margin = 100 - a.lineDrivers.total_opex.values[0];
    expect(margin).toBeCloseTo(((2.2 / 20.9597 + 2.8 / 27.3214) / 2) * 100, 1);
  });
});

describe('workbook entry values (D2)', () => {
  it('has a non-zero entry EBITDA from the base period, and live entry formulas', async () => {
    const { rows } = normaliseStatements(SRM);
    const buffer = await buildModelWorkbook({ assumptions: deriveDefaults(rows), history: rows, context: CONTEXT });
    const wb = await load(buffer);
    const proj = wb.getWorksheet(SHEETS.projections)!;
    const PL = rowsFor(rows).pl;
    expect(proj.getRow(PL.header).getCell(2).value).toBe('FY2024 (Jan - Dec 2024) A');
    expect(proj.getRow(PL.row.revenue).getCell(2).value).toBeCloseTo(27.321, 2);
    // Base EBITDA is a formula over its lines; the implied costs make it 2.8.
    expect(formula(proj.getRow(PL.row.ebitda).getCell(2).value)).toBe(`B${PL.row.revenue}-B${PL.row.total_opex}`);
    expect(proj.getRow(PL.row.total_opex).getCell(2).value).toBeCloseTo(27.3214 - 2.8, 3);
    // Net income sits on the same row on both sheets; FCF has its own row.
    expect(proj.getRow(PL.fcf).getCell(1).value).toBe('Unlevered FCF');
    expect(proj.getRow(PL.row.net_income).getCell(1).value).toBe('Net income');
    expect(wb.getWorksheet(SHEETS.historicals)!.getRow(PL.row.net_income).getCell(1).value).toBe('Net income');
    // exceljs doesn't read calcPr back on load — check the written XML.
    const workbookXml = await (await JSZip.loadAsync(buffer)).file('xl/workbook.xml')!.async('string');
    expect(workbookXml).toMatch(/fullCalcOnLoad="(1|true)"/);

    const notes = JSON.stringify(wb.getWorksheet(SHEETS.notes)!.getSheetValues());
    expect(notes).toContain('last full fiscal year');
    expect(notes).not.toContain('cash sweeps are not modelled');
  });

  it("falls back to the deal's EBITDA and warns when none can be found", async () => {
    const rows = [{ period: '2024', revenue: 10 }];
    const withDeal = await load(await buildModelWorkbook({
      assumptions: deriveDefaults(rows), history: rows, context: { ...CONTEXT, fallbackEntryEbitda: 1.5 },
    }));
    const PL = rowsFor(rows).pl.row;
    // Entry EBITDA = revenue − implied operating costs = the deal's 1.5.
    expect(withDeal.getWorksheet(SHEETS.projections)!.getRow(PL.total_opex).getCell(2).value).toBe(8.5);
    expect(JSON.stringify(withDeal.getWorksheet(SHEETS.notes)!.getSheetValues())).toContain("deal's recorded EBITDA");

    const none = await load(await buildModelWorkbook({ assumptions: deriveDefaults(rows), history: rows, context: CONTEXT }));
    expect(JSON.stringify(none.getWorksheet(SHEETS.notes)!.getSheetValues())).toContain('WARNING: no entry EBITDA');
  });

  it('flags a large gap between the statements EBITDA and the deal record (SRM: 2.21 vs 6.1)', async () => {
    const rows = [{ period: '2024', revenue: 27.3, ebitda: 2.21, ebitdaDerived: true }];
    const wb = await load(await buildModelWorkbook({
      assumptions: deriveDefaults(rows), history: rows, context: { ...CONTEXT, fallbackEntryEbitda: 6.1 },
    }));
    const PL = rowsFor(rows).pl.row;
    expect(wb.getWorksheet(SHEETS.projections)!.getRow(PL.total_opex).getCell(2).value).toBeCloseTo(27.3 - 2.21, 6);
    expect(JSON.stringify(wb.getWorksheet(SHEETS.notes)!.getSheetValues())).toContain('the deal record says 6.10');
  });

  it('entrySeed drops the deal multiple only when the EBITDAs disagree and the statements drive entry', async () => {
    const gap = entrySeed({ impliedMultiple: 5.5, dealEbitda: 6.1, statementsEbitda: 2.21, entrySource: 'base' });
    expect(gap.evMultiple).toBeNull();
    expect(gap.warnings).toHaveLength(2);
    const close = entrySeed({ impliedMultiple: 5.5, dealEbitda: 2.3, statementsEbitda: 2.21, entrySource: 'base' });
    expect(close).toEqual({ evMultiple: 5.5, warnings: [] });
    // Entry EBITDA IS the deal record's (no EBITDA in the statements): the multiple is consistent.
    const fromDeal = entrySeed({ impliedMultiple: 5.5, dealEbitda: 6.1, statementsEbitda: null, entrySource: 'deal' });
    expect(fromDeal).toEqual({ evMultiple: 5.5, warnings: [] });
  });

  it('honours entryBasis REVENUE and debtQuantumMode ABSOLUTE', async () => {
    const { rows } = normaliseStatements(SRM);
    const a = { ...deriveDefaults(rows), entryBasis: 'REVENUE' as const, entryMultiple: 1.2, debtQuantumMode: 'ABSOLUTE' as const, debtQuantum: 10 };
    const wb = await load(await buildModelWorkbook({ assumptions: a, history: rows, context: CONTEXT }));
    const ret = wb.getWorksheet(SHEETS.returns)!;
    const reg = rowsFor(rows);
    expect(formula(ret.getRow(RETURNS_ROWS.entryEv).getCell(2).value)).toBe(`${SHEETS.projections}!B${reg.pl.row.revenue}*${reg.scalar('entryMultiple')}`);
    expect(formula(ret.getRow(RETURNS_ROWS.debt).getCell(2).value)).toBe(reg.scalar('debtQuantum'));
  });

  it('leaves the historical EBITDA margin blank (not 0%) when EBITDA is missing', async () => {
    const rows = [{ period: '2023', revenue: 9 }, { period: '2024', revenue: 10, ebitda: 2 }];
    const wb = await load(await buildModelWorkbook({ assumptions: deriveDefaults(rows), history: rows, context: CONTEXT }));
    const reg = rowsFor(rows);
    const f = formula(wb.getWorksheet(SHEETS.historicals)!.getRow(reg.pl.ebitdaMargin).getCell(2).value);
    expect(f).toContain(`ISBLANK(B${reg.pl.row.ebitda})`);
    expect(wb.getWorksheet(SHEETS.historicals)!.getRow(reg.pl.row.ebitda).getCell(2).value ?? null).toBeNull();
  });
});
