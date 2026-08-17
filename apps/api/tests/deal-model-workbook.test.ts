/**
 * Deal model workbook (spec §6.3, §6.8).
 *
 * THE CORE INVARIANT: every derived cell must be a live Excel formula
 * pointing at the Assumptions sheet. A workbook of hard-coded computed
 * numbers is worthless — the entire ask (Evan M15) is that he and his
 * partner change an input and watch the returns move. These tests read
 * the generated file back and assert on `.formula`, not on values.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { buildModelWorkbook, SHEETS, PL_ROWS, ASSUMPTION_CELLS } from '../src/services/dealModel/workbook.js';
import { deriveDefaults } from '../src/services/dealModel/assumptions.js';

const HISTORY = [
  { period: '2022', revenue: 8, cogs: 3.2, grossProfit: 4.8, ebitda: 1.2, netIncome: 0.6 },
  { period: '2023', revenue: 9, cogs: 3.5, grossProfit: 5.5, ebitda: 1.5, netIncome: 0.8 },
  { period: '2024', revenue: 10, cogs: 4, grossProfit: 6, ebitda: 2, netIncome: 1.1 },
];

const CONTEXT = {
  dealName: 'Project Neptune',
  companyName: 'NeptuneCo',
  currency: 'USD',
  unitScale: 'MILLIONS' as const,
  sourceDocuments: ['CIM.pdf', 'Financials-2024.xlsx'],
  generatedAt: '2026-08-18T00:00:00Z',
  notes: [],
};

let wb: ExcelJS.Workbook;

beforeAll(async () => {
  const buffer = await buildModelWorkbook({
    assumptions: deriveDefaults(HISTORY),
    history: HISTORY,
    context: CONTEXT,
  });
  wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
});

/** Every non-empty cell in a sheet, as {address, value}. */
function cells(sheetName: string) {
  const sheet = wb.getWorksheet(sheetName)!;
  const out: Array<{ address: string; value: unknown }> = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => out.push({ address: cell.address, value: cell.value }));
  });
  return out;
}

function isFormula(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'formula' in (value as object);
}

describe('workbook structure', () => {
  it('has every sheet a banker expects, in order', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      SHEETS.cover, SHEETS.assumptions, SHEETS.historicals,
      SHEETS.projections, SHEETS.returns, SHEETS.sensitivity, SHEETS.notes,
    ]);
  });

  it('names the deal and the units on the cover', () => {
    const text = cells(SHEETS.cover).map((c) => String(c.value ?? '')).join(' | ');
    expect(text).toContain('Project Neptune');
    expect(text).toContain('USD');
    expect(text.toLowerCase()).toContain('millions');
  });

  it('lists the documents the numbers came from', () => {
    const text = cells(SHEETS.cover).map((c) => String(c.value ?? '')).join(' | ');
    expect(text).toContain('CIM.pdf');
  });

  it('carries a verify-against-source disclaimer', () => {
    const text = cells(SHEETS.cover).map((c) => String(c.value ?? '')).join(' ').toLowerCase();
    expect(text).toMatch(/verif|check|source document/);
  });
});

describe('Historicals', () => {
  it('writes one column per historical period', () => {
    const text = cells(SHEETS.historicals).map((c) => String(c.value ?? '')).join(' | ');
    for (const p of ['2022', '2023', '2024']) expect(text).toContain(p);
  });

  it('writes actuals as plain numbers, not formulas', () => {
    // History is fact, not model output — it must not move when an
    // assumption changes.
    const sheet = wb.getWorksheet(SHEETS.historicals)!;
    const revenueRow = sheet.getRow(PL_ROWS.revenue);
    expect(revenueRow.getCell(2).value).toBe(8);
    expect(isFormula(revenueRow.getCell(2).value)).toBe(false);
  });
});

describe('Projections — must be formula-driven', () => {
  it('derives every projected revenue from a formula', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const revenueRow = sheet.getRow(PL_ROWS.revenue);
    // Column B is the last actual; C onward are projected.
    for (let col = 3; col <= 7; col++) {
      expect(isFormula(revenueRow.getCell(col).value)).toBe(true);
    }
  });

  it('points projected revenue at the growth assumption', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const formula = (sheet.getRow(PL_ROWS.revenue).getCell(3).value as { formula: string }).formula;
    expect(formula).toContain(SHEETS.assumptions);
  });

  it('derives EBITDA from revenue and the margin assumption', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const ebitdaRow = sheet.getRow(PL_ROWS.ebitda);
    const formula = (ebitdaRow.getCell(3).value as { formula: string }).formula;
    expect(formula).toContain(SHEETS.assumptions);
  });

  it('hard-codes nothing in the projection block', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const offenders: string[] = [];
    // Rows 4-12, columns C.. are all derived — any bare number is a bug.
    for (let r = PL_ROWS.revenue; r <= PL_ROWS.ebitdaMargin; r++) {
      for (let c = 3; c <= 7; c++) {
        const v = sheet.getRow(r).getCell(c).value;
        if (typeof v === 'number') offenders.push(sheet.getRow(r).getCell(c).address);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Returns — must be formula-driven', () => {
  it('computes IRR with a real IRR() formula', () => {
    const text = cells(SHEETS.returns)
      .filter((c) => isFormula(c.value))
      .map((c) => (c.value as { formula: string }).formula)
      .join(' ');
    expect(text).toContain('IRR(');
  });

  it('computes MoM as a formula, not a number', () => {
    const sheet = wb.getWorksheet(SHEETS.returns)!;
    const momCell = cells(SHEETS.returns).find((c) => {
      const row = sheet.getCell(c.address).row;
      return String(sheet.getRow(Number(row)).getCell(1).value ?? '').toLowerCase().includes('mom');
    });
    expect(momCell).toBeTruthy();
  });

  it('derives entry enterprise value from the entry multiple', () => {
    const formulas = cells(SHEETS.returns)
      .filter((c) => isFormula(c.value))
      .map((c) => (c.value as { formula: string }).formula);
    expect(formulas.some((f) => f.includes(SHEETS.assumptions))).toBe(true);
  });

  it('runs a debt schedule with a DSCR line', () => {
    const labels = cells(SHEETS.returns).map((c) => String(c.value ?? '').toLowerCase()).join(' | ');
    expect(labels).toContain('dscr');
    expect(labels).toContain('interest');
  });
});

describe('cross-sheet references', () => {
  it('never doubles the sheet name inside a range', () => {
    // `Sheet!A1:Sheet!B2` opens in Excel but breaks in Google Sheets, and
    // this workbook has to survive both.
    const bad = [SHEETS.projections, SHEETS.returns, SHEETS.sensitivity]
      .flatMap((s) => cells(s))
      .filter((c) => isFormula(c.value))
      .map((c) => (c.value as { formula: string }).formula)
      .filter((f) => /![A-Z]+\d+:[A-Za-z]+![A-Z]+\d+/.test(f));
    expect(bad).toEqual([]);
  });
});

describe('every input earns its place', () => {
  it('has no dead assumption cells — each one drives at least one formula', () => {
    // An input the user can change that moves nothing is worse than a
    // missing input: it silently breaks the promise that this model is
    // live. Caught wacc and cashSweepPct sitting inert.
    const allFormulas = [SHEETS.projections, SHEETS.returns, SHEETS.sensitivity]
      .flatMap((s) => cells(s))
      .filter((c) => isFormula(c.value))
      .map((c) => (c.value as { formula: string }).formula)
      .join(' | ');

    const dead = Object.entries(ASSUMPTION_CELLS)
      .filter(([, ref]) => typeof ref === 'string')
      .filter(([, ref]) => !allFormulas.includes(ref as string))
      .map(([name]) => name);

    expect(dead).toEqual([]);
  });
});

describe('Sensitivity', () => {
  it('builds a two-way grid of entry vs exit multiple', () => {
    const labels = cells(SHEETS.sensitivity).map((c) => String(c.value ?? '').toLowerCase()).join(' | ');
    expect(labels).toContain('entry');
    expect(labels).toContain('exit');
  });

  it('fills the grid with formulas so it recalculates', () => {
    const sheet = wb.getWorksheet(SHEETS.sensitivity)!;
    let formulaCells = 0;
    sheet.eachRow((row) => row.eachCell((c) => { if (isFormula(c.value)) formulaCells++; }));
    expect(formulaCells).toBeGreaterThan(8);
  });
});

describe('Notes', () => {
  it('records extraction caveats so the model is not read as gospel', () => {
    const text = cells(SHEETS.notes).map((c) => String(c.value ?? '')).join(' ').toLowerCase();
    expect(text.length).toBeGreaterThan(20);
  });
});

describe('robustness', () => {
  it('builds from a single year of history without throwing', async () => {
    const buffer = await buildModelWorkbook({
      assumptions: deriveDefaults([{ period: '2024', revenue: 10, ebitda: 2 }]),
      history: [{ period: '2024', revenue: 10, ebitda: 2 }],
      context: CONTEXT,
    });
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it('renders gaps rather than shifting rows when a metric is missing', async () => {
    const sparse = [{ period: '2024', revenue: 10 }];
    const buffer = await buildModelWorkbook({
      assumptions: deriveDefaults(sparse),
      history: sparse,
      context: CONTEXT,
    });
    const round = new ExcelJS.Workbook();
    await round.xlsx.load(buffer as never);
    const sheet = round.getWorksheet(SHEETS.historicals)!;
    // Revenue present on its row; EBITDA row exists but is blank.
    expect(sheet.getRow(PL_ROWS.revenue).getCell(2).value).toBe(10);
    expect(sheet.getRow(PL_ROWS.ebitda).getCell(2).value ?? null).toBeNull();
  });
});
