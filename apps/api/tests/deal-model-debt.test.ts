/**
 * Fix plan E3 in the workbook: working-capital / capex driver rows (Low /
 * Base / High + Live), the cash-flow block on Projections, opening net debt
 * in sources & uses, the two-tranche debt and cash schedule (interest on
 * the average balance, levered-FCF sweep), the Scenarios blocks, the
 * Historicals balance-sheet block — and no circular references.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { normaliseStatements, deriveDefaults, resolveAssumptions } from '../src/services/dealModel/assumptions.js';
import {
  buildModelWorkbook, buildModelLayout, scenarioLayout, SHEETS, SCALAR_KEYS, RETURNS_ROWS as R,
} from '../src/services/dealModel/workbook.js';
import { bsKey } from '../src/services/dealModel/workbook/registry.js';
import { SRM_FULL_STATEMENTS, SRM_CONTEXT } from './helpers/srmModelFixture.js';
import { findCycle } from './helpers/workbookGraph.js';

const history = normaliseStatements(SRM_FULL_STATEMENTS).rows;
const assumptions = { ...deriveDefaults(history), debt2Quantum: 1, debt2AmortPct: 2, minCash: 0.5 };
const layout = buildModelLayout({ assumptions, history });
const reg = layout.registry;
const PL = reg.pl.row;
const CF = reg.pl.cf;
const f = (v: unknown) => (v as { formula?: string })?.formula ?? '';
let wb: ExcelJS.Workbook;
const sheet = (n: string) => wb.getWorksheet(n)!;

beforeAll(async () => {
  wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildModelWorkbook({ assumptions, history, context: SRM_CONTEXT })) as never);
});

describe('Assumptions — working capital, capex and debt inputs', () => {
  it('writes a Low / Base / High / Live block per series (days as numbers, % as fractions)', () => {
    expect(reg.balanceKeys).toEqual(['dso', 'dio', 'dpo', 'capexMaintPct', 'capexGrowthPct']);
    const a = sheet(SHEETS.assumptions);
    const rows = reg.assumptions.driverRow[bsKey('dso')];
    expect(a.getCell(rows.Base, 3).value).toBe('Days');
    expect(a.getCell(rows.Base, 4).value).toBe(assumptions.balanceDrivers.dso[0]);
    expect(a.getCell(rows.High, 4).font?.color?.argb).toBe('FF0000CC');
    expect(f(a.getCell(rows.Live, 5).value)).toBe(`CHOOSE($B$5,E${rows.Low},E${rows.Base},E${rows.High})`);
    const capex = reg.assumptions.driverRow[bsKey('capexGrowthPct')];
    expect(a.getCell(capex.Low, 4).value).toBeCloseTo(assumptions.balanceDrivers.capexGrowthPct[0] / 100, 9);
  });

  it('carries both tranches and the minimum cash as scalars with a Live column', () => {
    const a = sheet(SHEETS.assumptions);
    for (const k of ['debt2Quantum', 'debt2InterestRate', 'debt2AmortPct', 'minCash'] as const) {
      const row = reg.assumptions.scalarRow[k];
      expect(f(a.getCell(row, 5).value)).toBe(`CHOOSE($B$5,B${row},C${row},D${row})`);
    }
    expect(a.getCell(reg.assumptions.scalarRow.debt2Quantum, 1).value).toBe('Second tranche debt (x EBITDA)');
    expect(a.getCell(reg.assumptions.scalarRow.minCash, 3).value).toBe(0.5);
  });
});

describe('Projections — cash-flow block', () => {
  const p = () => sheet(SHEETS.projections);

  it('starts working capital from the FY2024 balance sheet (blue) and projects it with Live days', () => {
    expect(p().getCell(CF.ar!, 2).value).toBe(3.6);
    expect(p().getCell(CF.ap!, 2).font?.color?.argb).toBe('FF0000CC');
    expect(f(p().getCell(CF.ar!, 3).value)).toBe(`C${PL.revenue}*${reg.value(bsKey('dso'), 0)}/365`);
    expect(f(p().getCell(CF.inventory!, 4).value)).toBe(`D${PL.cogs}*${reg.value(bsKey('dio'), 1)}/365`);
    expect(f(p().getCell(CF.nwc!, 3).value)).toBe(`C${CF.ar}+C${CF.inventory}-C${CF.ap}`);
    expect(f(p().getCell(CF.dNwc!, 3).value)).toBe(`C${CF.nwc}-B${CF.nwc}`);
  });

  it('builds capex from maintenance + growth and both FCF lines from it', () => {
    expect(f(p().getCell(CF.capexGrowth!, 3).value)).toBe(`C${PL.revenue}*${reg.value(bsKey('capexGrowthPct'), 0)}`);
    expect(f(p().getCell(CF.capex!, 3).value)).toBe(`C${CF.capexMaint}+C${CF.capexGrowth}`);
    expect(f(p().getCell(reg.pl.fcf, 3).value)).toBe(`C${PL.ebit}*(1-${reg.scalar('taxRate')})+C${PL.da}-C${CF.capex}-C${CF.dNwc}`);
    expect(f(p().getCell(reg.pl.lfcf, 3).value)).toBe(`C${PL.net_income}+C${PL.da}-C${CF.capex}-C${CF.dNwc}`);
  });
});

describe('Returns — sources & uses, two tranches, levered sweep, cash', () => {
  const r = () => sheet(SHEETS.returns);

  it('puts the opening net debt from the latest full-year balance sheet into sources & uses, and balances', () => {
    expect(r().getCell(R.existingDebt, 2).value).toBe(4.6);
    expect(r().getCell(R.existingCash, 2).value).toBe(0.9);
    expect(String(r().getCell(R.existingDebt, 1).value)).toContain('FY2024');
    expect(f(r().getCell(R.netDebt, 2).value)).toBe(`B${R.existingDebt}-B${R.existingCash}`);
    expect(f(r().getCell(R.usesEquity, 2).value)).toBe(`B${R.entryEv}-B${R.netDebt}`);
    expect(f(r().getCell(R.equity, 2).value)).toBe(`B${R.entryEv}+B${R.fees}+B${R.minCash}-B${R.totalDebt}`);
    expect(f(r().getCell(R.debt2, 2).value)).toBe(`B${R.entryEbitda}*${reg.scalar('debt2Quantum')}`);
    expect(f(r().getCell(R.totalSources, 2).value)).toBe(`SUM(B${R.srcSenior}:B${R.srcEquity})`);
  });

  it('charges interest on the average balance after scheduled amortisation — never on the sweep', () => {
    expect(f(r().getCell(R.mand1, 3).value)).toBe(`MIN(C${R.open1},$B$${R.debt}*${reg.scalar('amortPctPerYear')})`);
    expect(f(r().getCell(R.int1, 3).value)).toBe(`(C${R.open1}-C${R.mand1}/2)*${reg.scalar('interestRate')}`);
    expect(f(r().getCell(R.int2, 2).value)).toBe(`(B${R.open2}-B${R.mand2}/2)*${reg.scalar('debt2InterestRate')}`);
    expect(f(sheet(SHEETS.projections).getCell(PL.interest_expense, 4).value)).toBe(`${SHEETS.returns}!C${R.interest}`);
  });

  it('sweeps levered FCF above the minimum cash, senior first, and tracks the cash balance', () => {
    expect(f(r().getCell(R.lfcf, 2).value)).toBe(`${SHEETS.projections}!C${reg.pl.lfcf}`);
    expect(f(r().getCell(R.cashOpen, 2).value)).toBe(`$B$${R.minCash}`);
    expect(f(r().getCell(R.cashOpen, 3).value)).toBe(`B${R.cashClose}`);
    expect(f(r().getCell(R.available, 2).value)).toBe(
      `MAX(0,B${R.cashOpen}+B${R.lfcf}-B${R.mand1}-B${R.mand2}-$B$${R.minCash})*${reg.scalar('cashSweepPct')}`,
    );
    expect(f(r().getCell(R.sweep1, 2).value)).toBe(`MIN(B${R.open1}-B${R.mand1},B${R.available})`);
    expect(f(r().getCell(R.sweep2, 2).value)).toBe(`MIN(B${R.open2}-B${R.mand2},B${R.available}-B${R.sweep1})`);
    expect(f(r().getCell(R.exitEquity, 2).value)).toBe(`B${R.exitEv}-B${R.exitDebt}+B${R.exitCash}`);
    expect(f(r().getCell(R.dscr, 2).value)).toContain(`(B${R.interest}+B${R.mand1}+B${R.mand2})`);
  });
});

describe('Scenarios — every E3 input reaches its case block', () => {
  it('feeds each case\'s days, capex %, tranches and minimum cash into that case\'s block', () => {
    const s = sheet(SHEETS.scenarios);
    const formulas = (() => {
      const out: string[] = [];
      s.eachRow((row) => row.eachCell((c) => { if (f(c.value)) out.push(f(c.value)); }));
      return out.join(' | ');
    })();
    const missing: string[] = [];
    for (const c of ['Low', 'Base', 'High'] as const) {
      for (const k of SCALAR_KEYS.filter((x) => x !== 'wacc' && x !== 'dscrTarget')) {
        if (!formulas.includes(reg.scalar(k, c))) missing.push(`${c}.${k}`);
      }
      for (const k of reg.balanceKeys) {
        for (let y = 0; y < reg.years; y++) if (!formulas.includes(reg.value(bsKey(k), y, c))) missing.push(`${c}.${k}.Y${y + 1}`);
      }
    }
    expect(missing).toEqual([]);
    const block = scenarioLayout(reg).block.Low;
    expect(f(s.getCell(block.cf.ar!, 3).value)).toBe(`C${block.line.revenue}*${reg.value(bsKey('dso'), 0, 'Low')}/365`);
    expect(f(s.getCell(block.cf.ar!, 2).value)).toBe(`${SHEETS.projections}!$B$${CF.ar}`);
    expect(f(s.getCell(block.line.interest_expense, 3).value)).toBe(`C${block.row.interest}`);
    expect(f(s.getCell(block.row.lfcf, 3).value)).toBe(`C${block.cf.lfcf}`);
  });

  it('feeds every main-model input to Projections / Returns (no dead cells)', () => {
    const all: string[] = [];
    for (const n of [SHEETS.projections, SHEETS.returns, SHEETS.sensitivity]) {
      sheet(n).eachRow((row) => row.eachCell((c) => { if (f(c.value)) all.push(f(c.value)); }));
    }
    const text = all.join(' | ');
    const dead = [
      ...SCALAR_KEYS.filter((k) => !text.includes(reg.scalar(k))),
      ...reg.balanceKeys.filter((k) => !text.includes(reg.value(bsKey(k), reg.years - 1))),
    ];
    expect(dead).toEqual([]);
  });
});

describe('Historicals — balance sheet and cash flow block', () => {
  it('lists the items per period and the full-year days / capex ratios as formulas', () => {
    const h = sheet(SHEETS.historicals);
    const rowOf = (text: string) => {
      let n = 0;
      h.eachRow((row, i) => { if (String(row.getCell(1).value) === text) n = i; });
      return n;
    };
    expect(h.getCell(rowOf('Accounts receivable'), 3).value).toBe(3.6);
    expect(h.getCell(rowOf('Growth capex'), 2).value).toBeCloseTo(0.6, 9);
    const dso = rowOf('DSO (days)');
    expect(f(h.getCell(dso, 3).value)).toBe(`IF(C${PL.revenue}=0,"",C${rowOf('Accounts receivable')}/C${PL.revenue}*365)`);
    expect(h.getCell(dso, 4).value ?? null).toBeNull(); // the YTD column: not a year
  });
});

describe('no circular references', () => {
  it('holds for days + split capex + two tranches (interest never reads the sweep)', () => {
    expect(findCycle(wb)).toBeNull();
  });

  it('holds for a model loaded from pre-E3 assumptions (% of revenue working capital)', async () => {
    const { balanceDrivers: _b, ...rest } = deriveDefaults(history);
    const legacy = resolveAssumptions({ ...rest, nwcPctRevenue: 10, capexPctRevenue: 3 }, history);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildModelWorkbook({ assumptions: legacy, history, context: SRM_CONTEXT })) as never);
    expect(findCycle(book)).toBeNull();
    const legacyReg = buildModelLayout({ assumptions: legacy, history }).registry;
    const nwc = legacyReg.pl.cf.nwc!;
    expect(legacyReg.pl.cf.ar).toBeUndefined();
    expect(f(book.getWorksheet(SHEETS.projections)!.getCell(nwc, 2).value))
      .toBe(`B${legacyReg.pl.row.revenue}*${legacyReg.value(bsKey('nwcPct'), 0)}`);
  });
});
