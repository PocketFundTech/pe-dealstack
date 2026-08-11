/**
 * excelToMarkdown.ts
 *
 * Converts an Excel workbook into LLM-optimized Markdown tables for the
 * chat-RAG path (Document.extractedText). Uses the SAME structured-grid
 * reader as `excelFinancialExtractor.ts`, so chat answers and extraction
 * answers can no longer diverge on what a workbook says.
 *
 * Background: pre-Phase-3-P5 this module re-implemented its own grid
 * walk that did NOT call `expandMerges`. Result: extraction saw "FY 2024"
 * filling every month column under it, while chat saw "FY 2024" only in
 * the top-left and blanks under each month. A user could ask "what was
 * Q3 FY 2024 revenue?" and get a stale chat answer that disagreed with
 * the extraction value sitting in FinancialStatement rows. Both paths
 * now consume `readStructuredGrid`, so they agree on shape and content.
 */

import XLSX from 'xlsx';
import { log } from '../utils/logger.js';
import { scoreSheet, detectUnitScale, SKIP_PATTERNS } from './excelFinancialExtractor.js';
import { readStructuredGrid } from './excelGridReader.js';

/**
 * Convert an Excel buffer to Markdown tables.
 * Each relevant sheet becomes a ## heading with a Markdown table.
 * Returns null if no meaningful content found.
 */
export function excelToMarkdown(buffer: Buffer): string | null {
  try {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true,
      cellNF: false,
      cellText: true,
    });

    if (!workbook.SheetNames.length) {
      log.warn('excelToMarkdown: workbook has no sheets');
      return null;
    }

    // Score and sort sheets by financial relevance
    const scoredSheets = workbook.SheetNames
      .map(name => ({ name, score: scoreSheet(name) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Fallback: if no sheets scored, use all non-junk sheets
    const sheetsToProcess = scoredSheets.length > 0
      ? scoredSheets
      : workbook.SheetNames
          .filter(name => !SKIP_PATTERNS.some(re => re.test(name.trim())))
          .map(name => ({ name, score: 10 }));

    const sections: string[] = [];

    for (const { name } of sheetsToProcess) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;

      const md = sheetToMarkdownTable(sheet, name);
      if (md) sections.push(md);
    }

    if (sections.length === 0) {
      log.warn('excelToMarkdown: no meaningful content found');
      return null;
    }

    const combined = sections.join('\n\n');
    log.info('excelToMarkdown: converted', {
      sheets: sections.length,
      chars: combined.length,
    });

    return combined;
  } catch (err) {
    log.error('excelToMarkdown: failed to parse workbook', err);
    return null;
  }
}

/**
 * Pick the header row from a rectangular grid.
 *
 * Heuristic: walk the first few rows, score each by the fraction of cells
 * that look like header text (non-empty AND not purely numeric). Return
 * the index of the highest-scoring row, with a tiebreaker preferring the
 * EARLIER row (Excel users put banners above headers, not below).
 *
 * Why a heuristic instead of "row 0 is the header": real exports often
 * lead with a title row ("Q3 2024 Earnings Pack") or a unit declaration
 * ("$ in thousands"), and the actual column labels (Jan-24, Feb-24, …)
 * sit two or three rows down. The previous implementation blindly took
 * `cleanRows[0]`, which produced Markdown tables with one-column headers
 * spanning the title cell — useless for embeddings.
 *
 * Mirrors what the financial extractor's structured walk produces: it
 * doesn't pick a header but emits all rows in order, leaving header
 * detection to the LLM. We do that detection here because Markdown
 * tables NEED a header row syntactically.
 *
 * Search window: only the first 8 non-empty rows. Beyond that we'd
 * almost certainly be picking a data row by accident.
 */
function pickHeaderRowIndex(rows: string[][]): number {
  if (rows.length === 0) return 0;

  const SEARCH_LIMIT = Math.min(rows.length, 8);
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const row = rows[i];
    let nonEmpty = 0;
    let textLike = 0;
    for (const cell of row) {
      if (cell === '') continue;
      nonEmpty++;
      // "Text-like" = the cell is not purely a number. Period labels
      // ("Jan-24", "Q3 FY24"), section names, unit hints all qualify.
      // Pure numbers don't (those belong in data rows).
      if (!/^-?[\d,]+(\.\d+)?$/.test(cell)) textLike++;
    }
    // Header-quality score: prefer rows that are mostly non-empty AND
    // mostly text. Tiebreaker on earlier index handled by strict >.
    const fillRate = nonEmpty / row.length;
    const textRate = nonEmpty > 0 ? textLike / nonEmpty : 0;
    const score = fillRate * 0.4 + textRate * 0.6;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Convert a single sheet to a Markdown table with a heading.
 * Returns null if the sheet has no meaningful data.
 */
function sheetToMarkdownTable(sheet: XLSX.WorkSheet, sheetName: string): string | null {
  // Same merge-aware, padded, filtered grid that the financial
  // extractor consumes. This is the contract that keeps chat and
  // extraction agreeing on what the workbook says.
  const cleanRows = readStructuredGrid(sheet);
  if (cleanRows.length < 2) return null; // need header + at least 1 data row

  // Detect unit scale (sheet was already merge-expanded by
  // readStructuredGrid; detectUnitScale walks the original sheet
  // object so it sees the broadcast year/unit banners too).
  const unitHint = detectUnitScale(sheet, sheetName);

  // Grid is rectangular post-readStructuredGrid, so every row has the
  // same length — no need to recompute maxCols defensively.
  const maxCols = cleanRows[0].length;

  const headerIdx = pickHeaderRowIndex(cleanRows);
  const headerRow = cleanRows[headerIdx];
  // Anything BEFORE the header (title rows, unit-declaration rows) is
  // dropped — it's not part of the tabular data the LLM needs to embed.
  const dataRows = cleanRows.slice(headerIdx + 1);

  if (dataRows.length === 0) return null;

  // Markdown body cell renderer: empty -> em-dash so the embedding
  // chunker doesn't see consecutive empty pipes that compress to a
  // single token. Pipe inside the cell value gets escaped so it
  // doesn't break the table structure.
  const escapeBodyCell = (val: string): string => {
    if (val === '') return '—';
    return val.replace(/\|/g, '\\|').trim();
  };

  // Header cells render empty as a literal blank, NOT em-dash. Empty
  // header cells happen when row 0 has a title in column A and the
  // remaining columns are blank — we still want those columns to
  // appear in the table so column alignment survives. The emitter
  // produces "|  |" for an empty header cell.
  const escapeHeaderCell = (val: string): string => {
    if (val === '') return '';
    return val.replace(/\|/g, '\\|').trim();
  };

  const padHeader = (row: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      out.push(escapeHeaderCell(row[i] ?? ''));
    }
    return out;
  };

  const padBody = (row: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      out.push(escapeBodyCell(row[i] ?? ''));
    }
    return out;
  };

  const header = `| ${padHeader(headerRow).join(' | ')} |`;
  const divider = `|${Array(maxCols).fill('---').join('|')}|`;
  const body = dataRows
    .map(row => `| ${padBody(row).join(' | ')} |`)
    .join('\n');

  let section = `## Sheet: ${sheetName}`;
  if (unitHint) section += `\n${unitHint}`;
  section += `\n\n${header}\n${divider}\n${body}`;

  return section;
}
