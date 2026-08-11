/**
 * Inspect Excel — dumps the structured row/column text that the
 * financial extractor would ship to the LLM for any local XLSX file.
 *
 * Usage:
 *   npx tsx scripts/inspect-excel.ts /path/to/spreadsheet.xlsx
 *
 * Outputs the same string that classifyFinancials() receives, including:
 *   - Per-sheet metadata block ([Sheet: Name], [Grid: N rows × M cols])
 *   - Detected unit-scale hint (MILLIONS / THOUSANDS / BILLIONS / ACTUALS)
 *   - Tab-separated grid with merged cells expanded across their range
 *
 * Use this to debug "why did EBITDA come out as $21.5M when the source
 * said $21.5K?" — point it at the original XLSX and read the column-A
 * label / unit-hint / tab-aligned values directly.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { extractTextFromExcel } from '../src/services/excelFinancialExtractor.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npx tsx scripts/inspect-excel.ts <path-to-xlsx>');
  process.exit(1);
}

const filePath = resolve(arg);
if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const buffer = readFileSync(filePath);
const text = extractTextFromExcel(buffer);

if (text == null) {
  console.error('Extractor returned null — no meaningful content found.');
  process.exit(2);
}

console.log(text);
