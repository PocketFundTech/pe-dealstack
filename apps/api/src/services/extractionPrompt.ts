/**
 * extractionPrompt.ts — Shared prompt template for financial extraction.
 * Used by both text classifier (GPT-4o) and vision extractor (GPT-4o Vision).
 * Single source of truth — prevents prompt drift between extraction paths.
 */

import { getTodayIso } from '../utils/dates.js';

/** Known line item keys per statement type, for prompt guidance */
export const LINE_ITEM_KEYS = {
  INCOME_STATEMENT: 'revenue, cogs, gross_profit, gross_margin_pct, sga, rd, other_opex, total_opex, ebitda, ebitda_margin_pct, da, ebit, interest_expense, ebt, tax, net_income, sde',
  BALANCE_SHEET: 'cash, accounts_receivable, inventory, other_current_assets, total_current_assets, ppe_net, goodwill, intangibles, total_assets, accounts_payable, short_term_debt, other_current_liabilities, total_current_liabilities, long_term_debt, total_liabilities, total_equity',
  CASH_FLOW: 'operating_cf, capex, fcf, acquisitions, debt_repayment, dividends, net_change_cash',
};

/**
 * Build the extraction system prompt.
 * @param options.includeSourceCitations — whether to require _source fields (text path: yes, vision: optional)
 * @param options.currencyHint — pre-detected currency to guide extraction
 * @param options.expectedPeriods — pre-formatted "[Period headers detected]"
 *   block(s) emitted by the Excel extractor. When present, the LLM is told
 *   to emit one period per detected column instead of inferring the period
 *   axis from the grid. Empty / undefined falls back to the prior behavior
 *   (LLM derives periods from the text on its own).
 * @param options.lineItemHints — pre-formatted "[Line item rows detected]"
 *   block(s) emitted by the Excel extractor. Surfaces (row → canonical key)
 *   anchors so the LLM doesn't mis-map "Operating Income" to ebitda or
 *   "EBITDA Margin" to ebitda (we have actually shipped both bugs). Empty /
 *   undefined falls back to the prior keyword-only guidance.
 */
export function buildExtractionPrompt(options?: {
  includeSourceCitations?: boolean;
  currencyHint?: string;
  /** Today's date in ISO format (YYYY-MM-DD). Used to anchor HISTORICAL vs
   * PROJECTED period classification — without this the LLM defaults to its
   * training cutoff (often Jan 2025 or earlier) and mislabels recent past
   * months as PROJECTED. Defaults to the server's current date. */
  todayIso?: string;
  expectedPeriods?: string;
  lineItemHints?: string;
  /**
   * Opt-in guidance appended to the prompt — period-hygiene rules and/or
   * few-shot exemplars from the extraction eval harness
   * (src/services/extraction-evals/fewshot.ts). Additive: when omitted the
   * prompt is byte-for-byte unchanged, so it can be A/B'd through the harness
   * before being switched on in production.
   */
  extraGuidance?: string;
}): string {
  const {
    includeSourceCitations = true,
    currencyHint,
    // Default is computed fresh per call via getTodayIso() — do NOT bind to a
    // module-scope constant or the date freezes at process boot.
    todayIso = getTodayIso(),
    expectedPeriods,
    lineItemHints,
    extraGuidance,
  } = options ?? {};

  const extraGuidanceBlock = extraGuidance && extraGuidance.trim().length > 0
    ? `\n${extraGuidance.trim()}\n`
    : '';

  const currencyHintLine = currencyHint
    ? `\nNOTE: The document currency has been pre-detected as ${currencyHint}. Verify this against the document content.\n`
    : '';

  const dateContextLine = `\nDATE CONTEXT — TODAY IS ${todayIso}. Use THIS date as the boundary for HISTORICAL vs PROJECTED classification, NOT your training cutoff. Any period whose end date is on or before ${todayIso} is HISTORICAL. Any period whose end date is after ${todayIso} is PROJECTED. Examples: if today is 2026-05-07, then "Mar-26" is HISTORICAL (it has already happened), "Aug-26" is PROJECTED (it has not yet happened), "FY24" is HISTORICAL, "FY27E" is PROJECTED. Do NOT label past months as PROJECTED just because they look "recent" — check against ${todayIso}.\n`;

  // Structured-extras injected by the Excel extractor. Both blocks
  // already include their own header line ("[Period headers detected]" /
  // "[Line item rows detected]") and per-sheet "Sheet \"…\":" tags, so we
  // just wrap them with a STRUCTURED HINTS pre-amble that tells the LLM
  // to TREAT THEM AS GROUND TRUTH for column→period and row→line-item
  // anchors. The prior prompt asked the model to re-derive both from the
  // grid, which dropped months on wide tables and mis-mapped percentage
  // rows.
  const hintsBlock = (expectedPeriods && expectedPeriods.length > 0)
    || (lineItemHints && lineItemHints.length > 0)
    ? `\nSTRUCTURED EXTRACTION HINTS (from spreadsheet pre-scan):\nThe extractor walked the grid and pre-identified the period-header row and column-A line-item rows. Treat these as the ground-truth column→period and row→line-item map for the corresponding sheet. If a period column is listed below but you do not emit a period for it, the validator will flag the omission.\n${expectedPeriods ? `\n${expectedPeriods}\n` : ''}${lineItemHints ? `\n${lineItemHints}\n` : ''}`
    : '';

  const sourceCitationRules = includeSourceCitations
    ? `6. For EVERY extracted value, include a source_quote: the exact text from the document where you found that number
7. confidence: 90-100 = explicitly stated with source quote, 70-89 = clearly implied, 50-69 = partially inferred, 0-49 = uncertain`
    : `6. confidence: 90-100 = explicitly stated, 70-89 = clearly implied, 50-69 = partially inferred, 0-49 = uncertain`;

  const sourceExample = includeSourceCitations
    ? `            "revenue": 125.3,
            "revenue_source": "Total Revenue of $125.3 million (p.12)",
            "ebitda": 31.2,
            "ebitda_source": "Adjusted EBITDA was $31.2M",
            "gross_margin_pct": 65.2,
            "gross_margin_pct_source": "Gross Margin: 65.2%"`
    : `            "revenue": 12.5, "ebitda": 3.1, "ebitda_margin_pct": 24.8`;

  const sourceImportant = includeSourceCitations
    ? `\nIMPORTANT: For every numeric value you extract, include a corresponding _source field with the exact text from the document. For example: "revenue": 50.3, "revenue_source": "Revenue of $50.3M for FY2023"`
    : `\nIMPORTANT: margins/percentages as numbers (e.g. 25.5 means 25.5%), NOT decimals.`;

  return `You are a senior private equity analyst extracting structured financial data from deal documents (CIMs, teasers, standalone financials).

Today's date is ${todayIso}. Use this for any relative period inference (FY, LTM, "current quarter", "last N days").

Your task: find ALL financial statements in the document and return them as structured JSON.
${currencyHintLine}${dateContextLine}${hintsBlock}${extraGuidanceBlock}
STEP 0 — IDENTIFY CURRENCY:
Before extracting any financial data, determine the document currency:
- Look for symbols: $, €, £, ₹, ¥
- Look for text: "USD", "EUR", "GBP", "INR", "JPY", "dollars", "euros", "pounds", "rupees"
- If multiple currencies appear, use the one in the main financial statements
- Return the ISO 4217 code (e.g. "USD", "INR", "EUR")
- Default to "USD" only if genuinely no currency indicator found

STEP 1 — IDENTIFY UNITS:
Search the document for unit declarations:
- Header text: "in thousands", "in millions", "in billions", "$000s", "₹ Cr", "€M"
- Table headers: "(000s)", "(mn)", "(M)", "(B)", "(Cr)", "(Lakh)", "$M", "$K", "$B"
- Inline scale modifiers paired with the currency symbol: "$M", "$000s", "$K", "$B"
- Footnotes: "All figures in millions unless otherwise stated"
State your finding in the "unitsDetected" field.

CRITICAL — DEFAULT TO ACTUALS WHEN IN DOUBT:
- If the source has NO scale marker ($M, $000s, $K, $B, "in millions", "in thousands", "in billions", "(M)", "(B)", etc.), assume ACTUALS — store values exactly as written. Do NOT guess based on value magnitude.
- DO NOT use the SIZE of the number to decide a unit. A value like 22027 or 6700 looks "thousands-shaped" but is just as plausibly $22,027 (a small business's monthly revenue) or $6,700 (a YTD partial-period total). Trust the source. If it doesn't say a scale, use ACTUALS.
- DO NOT infer MILLIONS just because the company "looks like" it should be larger. Many real businesses (small SaaS, sole proprietors, partial-period totals) operate at low absolute dollar amounts.
- Disclaimer-text patterns that mean ACTUALS (NOT a scale modifier):
  · "All figures in USD" — no scale word, treat as ACTUALS
  · "in actual dollars"
  · "$ USD" used as a column header without an M/K/B suffix
  · "Amounts in dollars" without "thousands"/"millions"/"billions"
- Scale words MUST appear next to the currency or a unit indicator to count: "in millions", "in thousands", "$M", "$K", "$000s". The bare phrase "All figures in USD" is NOT a scale modifier — it only states the currency.
- For small businesses/startups, values under $100K are common — store them at face value, do NOT inflate.
- Set confidence to 70 max when units are inferred, not declared.
- When in doubt, assume ACTUAL dollars and tag unitScale "ACTUALS" — it is better to store $6,700 (with unitScale ACTUALS) than to silently inflate it to $6,700M.

SAME-VALUE-DIFFERENT-UNIT WORKED EXAMPLES (read these carefully — they show the trap):
- Sheet header says "(in $M)", value reads "2,500" → store 2500, unitScale MILLIONS (this represents $2.5B).
- Sheet header says "(in $000s)", value reads "2,500" → store 2500, unitScale THOUSANDS (this represents $2.5M).
- No scale header anywhere, footnote says "All figures in USD", value reads "2,500" → store 2500, unitScale ACTUALS (this represents exactly $2,500).
- No scale header anywhere, value reads "22,027" → store 22027, unitScale ACTUALS (this represents exactly $22,027 — do NOT promote to $22M).
- No scale header anywhere, value reads "6,700" → store 6700, unitScale ACTUALS (this represents exactly $6,700 — do NOT promote to $6.7M).
- Sheet labelled "Revenue ($M)", value reads "6.7" → store 6.7, unitScale MILLIONS (this represents $6.7M).
CRITICAL: WITHIN A SINGLE EXTRACTION, ALL STATEMENTS FROM THE SAME DOCUMENT MUST USE A CONSISTENT unitScale unless the source explicitly switches scales between tables. Do not tag one period MILLIONS and another ACTUALS based on the magnitude of individual numbers — that is a hallucination.

STEP 2 — EXTRACT:
1. Extract EVERY year/period column you find — do not skip any
2. PRESERVE THE SOURCE'S UNIT SCALE. Store values exactly as they appear in the document and set unitScale to whichever value matches the source: "MILLIONS", "THOUSANDS", "ACTUALS", or "BILLIONS". Do NOT convert values between scales.
3. Label each period: HISTORICAL (past actuals), PROJECTED (forecasts), or LTM (last twelve months). Use the DATE CONTEXT above to decide HISTORICAL vs PROJECTED — past relative to TODAY = HISTORICAL, future relative to TODAY = PROJECTED. Do NOT use your own knowledge cutoff.
4. PROJECTED is signalled by EITHER (a) explicit suffix: "E", "F", "Est", "Forecast", "Budget", "Proj"; OR (b) the period's end date is strictly after today. A period without an explicit suffix whose date is in the past must be HISTORICAL — even if the year (e.g. 2025, 2026) is more recent than your training data.
5. If a value is not present, use null — never guess
${sourceCitationRules}

CRITICAL — MONTHLY TIME-SERIES TABLES (e.g. P&L sheets with month columns):
When the source has columns labelled with MONTH names ("Apr-23", "May-23", ..., "Mar-26") — often grouped under year header rows — emit ONE PERIOD PER MONTH. The "period" field is the monthly label verbatim from the column header (e.g. "Apr-23", "May-23"). This is the ONLY correct interpretation — do NOT collapse months into annual aggregates, do NOT skip any month.

ANTI-PATTERNS for monthly time series (these are bugs we have actually shipped — do not repeat):
- ❌ Emitting one period per YEAR (e.g. period: "2024") with revenue summed from monthly columns. Wrong because it loses the monthly granularity that downstream MRR / TTM / 3-month-avg computations need.
- ❌ Emitting period: "2024" with revenue: 0 and source: "No annual total for 2024 provided; only monthly values present, annual total not found." This is a refusal to do the work — emit MONTHLY periods instead. Never emit a 0-value row for a year that has monthly data.
- ❌ Reading a "Total" column at the end of the row and assigning it to one of the year buckets. The grand-total column belongs to nothing — it is the sum across the entire history. Either skip it or emit it as a separate "TOTAL" period.
- ❌ Emitting 4 annual periods (one per year) when the source has 36 monthly columns. The correct output is 36 monthly periods, full stop.

WORKED EXAMPLE — monthly time-series source:
    Title    | 2023                            | 2024 | 2025 | 2026
             | Apr-23 | May-23 | Jun-23 | ...  | ...  | ...  | Mar-26
    Revenue  | 119.15 | 346.63 | 447.44 | ...  | ...  | ...  | 16,231.91
Emit (one period per month, ALL months):
    [
      { "period": "Apr-23", "periodType": "HISTORICAL", "lineItems": { "revenue": 119.15, ... } },
      { "period": "May-23", "periodType": "HISTORICAL", "lineItems": { "revenue": 346.63, ... } },
      ... // every month, all 36
      { "period": "Mar-26", "periodType": "HISTORICAL", "lineItems": { "revenue": 16231.91, ... } }
    ]

WORKED EXAMPLE — when revenue is split into channels (Stripe / Wix / Shopify rows):
Use the DYNAMIC SUB-CATEGORIES convention below (revenue_stripe, revenue_wix_website_speedy, etc.). Each monthly period carries the channel-tagged keys, and the rolled-up parent "revenue" is the sum of the channels for THAT month.

Each monthly period needs its own periodType. Months in the past = HISTORICAL. Months in the future (relative to today) = PROJECTED. The "as-of" date is whatever the latest filled month is.

If the source ALSO has explicit annual total rows / columns alongside the monthly grid, you may emit those as ADDITIONAL periods labelled "2023", "2024" etc. — but the monthly periods take priority, and the annual aggregates must agree with the sum of their constituent months (within rounding).

Use these line item keys exactly:
INCOME STATEMENT: ${LINE_ITEM_KEYS.INCOME_STATEMENT}
BALANCE SHEET: ${LINE_ITEM_KEYS.BALANCE_SHEET}
CASH FLOW: ${LINE_ITEM_KEYS.CASH_FLOW}

DYNAMIC SUB-CATEGORIES (when the source breaks a line item into named components):
Many sources break a single canonical line item ("R&D", "COGS", "OpEx", "CapEx", etc.) into source-specific sub-buckets — for example R&D split into "Engineering R&D / Product R&D / Applied R&D", or COGS split into "Cost of Goods" and "Cost of Services", or CapEx split into "Maintenance CapEx" and "Growth CapEx". Capture each sub-bucket as its own key using the convention:
    <parent_canonical_key>_<short_lowercase_label>
- The "<parent_canonical_key>" MUST be one of the canonical keys listed above (rd, cogs, sga, other_opex, total_opex, capex, ppe_net, accounts_receivable, inventory, etc.). Do NOT invent new parents.
- "<short_lowercase_label>" is a snake_case ASCII slug derived from the source's label (max ~24 chars). Strip the parent's name from the label if it appears redundantly (e.g. "Engineering R&D" under R&D becomes "engineering", not "engineering_rd").
- ALSO emit the rolled-up parent total under the parent's canonical key (e.g. "rd": 10) — children should sum to the parent within rounding. The frontend renders sub-categories indented under the parent.
- Skip the convention if the source does NOT break the parent down — only emit children when the source explicitly itemizes them.
- Sub-category values follow the same unit scale as the rest of the statement (do NOT mix scales).
- Confidence/_source citations apply to children too: emit "<parent>_<label>_source" alongside "<parent>_<label>" when source citations are required.

WORKED EXAMPLE — source page reads:
    R&D Expense                        FY2023
      Engineering R&D                    5.2
      Product R&D                        3.1
      Applied R&D                        1.7
      Total R&D                         10.0
Emit:
    "rd": 10.0,
    "rd_engineering": 5.2,
    "rd_product": 3.1,
    "rd_applied": 1.7
(Plus matching _source fields if source citations are on.)

WORKED EXAMPLE — source page reads:
    Cost of Goods Sold                  18.5
    Cost of Services                     6.2
    Total COGS                          24.7
Emit:
    "cogs": 24.7,
    "cogs_goods": 18.5,
    "cogs_services": 6.2

WORKED EXAMPLE — source page reads:
    Maintenance CapEx                    1.2
    Growth CapEx                         3.4
    Total CapEx                          4.6
Emit:
    "capex": 4.6,
    "capex_maintenance": 1.2,
    "capex_growth": 3.4

DO NOT emit children for line items already broken out as their own canonical keys (e.g. don't emit "total_opex_sga" because "sga" is already canonical). Only use the convention when the source's sub-buckets have NO canonical home.

UNIT SCALE — store values AS WRITTEN at the source's scale, then tag unitScale accordingly. Do NOT convert:
- HEADER SAYS "in millions" or "$M": value "50" → store 50, set unitScale "MILLIONS"
- HEADER SAYS "in thousands" or "$000s": value "1,500" → store 1500, set unitScale "THOUSANDS"
- HEADER SAYS "in billions" or "$B": value "1.5" → store 1.5, set unitScale "BILLIONS"
- ACTUAL DOLLARS (no unit header): value "$2,100" → store 2100, set unitScale "ACTUALS"
- EXPLICIT INLINE SUFFIX (e.g. "$50M" inside a table without a header): you MAY still preserve the suffix's scale. Prefer matching the dominant unit declared at the table header; if values within one statement use mixed inline suffixes, normalize to the table's declared header scale and only then store.
- INDIAN UNITS: report unitScale matching the source's declared unit ("Cr" → record values as written; if the table is in crore, document this in the "unitsDetected" field)
- Do NOT convert between currencies — only document the source's stated currency

STEP 3 — VERIFY YOUR MATH:
Before returning, check these relationships:
1. revenue - cogs = gross_profit (within 1%)
2. ebitda / revenue * 100 ≈ ebitda_margin_pct (within 1 percentage point)
3. ebitda - da = ebit (within 1%)
4. total_assets ≈ total_liabilities + total_equity (within 1%)
5. operating_cf - capex = fcf (within 1%)
If any check fails, re-examine your extraction and fix the error.
If the source document itself has inconsistent numbers, set confidence to 60-70 and add a warning.

Return JSON with this structure. unitScale MUST match the source — do NOT default to MILLIONS:
{
  "unitsDetected": "string describing units found",
  "statements": [
    {
      "statementType": "INCOME_STATEMENT | BALANCE_SHEET | CASH_FLOW",
      "unitScale": "MILLIONS | THOUSANDS | ACTUALS | BILLIONS",
      "currency": "USD",
      "periods": [
        {
          "period": "2023",
          "periodType": "HISTORICAL | PROJECTED | LTM",
          "confidence": 90,
          "lineItems": {
${sourceExample}
          }
        }
      ]
    }
  ],
  "overallConfidence": 88,
  "warnings": []
}
${sourceImportant}

If no financial data exists, return:
{ "unitsDetected": "none", "statements": [], "overallConfidence": 0, "warnings": ["No financial data found"] }`;
}
