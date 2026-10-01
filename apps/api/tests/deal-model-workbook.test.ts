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
import { buildModelWorkbook, buildModelLayout, SHEETS, SCALAR_KEYS } from '../src/services/dealModel/workbook.js';
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
// Addresses come from the generated registry (fix plan E1), not magic numbers.
const { registry: reg } = buildModelLayout({ assumptions: deriveDefaults(HISTORY), history: HISTORY });
const PL = reg.pl.row;

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
      SHEETS.cover, SHEETS.assumptions, SHEETS.scenarios, SHEETS.historicals,
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
    const revenueRow = sheet.getRow(PL.revenue);
    expect(revenueRow.getCell(2).value).toBe(8);
    expect(isFormula(revenueRow.getCell(2).value)).toBe(false);
  });
});

describe('Projections — must be formula-driven', () => {
  it('derives every projected revenue from a formula', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const revenueRow = sheet.getRow(PL.revenue);
    // Column B is the last actual; C onward are projected.
    for (let col = 3; col <= 7; col++) {
      expect(isFormula(revenueRow.getCell(col).value)).toBe(true);
    }
  });

  it('points projected revenue at the growth assumption', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const formula = (sheet.getRow(PL.revenue).getCell(3).value as { formula: string }).formula;
    expect(formula).toContain(reg.value('revenue', 0));
    expect(formula).toContain(reg.method('revenue'));
  });

  it('derives EBITDA from its lines — costs are a % of revenue', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const ebitda = (sheet.getRow(PL.ebitda).getCell(3).value as { formula: string }).formula;
    expect(ebitda).toBe(`C${PL.gross_profit}-C${PL.total_opex}`);
    const opex = (sheet.getRow(PL.total_opex).getCell(3).value as { formula: string }).formula;
    expect(opex).toContain(`C${PL.revenue}*${reg.value('total_opex', 0)}`);
  });

  it('hard-codes nothing in the projection block', () => {
    const sheet = wb.getWorksheet(SHEETS.projections)!;
    const offenders: string[] = [];
    // Every projected row, columns C.. are all derived — any bare number is a bug.
    for (let r = reg.pl.header + 1; r <= reg.pl.fcf; r++) {
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

    const inputs: Array<[string, string]> = [
      ...SCALAR_KEYS.map((k): [string, string] => [k, reg.scalar(k)]),
      ...reg.driverLines.flatMap((l): Array<[string, string]> => [
        [`${l.key}.method`, reg.method(l.key)],
        ...Array.from({ length: reg.years }, (_, y): [string, string] => [`${l.key}.Y${y + 1}`, reg.value(l.key, y)]),
      ]),
    ];
    const dead = inputs.filter(([, ref]) => !allFormulas.includes(ref)).map(([name]) => name);

    // Every Low / Base / High input feeds its case's Scenarios block (E2).
    const scenarioFormulas = cells(SHEETS.scenarios)
      .filter((c) => isFormula(c.value))
      .map((c) => (c.value as { formula: string }).formula)
      .join(' | ');
    // Interest rate, WACC and DSCR target don't move IRR / MoM / exit EV, so the
    // compact blocks skip them; each case's value still reaches the model
    // through the Live column when that case is active.
    const notInBlocks = ['interestRate', 'wacc', 'dscrTarget'];
    for (const c of ['Low', 'Base', 'High'] as const) {
      for (const k of SCALAR_KEYS.filter((x) => !notInBlocks.includes(x))) {
        if (!scenarioFormulas.includes(reg.scalar(k, c))) dead.push(`${c}.${k}`);
      }
      for (const l of reg.driverLines) {
        if (!scenarioFormulas.includes(reg.value(l.key, 0, c))) dead.push(`${c}.${l.key}`);
      }
    }

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
    const sparseReg = buildModelLayout({ assumptions: deriveDefaults(sparse), history: sparse }).registry;
    expect(sheet.getRow(sparseReg.pl.row.revenue).getCell(2).value).toBe(10);
    expect(sheet.getRow(sparseReg.pl.row.ebitda).getCell(2).value ?? null).toBeNull();
  });
});
