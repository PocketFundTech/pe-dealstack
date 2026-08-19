# Avise — Technical Assignment

## Financial Extraction Pipeline

> **Company:** Avise — AI-Powered CRM for Private Equity
> **Format:** Fork the repo, complete all 5 tasks, submit a single PR
> **Time:** 5-7 days (part-time, use any AI tools you want)
> **Stack:** Node.js / Express / TypeScript / Supabase (PostgreSQL) / GPT-4o

---

## About Avise

Avise is an AI-powered CRM for private equity firms. Deal teams upload financial documents (CIMs, Excel models, PDFs) and our platform extracts structured financial data, runs analysis, and powers an AI chat assistant.

Your assignment: **build the core financial extraction pipeline** that takes raw documents and turns them into clean, structured financial data.

---

## Before You Start

1. Run the project locally (`apps/api` on port 3001, `apps/web` on port 3000)
2. Read the existing extraction code to understand current patterns:
   - `apps/api/src/services/agents/financialAgent/` — our LangGraph agent architecture
   - `apps/api/src/services/financialClassifier.ts` — GPT-4o classification logic
   - `apps/api/src/services/excelFinancialExtractor.ts` — current Excel extraction
3. Understand the database schema: `FinancialStatement` table with `statementType`, `period`, `lineItems`, `extractionSource`

---

## Task 1: Multi-Format Text Extraction

**Problem:** Financial data comes in PDFs, Excel files, and sometimes images. We need a single entry point that handles all formats and outputs clean text for the AI to classify.

**Build a service at `apps/api/src/services/extraction/textExtractor.ts`:**

- Accept a file path + MIME type
- Route to the correct parser:
  - **PDF:** Use `pdf-parse` (already in dependencies) — extract all text, preserve table structure as much as possible
  - **Excel:** Use `xlsx` (already in dependencies) — iterate ALL sheets, convert each to CSV-like text with headers preserved
  - **Images (PNG/JPG):** Send to GPT-4o Vision with a prompt to extract all visible text and tables
- Return a unified result:

```typescript
interface TextExtractionResult {
  text: string;                    // full extracted text
  sections: {                      // per-page (PDF) or per-sheet (Excel)
    name: string;                  // "Page 1", "Sheet: Income Statement"
    text: string;
    hasTabularData: boolean;       // detected table-like content
  }[];
  metadata: {
    format: 'pdf' | 'excel' | 'image';
    pageCount: number;
    fileSize: number;
    extractionMethod: string;
  };
}
```

**Edge cases to handle:**
- Password-protected PDFs (return error, don't crash)
- Excel files with 20+ sheets (extract all, let later steps filter)
- Empty pages/sheets (skip, don't include)
- Scanned PDFs with no selectable text (detect this → fall back to Vision)

**Test:** Create 3 sample files (a simple PDF with a table, an Excel with 3 sheets, an image of a financial table) and write tests.

---

## Task 2: Financial Statement Classification & Extraction

**Problem:** Once we have raw text, we need GPT-4o to identify what financial statements are present and extract every line item with its value and period.

**Build a service at `apps/api/src/services/extraction/financialClassifier.ts`:**

1. **Statement detection** — Given extracted text, identify which statement types are present:
   - `INCOME_STATEMENT` (also called P&L, Profit & Loss)
   - `BALANCE_SHEET` (also called Statement of Financial Position)
   - `CASH_FLOW` (also called Cash Flow Statement)

2. **Period detection** — Find all time periods: FY2023, Q3 2024, YTD Jun 2024, LTM, etc. Normalize them to a consistent format.

3. **Line item extraction** — For each statement + period, extract every line item:

```typescript
interface ExtractedStatement {
  statementType: 'INCOME_STATEMENT' | 'BALANCE_SHEET' | 'CASH_FLOW';
  period: string;
  periodType: 'annual' | 'quarterly' | 'ltm' | 'ytd';
  lineItems: {
    name: string;           // "Revenue", "Cost of Goods Sold", "Total Assets"
    value: number | null;   // null if not available
    category: string;       // "revenue", "operating_expenses", "current_assets", etc.
    isSubtotal: boolean;    // true for "Total Revenue", "Gross Profit", etc.
  }[];
  currency: string;         // "USD", "EUR", etc.
  units: 'raw' | 'thousands' | 'millions' | 'billions';
  confidence: number;       // 0-1 overall confidence for this statement
}
```

4. **Prompt design matters.** Structure your GPT-4o prompt to:
   - Use structured output (JSON mode or function calling)
   - Handle messy real-world formatting (merged cells, footnotes, parentheses for negatives)
   - Detect units from headers like "$ in millions" or "(000s)"
   - Normalize negative values (parentheses → negative numbers)

**Test with:** A multi-period income statement, a balance sheet with sub-categories, a cash flow statement with operating/investing/financing sections.

---

## Task 3: Cross-Statement Validation

**Problem:** Extracted numbers often have errors — wrong unit scale, transposed digits, values pulled from the wrong row. We need automated validation to catch these before storing.

**Build a service at `apps/api/src/services/extraction/validator.ts`:**

**Validation rules to implement:**

| Rule | Logic | Severity |
|------|-------|----------|
| Balance sheet balances | Total Assets = Total Liabilities + Total Equity (within 1% tolerance) | `error` |
| Net income consistency | Net Income on Income Statement = Net Income on Cash Flow | `error` |
| Revenue is positive | Revenue > 0 (unless explicitly pre-revenue) | `warning` |
| EBITDA margin sanity | EBITDA / Revenue between -100% and +80% | `warning` |
| YoY growth sanity | Any line item growing > 500% YoY is suspicious | `warning` |
| Cash flow reconciliation | Beginning Cash + Net Change = Ending Cash | `error` |
| Subtotal consistency | Subtotals should equal sum of their line items (within 1%) | `warning` |

**Return:**
```typescript
interface ValidationResult {
  isValid: boolean;              // true if zero errors (warnings are OK)
  overallConfidence: number;     // 0-1 weighted average
  checks: {
    rule: string;
    passed: boolean;
    severity: 'error' | 'warning' | 'info';
    expected?: number;
    actual?: number;
    details: string;
  }[];
  flaggedItems: {               // line items that look wrong
    lineItem: string;
    period: string;
    value: number;
    reason: string;             // "Value 10x larger than industry norm"
    suggestedAction: 'review' | 'likely_correct' | 'likely_wrong';
  }[];
}
```

**Edge cases:**
- Only one statement type available (can't cross-validate — skip those rules, don't fail)
- Quarterly vs annual data mixed (don't compare Q3 revenue to FY revenue)
- Missing subtotals (some statements don't include them)

---

## Task 4: Self-Correction Pipeline

**Problem:** When validation finds errors, we need to re-extract only the problematic items — not the whole document. This saves tokens and is faster.

**Build a service at `apps/api/src/services/extraction/selfCorrector.ts`:**

1. **Input:** Original extracted text + validation result with flagged items
2. **Build a targeted correction prompt:**
   - Include the original source text (or relevant section)
   - List specifically which values seem wrong and why
   - Ask GPT-4o to re-examine ONLY those items
   - Example: "Revenue FY2023 was extracted as $120M but Balance Sheet suggests a much smaller company. Please re-read the source and verify Revenue for FY2023."

3. **Merge corrections** back into the original extraction:
   - Replace corrected values
   - Update confidence scores (corrected items get re-scored)
   - Re-run validation on the corrected data

4. **Retry logic:**
   - Max 2 correction attempts
   - If still failing after 2 attempts, return best result with `needsManualReview: true`
   - Track each attempt in a `corrections[]` log for transparency

```typescript
interface CorrectionResult {
  correctedStatements: ExtractedStatement[];
  corrections: {
    attempt: number;
    itemsCorrected: { lineItem: string; period: string; oldValue: number; newValue: number }[];
    validationAfter: ValidationResult;
  }[];
  finalValidation: ValidationResult;
  needsManualReview: boolean;
}
```

**Important:** The correction prompt should be MUCH smaller than the original extraction prompt — only include the source section relevant to the flagged items, not the entire document.

---

## Task 5: End-to-End Pipeline & API Route

**Problem:** Wire everything together into a single pipeline that takes a file upload and returns validated, structured financial data.

**Build:**

1. **Pipeline orchestrator at `apps/api/src/services/extraction/pipeline.ts`:**

```
Upload → Text Extract → Classify & Extract → Validate → Self-Correct (if needed) → Return
```

- Each step should be independently callable (for testing and future reuse)
- Track timing per step (how long each took)
- Handle failures gracefully — if extraction succeeds but validation fails, return partial result with status

2. **API route at `apps/api/src/routes/financial-extraction.ts`:**

```
POST /api/financial-extraction/extract
```

- Accept multipart file upload (PDF, Excel, PNG/JPG)
- Run the full pipeline
- Return:

```typescript
{
  status: 'success' | 'partial' | 'failed';
  statements: ExtractedStatement[];
  validation: ValidationResult;
  corrections?: CorrectionResult;
  metadata: {
    fileName: string;
    format: string;
    processingTime: {
      textExtraction: number;   // ms
      classification: number;
      validation: number;
      selfCorrection: number;
      total: number;
    };
    tokensUsed: number;         // total GPT-4o tokens
    estimatedCost: number;      // USD
  };
}
```

3. **Error handling:**
   - Invalid file type → 400 with clear message
   - File too large (>20MB) → 400
   - GPT-4o timeout → retry once, then return partial
   - Org-scoped (use `authMiddleware` + `orgMiddleware`)
   - Audit log the extraction with deal ID if provided

4. **Integration tests:**
   - Upload a PDF → get structured financials back
   - Upload an Excel with 3 statement sheets → get all 3 extracted
   - Upload a garbage file → get proper error response
   - Validate that self-correction actually improves results (provide a file with a known error)

---

## How to Submit

1. Feature branch: `assignment/financial-extraction-<your-name>`
2. Single PR with all 5 tasks
3. Your PR should include:
   - Architecture overview — how the pipeline flows
   - Prompt engineering decisions — why you structured GPT-4o prompts the way you did
   - Token cost estimates per extraction
   - Sample input/output for each task
   - What you'd improve with more time
   - Which AI tools you used during development

## Evaluation Criteria

| Criteria | Weight | What We Look For |
|----------|--------|------------------|
| **Pipeline Architecture** | 25% | Clean separation of concerns, each step independently testable |
| **LLM Integration** | 25% | Prompt quality, structured output, token efficiency, error handling |
| **Validation Logic** | 20% | Comprehensive rules, correct math, handles edge cases |
| **Code Quality** | 20% | Follows repo patterns, clean TypeScript, proper error handling |
| **PR Quality** | 10% | Clear docs, prompt rationale, cost awareness |

## What We Provide

- Private fork with seed data + sample financial documents (PDFs and Excel files)
- Supabase staging env vars + OpenAI API key (capped at $10 — be token-efficient)
- 15-minute kickoff call + async Slack channel

---

*Questions? Slack channel is open. Good luck!*
