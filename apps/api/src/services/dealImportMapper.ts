import { createRequire } from 'module';
import type * as XLSX from 'xlsx';
import type { parse as csvParse } from 'csv-parse/sync';
import { log } from '../utils/logger.js';

// `xlsx` (~5MB) and `csv-parse` are only needed when a user actually imports a
// spreadsheet/CSV. Load them lazily via require() so they don't load at module
// init on every lite serverless cold start. Type-only imports keep type info.
const require = createRequire(import.meta.url);
let _xlsx: typeof XLSX | null = null;
function getXLSX(): typeof XLSX {
  return (_xlsx ??= require('xlsx'));
}
let _csvParse: typeof csvParse | null = null;
function getCsvParse(): typeof csvParse {
  return (_csvParse ??= require('csv-parse/sync').parse);
}

// ============================================
// Types
// ============================================

export interface ColumnMapping {
  field: string;          // e.g., "companyName" or "customFields.boardSeats"
  confidence: number;     // 0-1
  transform?: string;     // e.g., "multiply_1000000", "percentage_to_decimal"
}

export interface MappingResult {
  mapping: Record<string, ColumnMapping>;
  preview: Array<{ original: Record<string, string>; mapped: Record<string, any> }>;
  totalRows: number;
  validRows: number;
  warnings: string[];
  unmappedColumns: string[];
}

export interface ValidatedDeal {
  name: string;
  companyName: string;
  stage?: string;
  status?: string;
  dealSize?: number | null;
  ebitda?: number | null;
  revenue?: number | null;
  irrProjected?: number | null;
  mom?: number | null;
  industry?: string | null;
  description?: string | null;
  priority?: string;
  tags?: string[];
  targetCloseDate?: string | null;
  source?: string | null;
  customFields?: Record<string, any>;
}

// ============================================
// Parsers
// ============================================

export function parseCSV(text: string): Record<string, string>[] {
  try {
    const records = getCsvParse()(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    }) as Record<string, string>[];
    return records;
  } catch (err) {
    log.error('CSV parse error', err);
    throw new Error('Failed to parse CSV. Please check the file format.');
  }
}

export function parseExcel(buffer: Buffer): { rows: Record<string, string>[]; warnings: string[] } {
  try {
    const XLSX = getXLSX();
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('Excel file has no sheets');

    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[sheetName], {
      defval: '',
      raw: false,
    });

    const warnings: string[] = [];
    if (workbook.SheetNames.length > 1) {
      warnings.push(`Excel file has ${workbook.SheetNames.length} sheets — using first sheet "${sheetName}"`);
      log.info(`Excel file has ${workbook.SheetNames.length} sheets, using first: "${sheetName}"`);
    }

    return { rows, warnings };
  } catch (err) {
    log.error('Excel parse error', err);
    throw new Error('Failed to parse Excel file. Please check the file format.');
  }
}

export function parsePastedText(text: string): Record<string, string>[] {
  // Detect delimiter: tab-separated (Notion/Excel paste) vs comma-separated
  const firstLine = text.split(/\r?\n/)[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;

  if (tabCount > 0 && tabCount >= commaCount) {
    // Tab-separated — convert tabs to commas for csv-parse
    const csvText = text.split(/\r?\n/).map(line =>
      line.split('\t').map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    return parseCSV(csvText);
  }

  // Default: treat as CSV
  return parseCSV(text);
}

// ============================================
// AI Mapping
// ============================================

const DEAL_SCHEMA_PROMPT = `You are a data mapping assistant for a Private Equity deal management system.

Given CSV/spreadsheet column headers and sample data rows, map each column to the closest Deal field in our schema, or classify it as a custom field.

## Our Deal Schema Fields:
- name: Deal or project name (e.g., "Acme Acquisition", "Project Alpha")
- companyName: Target company name
- stage: Pipeline stage. Must be one of: INITIAL_REVIEW, DUE_DILIGENCE, IOI_SUBMITTED, LOI_SUBMITTED, NEGOTIATION, CLOSING, PASSED, CLOSED_WON, CLOSED_LOST
- status: ACTIVE, PROCESSING, PASSED, ARCHIVED
- dealSize: Total deal/enterprise value in USD (store as raw number — NOT in millions)
- ebitda: EBITDA in USD (raw number). Only map columns explicitly labeled "EBITDA". Do NOT map ARR, MRR, Revenue, or Sales to ebitda.
- revenue: Revenue in USD (raw number). Map ARR (Annual Recurring Revenue), MRR (Monthly Recurring Revenue), Sales, Turnover, and similar top-line metrics here — NOT to ebitda.
- irrProjected: Projected IRR as decimal (e.g., 0.25 for 25%)
- mom: Multiple on Money as decimal (e.g., 2.5)
- industry: Industry sector (free text)
- description: Deal description or thesis
- priority: LOW, MEDIUM, HIGH, URGENT
- tags: Array of string tags (comma-separated in source)
- targetCloseDate: Target close date (ISO 8601 format YYYY-MM-DD)
- source: Deal source (e.g., "banker", "proprietary", "auction")

## Rules:
1. Map each source column to the closest schema field based on header name AND sample values
2. For financial values, detect the unit scale from headers or values:
   - "$50M" or "50" with header containing "(M)" or "(millions)" → multiply by 1,000,000 → transform: "multiply_1000000"
   - "$50B" → multiply by 1,000,000,000 → transform: "multiply_1000000000"
   - Plain numbers with no unit indicator → no transform needed
3. For percentages: "25%" → 0.25, transform: "percentage_to_decimal"
4. For multiples: "2.5x" → 2.5, transform: "strip_x_suffix"
5. Normalize stages: "DD" → "DUE_DILIGENCE", "Passed" → "PASSED", "IOI" → "IOI_SUBMITTED", "LOI" → "LOI_SUBMITTED", "Initial Review" → "INITIAL_REVIEW", etc.
6. Columns that don't match any schema field → mark as customFields with a camelCase key derived from the column name
7. Return confidence score 0-1 for each mapping
8. If a column clearly contains deal names AND company names in the same column, map to "name" and note in warnings

Return valid JSON only. No markdown, no explanation.

## Response Schema:
{
  "mapping": {
    "<source column name>": {
      "field": "<our field name or customFields.camelCaseKey>",
      "confidence": <0-1>,
      "transform": "<optional: multiply_1000000 | multiply_1000000000 | percentage_to_decimal | strip_x_suffix>"
    }
  },
  "warnings": ["<any issues detected>"]
}`;

export async function analyzeImportData(
  rows: Record<string, string>[],
  source: 'csv' | 'excel' | 'paste'
): Promise<MappingResult> {
  if (rows.length === 0) {
    throw new Error('No data rows found. Please check your file.');
  }

  const headers = Object.keys(rows[0]);
  const sampleRows = rows.slice(0, 3);

  // Call GPT-4o for mapping (dynamic import to avoid pulling LangChain into lite bundle)
  const { getChatModel } = await import('./llm.js');
  const { HumanMessage, SystemMessage } = await import('@langchain/core/messages');
  const model = getChatModel(0.1, 2000, 'deal_import_mapping');
  const userPrompt = `Column headers: ${JSON.stringify(headers)}

Sample data (first ${sampleRows.length} rows):
${JSON.stringify(sampleRows, null, 2)}

Map each column to our Deal schema. Return JSON only.`;

  const response = await model.invoke([
    new SystemMessage(DEAL_SCHEMA_PROMPT),
    new HumanMessage(userPrompt),
  ]);

  let aiResult: { mapping: Record<string, ColumnMapping>; warnings: string[] };
  try {
    const content = typeof response.content === 'string' ? response.content : '';
    // Strip markdown code fences if present
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
    aiResult = JSON.parse(cleaned);
  } catch (err) {
    log.error('Failed to parse AI mapping response', err);
    throw new Error('AI mapping failed. Please try again.');
  }

  // Deterministic overrides — force-correct known column names the AI might mismap
  for (const header of headers) {
    const h = header.toLowerCase().trim();
    const mapping = aiResult.mapping[header];
    if (!mapping) continue;

    // ARR / MRR / Sales / Turnover → always revenue, never ebitda
    if (/\b(arr|annual recurring revenue|mrr|monthly recurring revenue|sales|turnover)\b/i.test(h)) {
      if (mapping.field === 'ebitda' || mapping.field === 'dealSize') {
        mapping.field = 'revenue';
        mapping.confidence = 0.95;
        aiResult.warnings = aiResult.warnings || [];
        aiResult.warnings.push(`"${header}" mapped to Revenue (detected as recurring/sales metric)`);
      }
    }

    // EV / Enterprise Value → always dealSize, never ebitda/revenue
    if (/\b(enterprise value|ev)\b/i.test(h) && mapping.field !== 'dealSize') {
      mapping.field = 'dealSize';
      mapping.confidence = 0.95;
    }

    // MOIC → always mom
    if (/\b(moic|multiple on invested capital)\b/i.test(h) && mapping.field !== 'mom') {
      mapping.field = 'mom';
      mapping.confidence = 0.95;
    }
  }

  // Apply mapping to generate preview (first 10 rows)
  const previewRows = rows.slice(0, 10);
  const preview = previewRows.map(row => ({
    original: row,
    mapped: applyMappingToRow(row, aiResult.mapping),
  }));

  // Validate all rows
  let validRows = 0;
  const warnings = [...(aiResult.warnings || [])];

  for (const row of rows) {
    const mapped = applyMappingToRow(row, aiResult.mapping);
    if (mapped.companyName || mapped.name) {
      validRows++;
    }
  }

  const missingCompany = rows.length - validRows;
  if (missingCompany > 0) {
    warnings.push(`${missingCompany} rows missing company name or deal name`);
  }

  // Identify unmapped columns
  const unmappedColumns = headers.filter(h => {
    const m = aiResult.mapping[h];
    return !m || m.field.startsWith('customFields.');
  });

  return {
    mapping: aiResult.mapping,
    preview,
    totalRows: rows.length,
    validRows,
    warnings,
    unmappedColumns,
  };
}

// ============================================
// Row Transformation
// ============================================

const VALID_STAGES = [
  'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED', 'LOI_SUBMITTED',
  'NEGOTIATION', 'CLOSING', 'PASSED', 'CLOSED_WON', 'CLOSED_LOST',
];
const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const VALID_STATUSES = ['ACTIVE', 'PROCESSING', 'PASSED', 'ARCHIVED'];

function applyTransform(value: string, transform?: string): any {
  if (!value || value.trim() === '') return null;

  // Strip currency symbols and commas
  let cleaned = value.replace(/[$€£,]/g, '').trim();

  switch (transform) {
    case 'multiply_1000000': {
      const num = parseFloat(cleaned) * 1_000_000;
      return isNaN(num) ? null : num;
    }
    case 'multiply_1000000000': {
      const num = parseFloat(cleaned) * 1_000_000_000;
      return isNaN(num) ? null : num;
    }
    case 'percentage_to_decimal': {
      cleaned = cleaned.replace(/%/g, '');
      const num = parseFloat(cleaned) / 100;
      return isNaN(num) ? null : num;
    }
    case 'strip_x_suffix': {
      cleaned = cleaned.replace(/x$/i, '');
      const num = parseFloat(cleaned);
      return isNaN(num) ? null : num;
    }
    default:
      return value.trim();
  }
}

export function applyMappingToRow(
  row: Record<string, string>,
  mapping: Record<string, ColumnMapping>
): Record<string, any> {
  const result: Record<string, any> = { customFields: {} };

  for (const [sourceCol, value] of Object.entries(row)) {
    const colMapping = mapping[sourceCol];
    if (!colMapping) continue;

    const transformedValue = applyTransform(value, colMapping.transform);
    if (transformedValue === null || transformedValue === '') continue;

    if (colMapping.field.startsWith('customFields.')) {
      const key = colMapping.field.replace('customFields.', '');
      result.customFields[key] = transformedValue;
    } else {
      result[colMapping.field] = transformedValue;
    }
  }

  // Normalize enums
  if (result.stage) {
    const upper = String(result.stage).toUpperCase().replace(/[\s-]/g, '_');
    result.stage = VALID_STAGES.includes(upper) ? upper : 'INITIAL_REVIEW';
  }
  if (result.priority) {
    const upper = String(result.priority).toUpperCase();
    result.priority = VALID_PRIORITIES.includes(upper) ? upper : 'MEDIUM';
  }
  if (result.status) {
    const upper = String(result.status).toUpperCase();
    result.status = VALID_STATUSES.includes(upper) ? upper : 'ACTIVE';
  }
  if (result.tags && typeof result.tags === 'string') {
    result.tags = result.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
  }

  // Numeric fields — ensure they're numbers
  for (const numField of ['dealSize', 'ebitda', 'revenue', 'irrProjected', 'mom']) {
    if (result[numField] !== undefined && result[numField] !== null) {
      const num = parseFloat(String(result[numField]).replace(/[$€£,%x,]/g, ''));
      result[numField] = isNaN(num) ? null : num;
    }
  }

  return result;
}

// ============================================
// Validation
// ============================================

export interface RowValidation {
  valid: boolean;
  errors: string[];
}

export function validateDealRow(row: Record<string, any>, index: number): RowValidation {
  const errors: string[] = [];

  // Must have either companyName or name
  if (!row.companyName && !row.name) {
    errors.push(`Row ${index + 1}: Missing company name and deal name`);
  }

  // Auto-generate deal name from company if missing
  if (!row.name && row.companyName) {
    row.name = row.companyName;
  }

  return { valid: errors.length === 0, errors };
}
