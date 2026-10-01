// Scenarios: revenue, EBITDA, exit EV, IRR and MoM for Low / Base / High
// side by side, without macros or data tables. Each case gets a compact
// calculation block — the full P&L, the cash-flow block (working capital,
// capex, levered FCF), entry, the two-tranche debt and cash schedule, exit
// and returns — built from the same formula builders as Projections and
// Returns, but reading that case's Assumptions column instead of Live.

import type ExcelJS from 'exceljs';
import { MODEL_CASES, type ModelCase, type ModelLine } from '@ai-crm/shared';
import type { CaseSet } from '../scenarios.js';
import { cfKeys, type CfKey, type Registry } from './registry.js';
import { RETURNS_ROWS, entryFormulas } from './returns.js';
import { projectedLineFormula, type DriverRefs } from './projections.js';
import { writeCashFlowBlock } from './workingCapital.js';
import { DEBT_KEYS, writeDebtSchedule, type DebtKey } from './debtSchedule.js';
import {
  SHEETS, FMT_MONEY, FMT_MULT, FMT_PCT, colLetter, fx, label, put, styleHeaderRow, title, unitsText, type WorkbookContext,
} from './xlsx.js';

const SUMMARY_METRICS = [
  ['exitRevenue', 'Revenue (exit year)', FMT_MONEY],
  ['exitEbitda', 'EBITDA (exit year)', FMT_MONEY],
  ['exitMargin', 'EBITDA margin (exit year)', FMT_PCT],
  ['entryEv', 'Entry enterprise value', FMT_MONEY],
  ['equity', 'Equity cheque', FMT_MONEY],
  ['exitEv', 'Exit enterprise value', FMT_MONEY],
  ['exitDebt', 'Net debt at exit', FMT_MONEY],
  ['exitEquity', 'Equity proceeds', FMT_MONEY],
  ['irr', 'IRR', FMT_PCT],
  ['mom', 'MoM', FMT_MULT],
] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number][0];

const SUMMARY_HEADER = 4;
const BLOCKS_START = 21;
const ENTRY_ROWS = ['entryEbitda', 'entryEv', 'fees', 'debt', 'debt2', 'totalDebt', 'minCash', 'equity'] as const;
const EXIT_ROWS = ['exitEbitda', 'exitEv', 'exitDebt', 'exitCash', 'exitEquity', 'cashflow', 'irr', 'mom'] as const;
type BlockRow = (typeof ENTRY_ROWS)[number] | DebtKey | (typeof EXIT_ROWS)[number];
const BLOCK_ROWS: BlockRow[] = [...ENTRY_ROWS, ...DEBT_KEYS, ...EXIT_ROWS];

const NAMES: Record<(typeof ENTRY_ROWS)[number] | (typeof EXIT_ROWS)[number], string> = {
  entryEbitda: 'Entry EBITDA', entryEv: 'Entry enterprise value', fees: 'Transaction fees',
  debt: 'Senior debt raised', debt2: 'Second tranche raised', totalDebt: 'Total new debt',
  minCash: 'Minimum cash funded', equity: 'Equity cheque', exitEbitda: 'Exit-year EBITDA',
  exitEv: 'Exit enterprise value', exitDebt: 'Debt at exit', exitCash: 'Cash at exit',
  exitEquity: 'Equity proceeds', cashflow: 'Equity cash flow', irr: 'IRR', mom: 'MoM',
};

export interface ScenarioLayout {
  summaryRow: Record<SummaryMetric, number>;
  /** Column per case in the summary table. */
  summaryCol: Record<ModelCase, number>;
  activeRow: number;
  liveIrrRow: number;
  blockLines: ModelLine[];
  block: Record<ModelCase, {
    header: number; line: Record<string, number>; cf: Partial<Record<CfKey, number>>; row: Record<BlockRow, number>;
  }>;
}

export function scenarioLayout(reg: Registry): ScenarioLayout {
  const blockLines = reg.lines.filter((l) => !l.historicalOnly);
  const cfs = cfKeys(reg.methods);
  const height = blockLines.length + cfs.length + BLOCK_ROWS.length + 3;
  const block = Object.fromEntries(MODEL_CASES.map((c, k) => {
    const header = BLOCKS_START + k * height;
    const line = Object.fromEntries(blockLines.map((l, i) => [l.key, header + 1 + i]));
    const cf = Object.fromEntries(cfs.map((key, i) => [key, header + 1 + blockLines.length + i]));
    const first = header + 1 + blockLines.length + cfs.length;
    const row = Object.fromEntries(BLOCK_ROWS.map((r, i) => [r, first + i])) as Record<BlockRow, number>;
    return [c, { header, line, cf, row }];
  })) as ScenarioLayout['block'];
  return {
    summaryRow: Object.fromEntries(SUMMARY_METRICS.map(([m], i) => [m, SUMMARY_HEADER + 1 + i])) as Record<SummaryMetric, number>,
    summaryCol: { Low: 2, Base: 3, High: 4 },
    activeRow: SUMMARY_HEADER + SUMMARY_METRICS.length + 2,
    liveIrrRow: SUMMARY_HEADER + SUMMARY_METRICS.length + 3,
    blockLines,
    block,
  };
}

function writeBlock(sheet: ExcelJS.Worksheet, reg: Registry, cases: CaseSet, c: ModelCase, layout: ScenarioLayout) {
  const years = reg.years;
  const { header, line, cf, row } = layout.block[c];
  const refs: DriverRefs = {
    method: (key) => reg.method(key, c),
    value: (key, y) => reg.value(key, y, c),
    scalar: (name) => reg.scalar(name, c),
    interest: (y) => `${colLetter(3 + y)}${row.interest}`,
  };
  const S = refs.scalar;
  const last = colLetter(2 + years);
  const at = (key: string) => line[key];

  const h = sheet.getRow(header);
  h.getCell(1).value = `${c} case`;
  h.getCell(2).value = 'Base';
  for (let y = 0; y < years; y++) h.getCell(3 + y).value = `Y${y + 1}`;
  styleHeaderRow(h);

  for (const l of layout.blockLines) {
    const r = at(l.key);
    label(sheet, r, l.label, l.kind === 'SUBTOTAL', l.level);
    put(sheet, r, 2, fx(`${SHEETS.projections}!$B$${reg.pl.row[l.key]}`), FMT_MONEY);
    for (let y = 0; y < years; y++) {
      put(sheet, r, 3 + y, fx(projectedLineFormula(l, y, colLetter(3 + y), colLetter(2 + y), at, refs)!), FMT_MONEY);
    }
  }
  writeCashFlowBlock(sheet, {
    rows: cf, methods: reg.methods, line: at, refs, years,
    baseBalance: (k) => fx(`${SHEETS.projections}!$B$${reg.pl.cf[k]}`),
  });

  for (const k of [...ENTRY_ROWS, ...EXIT_ROWS]) label(sheet, row[k], NAMES[k], k === 'irr' || k === 'mom' || k === 'equity');
  const entry = entryFormulas(cases.Base, row, S, `B${at('revenue')}`); // structural choices are the Base case's
  put(sheet, row.entryEbitda, 2, fx(`B${at('ebitda')}`), FMT_MONEY);
  for (const k of ['entryEv', 'fees', 'debt', 'debt2', 'totalDebt', 'minCash', 'equity'] as const) {
    put(sheet, row[k], 2, fx(entry[k]), FMT_MONEY);
  }

  writeDebtSchedule(sheet, {
    rows: row, years, yearCol: (y) => 3 + y,
    lfcf: (y) => `${colLetter(3 + y)}${cf.lfcf}`,
    senior: `$B$${row.debt}`, second: `$B$${row.debt2}`, minCash: `$B$${row.minCash}`, scalar: S,
  });

  const exitAt = (r: number) => `INDEX(C${r}:${last}${r},1,${S('exitYear')})`;
  put(sheet, row.exitEbitda, 2, fx(exitAt(at('ebitda'))), FMT_MONEY);
  put(sheet, row.exitEv, 2, fx(`B${row.exitEbitda}*${S('exitMultiple')}`), FMT_MONEY);
  put(sheet, row.exitDebt, 2, fx(exitAt(row.closing)), FMT_MONEY);
  put(sheet, row.exitCash, 2, fx(exitAt(row.cashClose)), FMT_MONEY);
  put(sheet, row.exitEquity, 2, fx(`B${row.exitEv}-B${row.exitDebt}+B${row.exitCash}`), FMT_MONEY);
  put(sheet, row.cashflow, 2, fx(`-B${row.equity}`), FMT_MONEY);
  for (let y = 0; y < years; y++) {
    put(sheet, row.cashflow, 3 + y, fx(`IF(${y + 1}=${S('exitYear')},$B$${row.exitEquity},0)`), FMT_MONEY);
  }
  put(sheet, row.irr, 2, fx(`IFERROR(IRR(B${row.cashflow}:${last}${row.cashflow}),"n/a")`), FMT_PCT);
  put(sheet, row.mom, 2, fx(`IF(B${row.equity}=0,"",B${row.exitEquity}/B${row.equity})`), FMT_MULT);

  for (let r = header + 1; r <= row.mom; r++) sheet.getRow(r).outlineLevel = 1;
}

export function writeScenarios(sheet: ExcelJS.Worksheet, cases: CaseSet, reg: Registry, ctx: WorkbookContext): ScenarioLayout {
  const layout = scenarioLayout(reg);
  const years = reg.years;
  sheet.columns = [{ width: 34 }, ...Array.from({ length: years + 1 }, () => ({ width: 14 }))];
  sheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  title(sheet, 'Scenarios — Low / Base / High', `${unitsText(ctx)} — all three cases computed side by side; the Active case on Assumptions drives every other sheet`);

  const head = sheet.getRow(SUMMARY_HEADER);
  head.getCell(1).value = 'Metric';
  for (const c of MODEL_CASES) head.getCell(layout.summaryCol[c]).value = c;
  styleHeaderRow(head);

  for (const [metric, name, fmt] of SUMMARY_METRICS) {
    const r = layout.summaryRow[metric];
    label(sheet, r, name, metric === 'irr' || metric === 'mom');
    for (const c of MODEL_CASES) {
      const { line, row } = layout.block[c];
      const last = colLetter(2 + years);
      const exitYear = reg.scalar('exitYear', c);
      const exitRev = `INDEX(C${line.revenue}:${last}${line.revenue},1,${exitYear})`;
      const formula: Record<SummaryMetric, string> = {
        exitRevenue: exitRev,
        exitEbitda: `B${row.exitEbitda}`,
        exitMargin: `IF(${exitRev}=0,"",B${row.exitEbitda}/${exitRev})`,
        entryEv: `B${row.entryEv}`,
        equity: `B${row.equity}`,
        exitEv: `B${row.exitEv}`,
        exitDebt: `B${row.exitDebt}-B${row.exitCash}`,
        exitEquity: `B${row.exitEquity}`,
        irr: `B${row.irr}`,
        mom: `B${row.mom}`,
      };
      put(sheet, r, layout.summaryCol[c], fx(formula[metric]), fmt);
    }
  }

  label(sheet, layout.activeRow, 'Active case (set on Assumptions)');
  put(sheet, layout.activeRow, 2, fx(reg.assumptions.activeCase));
  label(sheet, layout.liveIrrRow, 'IRR on the Returns sheet (= active case)');
  put(sheet, layout.liveIrrRow, 2, fx(`${SHEETS.returns}!B${RETURNS_ROWS.irr}`), FMT_PCT);

  for (const c of MODEL_CASES) writeBlock(sheet, reg, cases, c, layout);
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: SUMMARY_HEADER }];
  return layout;
}
