/**
 * Structured-output schema for Claude financial extraction (Phase 1).
 *
 * Design decisions (spec 2026-07-11):
 *  - lineItems is an ARRAY of {name, value, sourcePage, sourceQuote} — JSON
 *    schema with additionalProperties:false cannot express open records, and
 *    per-item provenance replaces the legacy verify/cross-verify passes.
 *  - Values are reported EXACTLY AS PRINTED; unitScale/currency per statement.
 *    Numeric normalization happens in TypeScript (normalize.ts), not prompts.
 */

import { z } from 'zod';
import { getTodayIso } from '../../utils/dates.js';

export const RAW_UNIT_SCALES = ['UNITS', 'THOUSANDS', 'MILLIONS', 'BILLIONS'] as const;

// ── Zod mirror (validates the parsed model output) ────────────────────
const rawLineItem = z.object({
  name: z.string(),
  value: z.number().nullable(),
  sourcePage: z.number().int().nullable(),
  sourceQuote: z.string().nullable(),
});

const rawPeriod = z.object({
  period: z.string(),
  periodType: z.enum(['HISTORICAL', 'PROJECTED', 'LTM']),
  confidence: z.number(),
  lineItems: z.array(rawLineItem),
});

const rawStatement = z.object({
  statementType: z.enum(['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW']),
  unitScale: z.enum(RAW_UNIT_SCALES),
  currency: z.string(),
  periods: z.array(rawPeriod),
});

export const extractionResponseZod = z.object({
  statements: z.array(rawStatement),
  overallConfidence: z.number(),
  warnings: z.array(z.string()),
});

export type ExtractionResponse = z.infer<typeof extractionResponseZod>;
export type RawStatement = z.infer<typeof rawStatement>;
export type RawLineItem = z.infer<typeof rawLineItem>;

// ── JSON schema sent to the API (output_config.format.schema) ─────────
// Hand-written: structured outputs require additionalProperties:false and
// do not support numeric min/max, so keep it constraint-light.
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statementType: { type: 'string', enum: ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW'] },
          unitScale: { type: 'string', enum: [...RAW_UNIT_SCALES] },
          currency: { type: 'string', description: 'ISO code as printed, e.g. USD, EUR' },
          periods: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                period: { type: 'string', description: 'e.g. "2022", "2025E", "LTM"' },
                periodType: { type: 'string', enum: ['HISTORICAL', 'PROJECTED', 'LTM'] },
                confidence: { type: 'integer', description: '0-100 confidence for this period' },
                lineItems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'snake_case canonical name from the vocabulary' },
                      // anyOf (not type arrays) — matches the SDK's own zodOutputFormat output;
                      // array-form `type` is undocumented for structured outputs (400 risk).
                      value: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Value EXACTLY as printed — do NOT convert units' },
                      sourcePage: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: '1-based page the value appears on' },
                      sourceQuote: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Short verbatim snippet containing the value' },
                    },
                    required: ['name', 'value', 'sourcePage', 'sourceQuote'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['period', 'periodType', 'confidence', 'lineItems'],
              additionalProperties: false,
            },
          },
        },
        required: ['statementType', 'unitScale', 'currency', 'periods'],
        additionalProperties: false,
      },
    },
    overallConfidence: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['statements', 'overallConfidence', 'warnings'],
  additionalProperties: false,
} as const;

// ── Prompts ───────────────────────────────────────────────────────────
// Canonical vocabulary mirrors financialSchema.ts keys so the existing
// validator/orchestrator/UI keep working unchanged.
/**
 * Build the extraction system prompt with today's date injected at call
 * time. CLAUDE.md: "AI classifier needs a current-date injection" — without
 * this, period inference (FY/LTM/"current quarter") drifts off the model's
 * training cutoff instead of the real wall-clock date. `todayIso` defaults
 * to a fresh getTodayIso() call — callers should NOT cache the return value
 * of this function across requests, or the date freezes at first call.
 */
export function buildExtractionSystemPrompt(todayIso: string = getTodayIso()): string {
  return `You are a private-equity financial analyst extracting 3-statement financial data from deal documents (CIMs, financial packages, filings).

DATE CONTEXT — TODAY IS ${todayIso}. Use THIS date as the boundary for HISTORICAL vs PROJECTED period classification, NOT your training cutoff. Any period whose end date is on or before ${todayIso} is HISTORICAL; any period whose end date is after ${todayIso} is PROJECTED. Do NOT label a recent-looking past period as PROJECTED just because it looks recent — check it against ${todayIso}.

Rules:
- Report every value EXACTLY as printed in the document. Do NOT convert units or currencies — instead set unitScale (UNITS/THOUSANDS/MILLIONS/BILLIONS) and currency per statement to describe how the document prints them.
- Use these canonical snake_case names when a line represents the same concept, even if the document's label differs (e.g. "Turnover"/"Net Sales" → revenue):
  income statement: revenue, cogs, gross_profit, gross_margin_pct, sga, rd, other_opex, total_opex, ebitda, ebitda_margin_pct, da, ebit, interest_expense, ebt, tax, net_income, sde
  balance sheet: cash, accounts_receivable, inventory, other_current_assets, total_current_assets, ppe_net, goodwill, intangibles, total_assets, accounts_payable, short_term_debt, other_current_liabilities, total_current_liabilities, long_term_debt, total_liabilities, total_equity
  cash flow: operating_cf, capex, fcf, acquisitions, debt_repayment, dividends, net_change_cash, investing_activities, financing_activities
  Anything material that doesn't match gets a descriptive snake_case name. Any invented name for a ratio, rate, or multiple (not a dollar amount) MUST end in _pct (percentages) or _ratio/_multiple (e.g. tax_rate_pct, debt_to_ebitda_ratio, current_ratio) — downstream code scales dollar amounts by unitScale but leaves these suffixed fields untouched, so an unsuffixed ratio would be silently corrupted.
- Percentages (names ending _pct) are reported as percent numbers (e.g. 42.5), never fractions — the one exception to "exactly as printed": convert a printed decimal fraction (0.425) to its percent equivalent (42.5).
- Every line item needs sourcePage (1-based) and a short verbatim sourceQuote when the value is visible in the document; use null only when genuinely unavailable.
- One period entry per fiscal period column. Projected periods keep their suffix (e.g. "2025E").
- If a statement type is absent, omit it and add a warning.`;
}

export const EXTRACTION_USER_INSTRUCTION = `Extract all income statement, balance sheet, and cash flow data from the attached document into the required JSON structure.`;

/**
 * Container-mode spreadsheet instruction (EXCEL_EXTRACTION_MODE=container,
 * the default). The workbook is attached as a container_upload, so the model
 * reads the ACTUAL cells via code execution instead of a flattened text
 * dump — the flattening step is what drove legacy spreadsheet extraction
 * accuracy to ~25% (merged cells, "$ in 000s" header rows, pivoted layouts,
 * multi-table sheets all lose structure in text form).
 *
 * Date is injected the same way as buildExtractionSystemPrompt — the model
 * infers period type (historical vs projected) from the workbook's own
 * columns, but a fiscal-year label like "FY26" is ambiguous without today's
 * date as an anchor.
 */
export function buildExcelContainerInstruction(todayIso: string = getTodayIso()): string {
  return `A spreadsheet file has been uploaded to your code execution environment.

DATE CONTEXT — TODAY IS ${todayIso}. Use this date, not your training cutoff, to classify periods as HISTORICAL (ends on or before ${todayIso}) vs PROJECTED (ends after ${todayIso}).

Read the ACTUAL cells with Python (pandas / openpyxl) — never work from a summary or from memory:
1. List every sheet in the workbook (for CSV, treat the file as one sheet).
2. For each sheet, print the used cell range INCLUDING header rows, unit/scale rows (e.g. "$ in thousands", "EUR m"), and label columns, exactly as stored. For very large sheets, print the header region plus every row that carries a financial line item.
3. Identify which sheets/ranges contain financial statements (income statement, balance sheet, cash flow) versus assumptions, schedules, or other content.
4. Determine unit scale and currency from cells you actually printed — never assume them.

Then extract all income statement, balance sheet, and cash flow data into the required JSON structure. Every value must come from a cell you printed. For sourceQuote use the sheet name + cell reference + printed value (e.g. "IS!B7: 36,286"); for sourcePage use the 1-based sheet index.`;
}

/**
 * Repair prompt: one pass, targeted at deterministic validator failures.
 *
 * IMPORTANT: `previousJson` is the NORMALIZED result (normalize.ts already
 * converted it to canonical MILLIONS scale) — not the raw as-printed values
 * the model originally returned. The repair response must stay in that same
 * normalized SCALE (unitScale: MILLIONS), or a document printed in
 * THOUSANDS produces a uniform 1000x scale error that the deterministic
 * validator cannot catch (every math check is scale-invariant) and the
 * merge acceptance gate would silently accept.
 *
 * Currency is NOT normalized anywhere in this pipeline (normalize.ts only
 * warns on non-USD, never converts) — the repair response must keep each
 * statement's currency exactly as it appears in the anchor. Telling the
 * model to force "USD" here would mislabel a EUR/GBP document without
 * converting any values.
 */
/**
 * @param failedTypes Statement types that failed validation. When given, the
 *   repair returns ONLY those — the caller's merge (mergeRepairedStatements)
 *   keeps every other statement from the first pass anyway, so regenerating
 *   them was pure wasted output on the most expensive model. The full
 *   previous extraction is still shown as context for cross-statement checks.
 */
export function buildRepairInstruction(failures: string[], previousJson: string, failedTypes?: string[]): string {
  const scope = failedTypes && failedTypes.length > 0
    ? `Return ONLY these statement types, corrected: ${failedTypes.join(', ')}. Omit every other statement — they passed validation and are kept as-is. Use the same JSON structure.`
    : 'Return the FULL corrected extraction in the same JSON structure.';
  return `A deterministic validator found these problems with your previous extraction:
${failures.map((f) => `- ${f}`).join('\n')}

Your previous extraction, already normalized to canonical MILLIONS scale (currency unchanged from the document):
${previousJson}

Re-examine the document. ${scope} Fix the flagged values by re-reading the source pages; keep values that were correct unchanged. The anchor above is already scale-normalized — report ALL values in each statement you return (corrected and unchanged) in MILLIONS to match it exactly, with unitScale set to "MILLIONS" on every statement you return. Keep each statement's currency exactly as shown in the anchor — do NOT change it to USD or any other currency. Do NOT re-derive as-printed units for this repair pass.`;
}
