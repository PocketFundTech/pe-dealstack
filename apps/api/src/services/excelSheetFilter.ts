/**
 * excelSheetFilter.ts
 *
 * Content-based sheet triage for the Claude extraction engine (Fable 5).
 * Name scoring (excelFinancialExtractor.ts scoreSheet / SKIP_PATTERNS)
 * judges a tab by its title; this looks at what is actually IN it, so the
 * engine can leave out tabs that clearly carry nothing to extract — cover
 * pages, read-me / notes tabs, chart-only tabs, empty assumption shells —
 * without ever losing a statement tab because of an odd name ("Sheet1",
 * "Dashboard", "Output").
 *
 * Deliberately conservative. A sheet is "no financial content" only when
 * BOTH hold:
 *   - fewer than MIN_NUMERIC_CELLS numeric cells, and
 *   - no financial wording anywhere in its name or text cells — statement
 *     line items, unit-scale declarations ("$ in thousands", "INR crore"),
 *     currency codes, or fiscal-year wording. A cover page that says "All
 *     figures in $000s" or "Fiscal year ends 31 March" is kept: the model
 *     needs that to get scale and periods right.
 * Anything else is kept. If every sheet would be dropped, nothing is.
 *
 * Lives in its own module (not excelFinancialExtractor.ts) so claudeEngine
 * can use it on the container path without depending on the text
 * flattener — and so tests that mock the flattener still run this for real.
 */

import XLSX from 'xlsx';
import { log } from '../utils/logger.js';

/** At or above this many numeric cells a sheet is never "no financial content". */
export const MIN_NUMERIC_CELLS = 4;

/** Cells scanned per sheet before giving up — a sheet this big is never dropped anyway. */
const MAX_CELLS_SCANNED = 20_000;

/**
 * Financial wording. Broad on purpose: a false hit only means a junk tab is
 * kept (today's behavior); a miss could drop a tab the model needed.
 */
const FINANCIAL_TEXT = new RegExp(
  [
    // Statement names and line items
    String.raw`p\s*[&+]\s*l`, String.raw`profit`, String.raw`loss`, String.raw`income`, String.raw`revenue`,
    String.raw`sales`, String.raw`turnover`, String.raw`ebitda?`, String.raw`margin`, String.raw`cogs`,
    String.raw`cost\s+of`, String.raw`expenses?`, String.raw`opex`, String.raw`capex`, String.raw`assets?`,
    String.raw`liabilit`, String.raw`equity`, String.raw`cash`, String.raw`debt`, String.raw`borrowings?`,
    String.raw`depreciation`, String.raw`amorti[sz]ation`, String.raw`interest`, String.raw`tax`,
    String.raw`receivables?`, String.raw`payables?`, String.raw`inventor(y|ies)`, String.raw`balance\s*sheet`,
    String.raw`dividends?`, String.raw`earnings`, String.raw`payroll`, String.raw`salar(y|ies)`,
    // Unit / scale declarations
    String.raw`thousands?`, String.raw`millions?`, String.raw`billions?`, String.raw`crores?`, String.raw`lakhs?`,
    String.raw`lacs`, String.raw`\$\s*0{3}`, String.raw`'0{3}`, String.raw`0{3}s`, String.raw`\$\s*mm?\b`,
    String.raw`\$\s*k\b`, String.raw`\b(usd|eur|gbp|inr|cad|aud|chf|jpy|cny|sgd|aed)\b`, String.raw`[$€£₹¥]`,
    // Period / fiscal-year wording
    String.raw`fiscal\s*year`, String.raw`financial\s*year`, String.raw`year[\s-]*end`, String.raw`\bfye\b`,
  ].join('|'),
  'i',
);

/**
 * Statement line-item anchors — distinct hits are counted to recognise a
 * statement tab by its rows, whatever the tab is called.
 */
const STATEMENT_ANCHORS: RegExp[] = [
  /\b(revenue|net\s+sales|total\s+sales|turnover)\b/i,
  /\b(cogs|cost\s+of\s+(goods|sales|revenue))\b/i,
  /\bgross\s+(profit|margin)\b/i,
  /\bebitda\b/i,
  /\boperating\s+(income|profit)\b|\bebit\b/i,
  /\bnet\s+(income|profit|loss|earnings)\b|\bprofit\s+after\s+tax\b|\bpat\b/i,
  /\btotal\s+assets\b/i,
  /\btotal\s+liabilities\b/i,
  /\b(shareholders?'?|stockholders?'?|total)\s+equity\b/i,
  /\bcash\s+(flow\s+)?(from|used\s+in|generated)\b|\boperating\s+activities\b/i,
  /\b(capex|capital\s+expenditure)\b/i,
];

/** Distinct anchors + numbers needed for content to count as a statement tab. */
const STATEMENT_MIN_ANCHORS = 3;
const STATEMENT_MIN_NUMERIC_CELLS = 8;

/** A string cell that is really a number ("1,234", "$(56.7)", "12%"). */
const NUMERIC_TEXT = /^[\s$€£₹¥(+-]*\d[\d,]*(\.\d+)?\s*\)?\s*%?\s*$/;

export interface SheetContentProfile {
  numericCells: number;
  hasFinancialText: boolean;
  /** Distinct STATEMENT_ANCHORS seen in the sheet's text cells. */
  statementAnchors: number;
}

/** Count numeric cells and look for financial wording in one sheet. */
export function profileSheetContent(sheet: XLSX.WorkSheet | undefined, sheetName = ''): SheetContentProfile {
  let numericCells = 0;
  let hasFinancialText = FINANCIAL_TEXT.test(sheetName);
  const anchors = new Set<number>();
  const profile = (): SheetContentProfile => ({ numericCells, hasFinancialText, statementAnchors: anchors.size });
  if (!sheet) return profile();

  let scanned = 0;
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue;
    if (++scanned > MAX_CELLS_SCANNED) {
      // Huge sheet: treat as content-bearing rather than keep scanning.
      numericCells = Math.max(numericCells, MIN_NUMERIC_CELLS);
      return profile();
    }
    const cell = sheet[addr] as XLSX.CellObject | undefined;
    if (!cell) continue;
    if (cell.t === 'n') {
      numericCells++;
      continue;
    }
    // A formula with no cached number still says the sheet computes
    // something — count it rather than risk dropping a live model tab.
    if (cell.f) {
      numericCells++;
      continue;
    }
    if (cell.v == null) continue;
    if (cell.t === 's') {
      const text = String(cell.v);
      if (NUMERIC_TEXT.test(text)) {
        numericCells++;
        continue;
      }
      if (!hasFinancialText && FINANCIAL_TEXT.test(text)) hasFinancialText = true;
      if (anchors.size < STATEMENT_ANCHORS.length) {
        STATEMENT_ANCHORS.forEach((re, i) => { if (!anchors.has(i) && re.test(text)) anchors.add(i); });
      }
    }
  }
  return profile();
}

/** True only when a sheet clearly has nothing to extract (see module doc). */
export function isNoFinancialContent(profile: SheetContentProfile): boolean {
  return profile.numericCells < MIN_NUMERIC_CELLS && !profile.hasFinancialText;
}

/**
 * True when a sheet's rows read like a financial statement (several distinct
 * statement line items plus real numbers), whatever the tab is called. Used
 * to keep a P&L that lives in "Sheet1" (every CSV), "Dashboard" or "Output"
 * — names the extractor's SKIP_PATTERNS would otherwise throw away.
 */
export function looksLikeStatement(profile: SheetContentProfile): boolean {
  return profile.statementAnchors >= STATEMENT_MIN_ANCHORS && profile.numericCells >= STATEMENT_MIN_NUMERIC_CELLS;
}

/**
 * Names of the sheets in a workbook that clearly hold no financial content,
 * in workbook order. Returns [] when the workbook can't be parsed, has a
 * single sheet (CSV), or when every sheet would be dropped — the caller
 * then sends the workbook exactly as before.
 */
export function findNoFinancialContentSheets(buffer: Buffer): string[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false, cellText: false });
  } catch {
    return [];
  }
  return noFinancialContentSheetsOf(workbook);
}

/** Same as findNoFinancialContentSheets, for an already-parsed workbook. */
export function noFinancialContentSheetsOf(workbook: XLSX.WorkBook): string[] {
  const names = workbook.SheetNames ?? [];
  if (names.length < 2) return [];
  const dropped = names.filter((name) => isNoFinancialContent(profileSheetContent(workbook.Sheets[name], name)));
  if (dropped.length === names.length) {
    log.info('Excel sheet filter: every sheet looked empty of financials — keeping all', { sheets: names });
    return [];
  }
  return dropped;
}
