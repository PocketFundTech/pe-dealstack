/**
 * Every formula in the model workbook carries a cached value (calc.ts).
 *
 * Without one, a formula cell is blank in anything that doesn't recalculate
 * on open — Excel's Protected View (every downloaded file opens in it), Mac
 * Quick Look, email / chat previews — which is how the team's first model
 * export looked "mostly empty" to Pushkar.
 *
 * This reads the raw sheet XML, not ExcelJS's `cell.value` getter: that
 * getter silently drops a cached result of exactly `0` (it copies the
 * formula model through a truthy check), so a test built on it would pass
 * even for cells calc.ts left genuinely uncached. The XML is what Excel,
 * Quick Look and every preview actually parse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import { buildModelWorkbook } from '../src/services/dealModel/workbook.js';
import { deriveDefaults } from '../src/services/dealModel/assumptions.js';
import { irr } from '../src/services/dealModel/workbook/calc.js';
import { SHEETS } from '../src/services/dealModel/workbook/xlsx.js';
import { RETURNS_ROWS } from '../src/services/dealModel/workbook/returns.js';

// Shaped like the Strong Ready Mix test: three fiscal years and a YTD stub.
const HISTORY = [
  { period: 'FY2022', revenue: 18.2, cogs: 12.1, grossProfit: 6.1, ebitda: 1.9, netIncome: 0.9 },
  { period: 'FY2023', revenue: 20.4, cogs: 13.5, grossProfit: 6.9, ebitda: 2.0, netIncome: 1.0 },
  { period: 'FY2024', revenue: 22.0, cogs: 14.4, grossProfit: 7.6, ebitda: 2.21, netIncome: 1.2 },
  { period: '2025 YTD (Jan - Sep 2025)', revenue: 17.1, cogs: 11.2, grossProfit: 5.9, ebitda: 1.7, netIncome: 0.9 },
];

const CONTEXT = {
  dealName: 'Probe', companyName: 'ProbeCo', currency: 'USD', unitScale: 'MILLIONS' as const,
  sourceDocuments: [], generatedAt: '2026-10-02T00:00:00Z', notes: [],
};

let sheetXml: Map<string, string>; // sheet name -> raw worksheet XML
let workbookXml: string;

beforeAll(async () => {
  const buffer = await buildModelWorkbook({ assumptions: deriveDefaults(HISTORY), history: HISTORY, context: CONTEXT });
  const zip = await JSZip.loadAsync(buffer);
  workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  // Map sheet names (from workbook.xml) to their sheetN.xml (ExcelJS numbers
  // them in add order, which matches SHEETS order, but read the rels to be sure).
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const rIdToTarget = new Map(
    [...relsXml.matchAll(/<Relationship Id="(rId\d+)"[^>]*Target="(worksheets\/sheet\d+\.xml)"/g)].map((m) => [m[1], m[2]]),
  );
  sheetXml = new Map();
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1];
    const rId = m[0].match(/r:id="(rId\d+)"/)?.[1];
    const target = rId && rIdToTarget.get(rId);
    if (name && target) sheetXml.set(name, await zip.file(`xl/${target}`)!.async('string'));
  }
});

/** Every `<f>...</f>` formula cell in a sheet that has no `<v>` result next to it. */
function uncachedFormulaCells(xml: string): string[] {
  const missing: string[] = [];
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:(?!<\/c>).)*?<f[^>]*>.*?<\/f>((?:(?!<\/c>).)*)<\/c>/gs)) {
    if (!/<v>/.test(m[2])) missing.push(m[1]);
  }
  return missing;
}

/** The `<v>` text of one cell, or undefined if the cell has no result. */
function cellResult(xml: string, address: string): string | undefined {
  const re = new RegExp(`<c r="${address}"[^>]*>(?:(?!<\\/c>).)*?<v>([^<]*)<\\/v>(?:(?!<\\/c>).)*?<\\/c>`, 's');
  return xml.match(re)?.[1];
}

describe('cached formula results', () => {
  it('stores a value for every formula cell in every sheet', () => {
    const missing: string[] = [];
    for (const [name, xml] of sheetXml) missing.push(...uncachedFormulaCells(xml).map((a) => `${name}!${a}`));
    expect(missing).toEqual([]);
  });

  it('caches a real number or "n/a" for IRR, never the generic #ERROR! a parser bug produces', () => {
    const raw = cellResult(sheetXml.get(SHEETS.returns)!, `B${RETURNS_ROWS.irr}`);
    expect(raw).toBeDefined();
    expect(raw === 'n/a' || !Number.isNaN(Number(raw))).toBe(true);
  });

  it('a zero result (e.g. opening net debt with no balance sheet) is still cached, not dropped', () => {
    expect(cellResult(sheetXml.get(SHEETS.returns)!, `B${RETURNS_ROWS.netDebt}`)).toBe('0');
  });

  it('still asks Excel to recalculate on open', () => {
    expect(workbookXml).toContain('fullCalcOnLoad="1"');
  });
});

describe('irr', () => {
  it('matches Excel on a simple deal', () => {
    // Excel: =IRR({-100,0,0,0,0,200}) = 14.87%
    expect(irr([-100, 0, 0, 0, 0, 200])).toBeCloseTo(0.148698, 5);
  });

  it('is #NUM! when every flow has the same sign', () => {
    expect(() => irr([-100, -5, -5])).toThrow();
  });
});
