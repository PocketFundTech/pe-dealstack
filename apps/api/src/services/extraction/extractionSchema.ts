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
export const EXTRACTION_SYSTEM_PROMPT = `You are a private-equity financial analyst extracting 3-statement financial data from deal documents (CIMs, financial packages, filings).

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

export const EXTRACTION_USER_INSTRUCTION = `Extract all income statement, balance sheet, and cash flow data from the attached document into the required JSON structure.`;

/** Repair prompt: one pass, targeted at deterministic validator failures. */
export function buildRepairInstruction(failures: string[], previousJson: string): string {
  return `A deterministic validator found these problems with your previous extraction:
${failures.map((f) => `- ${f}`).join('\n')}

Your previous extraction JSON:
${previousJson}

Re-examine the document and return the FULL corrected extraction in the same JSON structure. Fix the flagged values by re-reading the source pages; keep values that were correct unchanged. Remember: values exactly as printed, unitScale/currency describe the document.`;
}
