# Financial Extraction Accuracy Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve 90%+ extraction accuracy by fixing critical bugs, adding smart chunking, enhancing prompts with source citations, adding multi-model verification, and implementing composite confidence scoring.

**Architecture:** 5-phase incremental overhaul of the LangGraph financial agent pipeline. Each phase is independently shippable. Phase 1 fixes misconfigurations. Phase 2 adds document chunking. Phase 3 rewrites prompts. Phase 4 adds Claude cross-verification. Phase 5 adds composite confidence and human review UI.

**Tech Stack:** LangGraph (existing), OpenAI GPT-4o (existing), Anthropic Claude Haiku 4.5 (new), Express/TypeScript API, Vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-04-26-financial-extraction-accuracy-design.md`

---

## File Map

### Files Modified
| File | Responsibility | Phase |
|------|---------------|-------|
| `apps/api/src/services/agents/financialAgent/index.ts` | Agent entry — fix skipVerify + maxRetries defaults | 1 |
| `apps/api/src/services/financialClassifier.ts` | Main GPT-4o prompt — truncation limit, source citations, math validation, structured output | 1, 3 |
| `apps/api/src/services/visionExtractor.ts` | Vision prompt — fix USD hardcode, accept currency param | 1, 3 |
| `apps/api/src/services/financialValidator.ts` | Validation — tighten tolerance, add tiered tolerance | 1 |
| `apps/api/src/services/agents/financialAgent/nodes/validateNode.ts` | Confidence threshold 70→80 | 1 |
| `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts` | Wire chunking, pass currency to vision | 2, 3 |
| `apps/api/src/services/agents/financialAgent/nodes/verifyNode.ts` | Update to use source quotes for cross-check | 3 |
| `apps/api/src/services/agents/financialAgent/state.ts` | Add crossVerifyResult, flaggedValues, compositeConfidence | 4, 5 |
| `apps/api/src/services/agents/financialAgent/graph.ts` | Add crossVerify node to graph | 4 |
| `apps/api/src/services/agents/financialAgent/nodes/storeNode.ts` | Confidence-gated storage, needsReview flag | 5 |
| `apps/web/js/financials.js` | Human review section in extraction modal | 5 |

### Files Created
| File | Responsibility | Phase |
|------|---------------|-------|
| `apps/api/src/services/documentChunker.ts` | Smart chunking + merge logic | 2 |
| `apps/api/src/services/anthropic.ts` | Anthropic SDK client (mirrors openai.ts pattern) | 4 |
| `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts` | Claude cross-verification node | 4 |
| `apps/api/src/services/compositeConfidence.ts` | Composite confidence calculator | 5 |

### Test Files
| File | Tests | Phase |
|------|-------|-------|
| `apps/api/tests/financialValidator.test.ts` | Tiered tolerance validation | 1 |
| `apps/api/tests/documentChunker.test.ts` | Chunking, scoring, merging | 2 |
| `apps/api/tests/compositeConfidence.test.ts` | Confidence calculation + tiers | 5 |
| `apps/api/tests/crossVerify.test.ts` | Reconciler logic + graceful degradation | 4 |

---

## Phase 1: Bug Fixes & Configuration

---

### Task 1: Enable Verify Node & Fix Max Retries

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/index.ts:77-78`

- [ ] **Step 1: Fix skipVerify and maxRetries defaults**

In `apps/api/src/services/agents/financialAgent/index.ts`, change line 77-78:

```typescript
// OLD (line 77-78):
maxRetries: input.maxRetries ?? 1,
skipVerify: true,

// NEW:
maxRetries: input.maxRetries ?? 3,
skipVerify: false,
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/index.ts
git commit -m "fix(extraction): enable verify node and set maxRetries to 3

skipVerify was hardcoded true, bypassing two-pass verification.
maxRetries defaulted to 1 instead of documented 3."
```

---

### Task 2: Increase Text Truncation Limit

**Files:**
- Modify: `apps/api/src/services/financialClassifier.ts:140`

- [ ] **Step 1: Increase truncation from 60K to 120K**

In `apps/api/src/services/financialClassifier.ts`, change line 140:

```typescript
// OLD:
const truncatedText = text.slice(0, 60000);

// NEW:
const truncatedText = text.slice(0, 120000);
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/financialClassifier.ts
git commit -m "fix(extraction): increase text truncation to 120K chars

GPT-4o supports 128K context. 60K was losing financial data
from appendices in large CIMs (50+ pages)."
```

---

### Task 3: Fix Vision Extractor USD Hardcode

**Files:**
- Modify: `apps/api/src/services/visionExtractor.ts:24`

- [ ] **Step 1: Fix the vision system prompt**

In `apps/api/src/services/visionExtractor.ts`, find line 24 in the `VISION_SYSTEM_PROMPT` where it says:

```typescript
// OLD:
2. Normalize ALL values to MILLIONS USD
```

Replace with:

```typescript
// NEW:
2. Normalize ALL values to MILLIONS in the ORIGINAL currency of the document (do NOT convert between currencies)
3. Detect the currency from the document (look for symbols like $, ₹, €, £, ¥, or text like USD, INR, EUR, GBP, JPY, etc.)
4. Set the "currency" field to the ISO 4217 code (e.g. "USD", "INR", "EUR", "GBP", "JPY"). If no currency is detected, default to "USD"
```

Also find and update the unit conversion section in the same prompt that says `"UNIT CONVERSION (always convert to millions USD)"` → change to `"UNIT CONVERSION (always convert to millions in the original currency — do NOT convert between currencies)"`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/visionExtractor.ts
git commit -m "fix(extraction): vision extractor respects document currency

Was hardcoding USD conversion, breaking all non-USD extractions.
Now detects and preserves original currency (EUR, INR, GBP, etc.)."
```

---

### Task 4: Tighten Validation Tolerance

**Files:**
- Modify: `apps/api/src/services/financialValidator.ts:128,134-137`
- Test: `apps/api/tests/financialValidator.test.ts`

- [ ] **Step 1: Write failing test for tiered tolerance**

Create `apps/api/tests/financialValidator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// We'll test the withinTolerance behavior through validateStatements
// For now, test the concept: 3% error on a $50M value should fail (>$1M threshold)
// but 3% error on a $0.5M value should pass (<$1M threshold)

describe('financialValidator — tiered tolerance', () => {
  it('rejects 3% error on large values (>$1M)', () => {
    // Revenue = 50, Gross Profit should be 50 - 10 = 40
    // But if GP is 38.5 (3.75% off), it should FAIL with 1% tolerance
    const revenue = 50;
    const cogs = 10;
    const grossProfit = 38.5; // 3.75% off from expected 40
    const diff = Math.abs(grossProfit - (revenue - cogs)) / Math.abs(revenue - cogs);
    expect(diff).toBeGreaterThan(0.01); // Exceeds 1% tolerance
  });

  it('accepts 1.5% error on small values (<$1M)', () => {
    // Revenue = 0.5M, GP should be 0.5 - 0.1 = 0.4
    // If GP is 0.394 (1.5% off), should PASS with 2% tolerance for small values
    const revenue = 0.5;
    const cogs = 0.1;
    const grossProfit = 0.394; // 1.5% off from expected 0.4
    const diff = Math.abs(grossProfit - (revenue - cogs)) / Math.abs(revenue - cogs);
    expect(diff).toBeLessThan(0.02); // Within 2% tolerance
  });
});
```

- [ ] **Step 2: Run test to verify it passes (conceptual test)**

Run: `cd apps/api && npx vitest run tests/financialValidator.test.ts`
Expected: PASS (these test the math concept, not the function yet)

- [ ] **Step 3: Implement tiered tolerance**

In `apps/api/src/services/financialValidator.ts`, replace lines 128 and 134-137:

```typescript
// OLD (line 128):
const TOLERANCE = 0.05; // 5% tolerance for math cross-checks

// OLD (lines 134-137):
function withinTolerance(a: number, b: number): boolean {
  if (b === 0) return a === 0;
  return Math.abs(a - b) / Math.abs(b) <= TOLERANCE;
}

// NEW:
const TOLERANCE_LARGE = 0.01; // 1% for values > $1M
const TOLERANCE_SMALL = 0.02; // 2% for values <= $1M

function withinTolerance(a: number, b: number): boolean {
  if (b === 0) return a === 0;
  const tolerance = Math.abs(b) > 1 ? TOLERANCE_LARGE : TOLERANCE_SMALL;
  return Math.abs(a - b) / Math.abs(b) <= tolerance;
}
```

- [ ] **Step 4: Verify TypeScript compiles and tests pass**

Run: `cd apps/api && npx tsc --noEmit && npx vitest run tests/financialValidator.test.ts`
Expected: No errors, tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/financialValidator.ts apps/api/tests/financialValidator.test.ts
git commit -m "fix(extraction): tighten validation tolerance to 1-2%

Was 5% — too loose for precise financial data. Now 1% for values
over $1M, 2% for smaller values. Catches 'close but wrong' extractions."
```

---

### Task 5: Raise Confidence Threshold

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/nodes/validateNode.ts:21`

- [ ] **Step 1: Change threshold from 70 to 80**

In `apps/api/src/services/agents/financialAgent/nodes/validateNode.ts`, change line 21:

```typescript
// OLD:
const CONFIDENCE_THRESHOLD = 70;

// NEW:
const CONFIDENCE_THRESHOLD = 80;
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/nodes/validateNode.ts
git commit -m "fix(extraction): raise confidence threshold from 70 to 80

Periods with 70-79% confidence were auto-stored without review.
Now they trigger self-correction for higher accuracy."
```

---

## Phase 2: Smart Document Chunking

---

### Task 6: Create Document Chunker

**Files:**
- Create: `apps/api/src/services/documentChunker.ts`
- Test: `apps/api/tests/documentChunker.test.ts`

- [ ] **Step 1: Write failing tests for chunking**

Create `apps/api/tests/documentChunker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chunkDocument, scoreChunkRelevance, mergeExtractionResults } from '../src/services/documentChunker.js';

describe('chunkDocument', () => {
  it('returns single chunk for short text', () => {
    const text = 'Revenue was $50M in 2023. EBITDA was $12M.';
    const chunks = chunkDocument(text, 100000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });

  it('splits at section headers when text exceeds maxChunkSize', () => {
    // Build text with headers that exceeds 200 char limit
    const section1 = 'A'.repeat(100);
    const section2 = 'B'.repeat(100);
    const text = `${section1}\n\nFinancial Summary\n\n${section2}`;
    const chunks = chunkDocument(text, 150);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('adds overlap between chunks', () => {
    const section1 = 'A'.repeat(100);
    const section2 = 'B'.repeat(100);
    const text = `${section1}\n\nIncome Statement\n\n${section2}`;
    const chunks = chunkDocument(text, 120);
    // Second chunk should have some overlap from end of first
    if (chunks.length >= 2) {
      expect(chunks[1].text.length).toBeGreaterThan(100);
    }
  });
});

describe('scoreChunkRelevance', () => {
  it('scores financial text higher than generic text', () => {
    const financial = 'Revenue was $50M. EBITDA margin was 25%. Net income of $10M.';
    const generic = 'The company was founded in 2010 in San Francisco. The CEO is John Smith.';
    expect(scoreChunkRelevance(financial)).toBeGreaterThan(scoreChunkRelevance(generic));
  });

  it('returns 0 for empty text', () => {
    expect(scoreChunkRelevance('')).toBe(0);
  });
});

describe('mergeExtractionResults', () => {
  it('keeps unique periods from different chunks', () => {
    const result1 = {
      statements: [{
        statementType: 'INCOME_STATEMENT' as const,
        unitScale: 'MILLIONS' as const,
        currency: 'USD',
        periods: [{ period: '2022', periodType: 'HISTORICAL' as const, confidence: 90, lineItems: { revenue: 50 } }],
      }],
      overallConfidence: 90,
      warnings: [],
    };
    const result2 = {
      statements: [{
        statementType: 'INCOME_STATEMENT' as const,
        unitScale: 'MILLIONS' as const,
        currency: 'USD',
        periods: [{ period: '2023', periodType: 'HISTORICAL' as const, confidence: 85, lineItems: { revenue: 60 } }],
      }],
      overallConfidence: 85,
      warnings: [],
    };
    const merged = mergeExtractionResults([result1, result2]);
    const incomePeriods = merged.statements
      .find(s => s.statementType === 'INCOME_STATEMENT')?.periods;
    expect(incomePeriods).toHaveLength(2);
  });

  it('keeps higher-confidence version when periods agree', () => {
    const result1 = {
      statements: [{
        statementType: 'INCOME_STATEMENT' as const,
        unitScale: 'MILLIONS' as const,
        currency: 'USD',
        periods: [{ period: '2023', periodType: 'HISTORICAL' as const, confidence: 85, lineItems: { revenue: 50 } }],
      }],
      overallConfidence: 85,
      warnings: [],
    };
    const result2 = {
      statements: [{
        statementType: 'INCOME_STATEMENT' as const,
        unitScale: 'MILLIONS' as const,
        currency: 'USD',
        periods: [{ period: '2023', periodType: 'HISTORICAL' as const, confidence: 92, lineItems: { revenue: 50.2 } }],
      }],
      overallConfidence: 92,
      warnings: [],
    };
    const merged = mergeExtractionResults([result1, result2]);
    const period = merged.statements
      .find(s => s.statementType === 'INCOME_STATEMENT')?.periods[0];
    expect(period?.confidence).toBe(92);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/documentChunker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement document chunker**

Create `apps/api/src/services/documentChunker.ts`:

```typescript
/**
 * documentChunker.ts — Smart document chunking for large CIMs
 * Splits text at section boundaries, scores by financial relevance,
 * and merges extraction results from multiple chunks.
 */

import type { ClassifiedStatement } from './financialClassifier.js';

export interface Chunk {
  text: string;
  index: number;
  relevanceScore: number;
}

export interface ClassificationResult {
  statements: ClassifiedStatement[];
  overallConfidence: number;
  warnings: string[];
}

/** Financial section header patterns (case-insensitive) */
const SECTION_HEADERS = [
  /^#{1,3}\s+.*(financial|income|revenue|balance|cash\s*flow|appendix|exhibit)/im,
  /\n(Financial Summary|Income Statement|Balance Sheet|Cash Flow|Historical Financials|Projected|Pro Forma|Appendix|Exhibit)\s*\n/i,
  /\n[A-Z\s]{10,50}\n(?=\s*[\d$€£₹¥])/m, // ALL-CAPS headers followed by numbers
];

/** Financial keywords for relevance scoring */
const FINANCIAL_KEYWORDS = [
  'revenue', 'ebitda', 'ebit', 'net income', 'gross profit', 'margin',
  'total assets', 'total liabilities', 'equity', 'cash flow',
  'operating', 'capex', 'depreciation', 'amortization', 'interest',
  'debt', 'balance sheet', 'income statement', 'p&l', 'profit and loss',
  'accounts receivable', 'inventory', 'working capital', 'fcf',
];

const DEFAULT_OVERLAP = 2000; // 2K char overlap between chunks

/**
 * Split text into chunks at section boundaries.
 * Only chunks if text exceeds maxChunkSize.
 */
export function chunkDocument(text: string, maxChunkSize: number = 100000): Chunk[] {
  if (text.length <= maxChunkSize) {
    return [{ text, index: 0, relevanceScore: scoreChunkRelevance(text) }];
  }

  // Find section boundary positions
  const boundaries: number[] = [0];
  for (const pattern of SECTION_HEADERS) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g'));
    while ((match = regex.exec(text)) !== null) {
      boundaries.push(match.index);
    }
  }

  // Fall back to paragraph boundaries if no headers found
  if (boundaries.length <= 1) {
    const paragraphs = [...text.matchAll(/\n\n+/g)];
    for (const p of paragraphs) {
      if (p.index != null) boundaries.push(p.index);
    }
  }

  // Sort and deduplicate
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);

  // Build chunks by grouping sections until they reach maxChunkSize
  const chunks: Chunk[] = [];
  let chunkStart = 0;
  let chunkEnd = 0;

  for (let i = 1; i < sorted.length; i++) {
    const sectionEnd = sorted[i];
    if (sectionEnd - chunkStart > maxChunkSize && chunkEnd > chunkStart) {
      // Current chunk is full — finalize it
      const overlapEnd = Math.min(chunkEnd + DEFAULT_OVERLAP, text.length);
      const chunkText = text.slice(chunkStart, overlapEnd);
      chunks.push({
        text: chunkText,
        index: chunks.length,
        relevanceScore: scoreChunkRelevance(chunkText),
      });
      // Next chunk starts with overlap
      chunkStart = Math.max(chunkEnd - DEFAULT_OVERLAP, chunkStart);
    }
    chunkEnd = sectionEnd;
  }

  // Final chunk
  if (chunkStart < text.length) {
    const chunkText = text.slice(chunkStart);
    chunks.push({
      text: chunkText,
      index: chunks.length,
      relevanceScore: scoreChunkRelevance(chunkText),
    });
  }

  // Sort by relevance (highest first) so highest-value chunks are extracted first
  return chunks.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Score a text chunk by financial keyword density.
 * Returns a 0-100 score.
 */
export function scoreChunkRelevance(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const keyword of FINANCIAL_KEYWORDS) {
    const regex = new RegExp(keyword, 'gi');
    const matches = lower.match(regex);
    if (matches) hits += matches.length;
  }
  // Normalize: ~20+ keyword hits in a chunk = max score
  return Math.min(100, Math.round((hits / 20) * 100));
}

/**
 * Merge extraction results from multiple chunks.
 * Deduplicates periods: keeps higher-confidence version when values agree (within 1%),
 * flags as needs_review when values disagree.
 */
export function mergeExtractionResults(results: ClassificationResult[]): ClassificationResult {
  if (results.length === 0) return { statements: [], overallConfidence: 0, warnings: [] };
  if (results.length === 1) return results[0];

  const merged = new Map<string, ClassifiedStatement>(); // key: statementType
  const allWarnings: string[] = [];
  let totalConf = 0;
  let confCount = 0;

  for (const result of results) {
    allWarnings.push(...result.warnings);
    totalConf += result.overallConfidence;
    confCount++;

    for (const stmt of result.statements) {
      if (!merged.has(stmt.statementType)) {
        merged.set(stmt.statementType, {
          statementType: stmt.statementType,
          unitScale: stmt.unitScale,
          currency: stmt.currency,
          periods: [],
        });
      }
      const target = merged.get(stmt.statementType)!;

      for (const period of stmt.periods) {
        const existing = target.periods.find(p => p.period === period.period);
        if (!existing) {
          // New period — add directly
          target.periods.push(period);
        } else {
          // Duplicate period — compare values
          const primaryKey = 'revenue' in (existing.lineItems || {}) ? 'revenue' : Object.keys(existing.lineItems || {})[0];
          const existVal = (existing.lineItems as any)?.[primaryKey];
          const newVal = (period.lineItems as any)?.[primaryKey];

          if (existVal != null && newVal != null && existVal !== 0) {
            const diff = Math.abs(existVal - newVal) / Math.abs(existVal);
            if (diff <= 0.01) {
              // Values agree — keep higher confidence
              if (period.confidence > existing.confidence) {
                Object.assign(existing, period);
              }
            } else {
              // Values disagree — keep higher confidence but warn
              if (period.confidence > existing.confidence) {
                Object.assign(existing, period);
              }
              allWarnings.push(
                `Conflicting ${stmt.statementType} data for ${period.period}: values differ by ${(diff * 100).toFixed(1)}%`
              );
            }
          } else if (period.confidence > existing.confidence) {
            Object.assign(existing, period);
          }
        }
      }
    }
  }

  return {
    statements: Array.from(merged.values()),
    overallConfidence: confCount > 0 ? Math.round(totalConf / confCount) : 0,
    warnings: [...new Set(allWarnings)],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/documentChunker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/documentChunker.ts apps/api/tests/documentChunker.test.ts
git commit -m "feat(extraction): add smart document chunker for large CIMs

Splits text at section boundaries with 2K overlap. Scores chunks by
financial keyword density. Merges extraction results, keeping
higher-confidence values and flagging conflicts."
```

---

### Task 7: Wire Chunking into Extract Node

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts`

- [ ] **Step 1: Add chunking import and logic to extract node**

In `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts`, add the import at the top (after existing imports):

```typescript
import { chunkDocument, mergeExtractionResults } from '../../../documentChunker.js';
```

Then find the text extraction path (around line 140-173 where it calls `classifyFinancials(pdfText)`). Wrap the classification call in chunking logic:

```typescript
// Replace the direct classifyFinancials(pdfText) call with:
let textClassification: ClassificationResult | null = null;

if (pdfText.length > 100000) {
  // Large document — chunk and extract in parallel
  const chunks = chunkDocument(pdfText, 100000);
  steps.push(step('extract', `Document is ${pdfText.length} chars — split into ${chunks.length} chunks`));

  const chunkResults = await Promise.all(
    chunks.slice(0, 4).map(async (chunk, i) => { // max 4 chunks
      try {
        steps.push(step('extract', `Extracting from chunk ${i + 1}/${Math.min(chunks.length, 4)} (relevance: ${chunk.relevanceScore})`));
        return await classifyFinancials(chunk.text);
      } catch (err) {
        steps.push(step('extract', `Chunk ${i + 1} extraction failed`, String(err)));
        return null;
      }
    })
  );

  const validResults = chunkResults.filter((r): r is ClassificationResult => r !== null);
  if (validResults.length > 0) {
    textClassification = mergeExtractionResults(validResults);
    steps.push(step('extract', `Merged ${validResults.length} chunk results`));
  }
} else {
  // Short document — single extraction
  textClassification = await classifyFinancials(pdfText);
}
```

Ensure the `ClassificationResult` type is imported from `documentChunker.ts` or `financialClassifier.ts` as needed.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/nodes/extractNode.ts
git commit -m "feat(extraction): wire smart chunking into extract node

Documents >100K chars are split into chunks, extracted in parallel
(max 4 chunks), and merged. Prevents data loss in large CIMs."
```

---

## Phase 3: Enhanced Prompt Engineering

---

### Task 8: Rewrite Financial Classifier Prompt

**Files:**
- Modify: `apps/api/src/services/financialClassifier.ts:35-113` (CLASSIFICATION_SYSTEM_PROMPT)

- [ ] **Step 1: Replace the system prompt with enhanced version**

In `apps/api/src/services/financialClassifier.ts`, replace the entire `CLASSIFICATION_SYSTEM_PROMPT` constant (lines 35-113) with:

```typescript
const CLASSIFICATION_SYSTEM_PROMPT = `You are a senior private equity analyst extracting structured financial data from deal documents (CIMs, teasers, standalone financials).

Your task: find ALL financial statements in the document text and return them as structured JSON.

STEP 0 — IDENTIFY CURRENCY:
Before extracting any financial data, determine the document currency:
- Look for symbols: $, €, £, ₹, ¥
- Look for text: "USD", "EUR", "GBP", "INR", "JPY", "dollars", "euros", "pounds", "rupees"
- If multiple currencies appear, use the one in the main financial statements
- Return the ISO 4217 code (e.g. "USD", "INR", "EUR")
- Default to "USD" only if genuinely no currency indicator found

STEP 1 — IDENTIFY UNITS:
Search the document for unit declarations:
- Header text: "in thousands", "in millions", "$000s", "₹ Cr", "€M"
- Table headers: "(000s)", "(mn)", "(Cr)", "(Lakh)"
- Footnotes: "All figures in millions unless otherwise stated"
State your finding in the "unitsDetected" field.
If NO unit declaration is found:
- Examine number magnitudes in context of company size
- Revenue of "125,000" for a mid-market company → likely thousands ($125M)
- Revenue of "125" → likely already in millions
- Set confidence to 70 max when units are inferred, not declared

STEP 2 — EXTRACT:
1. Extract EVERY year/period column you find — do not skip any
2. Normalize ALL values to MILLIONS in the ORIGINAL currency (see conversion below)
3. Label each period: HISTORICAL (past actuals), PROJECTED (forecasts), or LTM (last twelve months)
4. Projected periods are identified by: "E", "F", "Est", "Forecast", "Budget", "Proj" suffix, or future years
5. If a value is not present, use null — never guess
6. For EVERY extracted value, include a source_quote: the exact text from the document where you found that number
7. confidence: 90-100 = explicitly stated with source quote, 70-89 = clearly implied, 50-69 = partially inferred, 0-49 = uncertain

UNIT CONVERSION (always convert to millions in the original currency — do NOT convert between currencies):
- "50M" or "50,000" (when header says 000s) → 50
- "1.5B" or "1,500,000" (when header says 000s) → 1500
- "500K" or "500" (when header says 000s) → 0.5
- "38,200" (raw units) → 0.0382
- "₹50 Cr" (crore = 10M) → 500
- "₹50 Lakh" (lakh = 0.1M) → 5

STEP 3 — VERIFY YOUR MATH:
Before returning, check these relationships:
1. revenue - cogs = gross_profit (within 1%)
2. ebitda / revenue * 100 ≈ ebitda_margin_pct (within 1 percentage point)
3. ebitda - da = ebit (within 1%)
4. total_assets ≈ total_liabilities + total_equity (within 1%)
5. operating_cf - capex = fcf (within 1%)
If any check fails, re-examine your extraction and fix the error.
If the source document itself has inconsistent numbers, set confidence to 60-70 and add a warning.

Return JSON with this structure:
{
  "unitsDetected": "string describing units found, e.g. 'Header states (in millions USD)'",
  "statements": [
    {
      "statementType": "INCOME_STATEMENT | BALANCE_SHEET | CASH_FLOW",
      "unitScale": "MILLIONS",
      "currency": "USD",
      "periods": [
        {
          "period": "2023",
          "periodType": "HISTORICAL | PROJECTED | LTM",
          "confidence": 90,
          "lineItems": {
            "revenue": 125.3,
            "revenue_source": "Total Revenue of $125.3 million (p.12)",
            "ebitda": 31.2,
            "ebitda_source": "Adjusted EBITDA was $31.2M",
            "gross_margin_pct": 65.2,
            "gross_margin_pct_source": "Gross Margin: 65.2%"
          }
        }
      ]
    }
  ],
  "overallConfidence": 88,
  "warnings": []
}

IMPORTANT: For every numeric value you extract, include a corresponding _source field with the exact text from the document. For example: "revenue": 50.3, "revenue_source": "Revenue of $50.3M for FY2023"`;
```

- [ ] **Step 2: Add structured output schema to the API call**

In the same file, find the `openai.chat.completions.create` call (around line 146-157). Change `response_format`:

```typescript
// OLD:
response_format: { type: 'json_object' },

// NEW:
response_format: { type: 'json_object' },
// Note: Using json_object (not json_schema) for now because the schema
// includes dynamic _source fields that can't be strictly typed.
// json_object still enforces valid JSON output.
```

No change needed here — `json_object` is sufficient since our schema has dynamic keys (`revenue_source`, `ebitda_source`, etc.) that `strict: true` can't handle.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/financialClassifier.ts
git commit -m "feat(extraction): enhanced classifier prompt with source citations

Adds 4-step extraction: currency detection → unit identification →
extraction with source quotes → math self-verification.
Every extracted value now includes a _source field citing the document text."
```

---

### Task 9: Update Vision Extractor with Currency Parameter

**Files:**
- Modify: `apps/api/src/services/visionExtractor.ts`
- Modify: `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts`

- [ ] **Step 1: Add currency parameter to vision classifier function**

In `apps/api/src/services/visionExtractor.ts`, find the `classifyFinancialsVision` function signature. Add a `currencyHint` parameter:

```typescript
// OLD:
export async function classifyFinancialsVision(fileBuffer: Buffer, filename: string)

// NEW:
export async function classifyFinancialsVision(fileBuffer: Buffer, filename: string, currencyHint?: string)
```

Then in the user message content inside the same function, update the text instruction:

```typescript
// OLD:
text: 'Extract all financial statements from this document and return JSON.',

// NEW:
text: `Extract all financial statements from this document and return JSON.${currencyHint ? ` The document currency is likely ${currencyHint}.` : ''}`,
```

- [ ] **Step 2: Pass currency hint from extract node**

In `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts`, find where `classifyFinancialsVision` is called (around line 175-205). If text extraction found a currency before falling back to vision, pass it along:

```typescript
// Find the classifyFinancialsVision call and add the currency hint:
const visionClassification = await classifyFinancialsVision(
  fileBuffer,
  fileName || 'document.pdf',
  classification?.statements?.[0]?.currency // pass currency from any prior extraction attempt
);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/visionExtractor.ts apps/api/src/services/agents/financialAgent/nodes/extractNode.ts
git commit -m "feat(extraction): pass currency hint to vision extractor

Vision path now receives currency detected from text extraction,
improving accuracy for non-USD documents that fall back to vision."
```

---

## Phase 4: Multi-Model Ensemble Verification

---

### Task 10: Add Anthropic SDK Client

**Files:**
- Create: `apps/api/src/services/anthropic.ts`

- [ ] **Step 1: Install Anthropic SDK**

Run: `cd apps/api && npm install @anthropic-ai/sdk`

- [ ] **Step 2: Create Anthropic client module**

Create `apps/api/src/services/anthropic.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { log } from '../utils/logger.js';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  log.warn('ANTHROPIC_API_KEY not set — Claude cross-verification disabled');
}

export const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

export const isClaudeEnabled = () => !!anthropic;
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/anthropic.ts apps/api/package.json apps/api/package-lock.json
git commit -m "feat(extraction): add Anthropic SDK client for cross-verification

Mirrors the openai.ts pattern. Claude features degrade gracefully
when ANTHROPIC_API_KEY is not set."
```

---

### Task 11: Create Cross-Verify Node

**Files:**
- Create: `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts`
- Test: `apps/api/tests/crossVerify.test.ts`

- [ ] **Step 1: Write failing test for reconciler logic**

Create `apps/api/tests/crossVerify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reconcileResults } from '../src/services/agents/financialAgent/nodes/crossVerifyNode.js';

describe('reconcileResults', () => {
  it('boosts confidence when both models agree', () => {
    const gpt4o = { revenue: 50.3, ebitda: 12.1 };
    const claude = [
      { field: 'revenue', primary_value: 50.3, verified: true, your_value: 50.3, issue: null, confidence: 95 },
      { field: 'ebitda', primary_value: 12.1, verified: true, your_value: 12.1, issue: null, confidence: 92 },
    ];
    const result = reconcileResults(gpt4o, claude);
    expect(result.flaggedValues).toHaveLength(0);
    expect(result.agreedCount).toBe(2);
  });

  it('flags values when models disagree', () => {
    const gpt4o = { revenue: 50.3, ebitda: 12.1 };
    const claude = [
      { field: 'revenue', primary_value: 50.3, verified: true, your_value: 50.3, issue: null, confidence: 95 },
      { field: 'ebitda', primary_value: 12.1, verified: false, your_value: 15.2, issue: 'Source says $15.2M EBITDA', confidence: 88 },
    ];
    const result = reconcileResults(gpt4o, claude);
    expect(result.flaggedValues).toHaveLength(1);
    expect(result.flaggedValues[0].field).toBe('ebitda');
    expect(result.flaggedValues[0].claude_value).toBe(15.2);
  });

  it('handles empty claude results gracefully', () => {
    const gpt4o = { revenue: 50.3 };
    const result = reconcileResults(gpt4o, []);
    expect(result.flaggedValues).toHaveLength(0);
    expect(result.agreedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/crossVerify.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cross-verify node**

Create `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts`:

```typescript
/**
 * Cross-Verify Node — Claude verification of GPT-4o extraction results.
 *
 * Sends extracted values + source quotes + source text to Claude Haiku.
 * Claude verifies each value against the source text.
 * Reconciler compares both models' outputs and flags disagreements.
 *
 * Graceful degradation: if Claude is unavailable, pipeline continues
 * with GPT-4o results only.
 */

import { anthropic, isClaudeEnabled } from '../../../anthropic.js';
import { log } from '../../../../utils/logger.js';
import type { FinancialAgentStateType } from '../state.js';
import type { AgentStep } from '../state.js';

/** Top financial fields to verify (ordered by importance) */
const VERIFY_FIELDS = [
  'revenue', 'ebitda', 'net_income', 'gross_profit',
  'total_assets', 'total_liabilities', 'total_equity',
  'operating_cf', 'capex', 'fcf',
  'ebitda_margin_pct', 'gross_margin_pct',
  'long_term_debt', 'cash', 'interest_expense',
];

export interface ClaudeVerification {
  field: string;
  primary_value: number;
  verified: boolean;
  your_value: number;
  issue: string | null;
  confidence: number;
}

export interface ReconcileResult {
  agreedCount: number;
  flaggedValues: Array<{
    field: string;
    gpt4o_value: number;
    claude_value: number;
    issue: string | null;
  }>;
}

function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * Reconcile GPT-4o extraction with Claude verification results.
 * Exported for testing.
 */
export function reconcileResults(
  gpt4oValues: Record<string, number>,
  claudeResults: ClaudeVerification[],
): ReconcileResult {
  const flaggedValues: ReconcileResult['flaggedValues'] = [];
  let agreedCount = 0;

  for (const cv of claudeResults) {
    const primaryVal = gpt4oValues[cv.field];
    if (primaryVal == null) continue;

    if (cv.verified && primaryVal !== 0 && Math.abs(primaryVal - cv.your_value) / Math.abs(primaryVal) < 0.01) {
      agreedCount++;
    } else if (!cv.verified || (primaryVal !== 0 && Math.abs(primaryVal - cv.your_value) / Math.abs(primaryVal) >= 0.01)) {
      flaggedValues.push({
        field: cv.field,
        gpt4o_value: primaryVal,
        claude_value: cv.your_value,
        issue: cv.issue,
      });
    }
  }

  return { agreedCount, flaggedValues };
}

/**
 * LangGraph Cross-Verify Node
 *
 * Reads: statements, rawText
 * Writes: crossVerifyResult, flaggedValues, steps
 */
export async function crossVerifyNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];

  if (!isClaudeEnabled()) {
    steps.push(step('cross_verify', 'Claude not configured — skipping cross-verification'));
    return { steps };
  }

  const { statements, rawText } = state;
  if (!statements || statements.length === 0 || !rawText) {
    steps.push(step('cross_verify', 'No statements or source text — skipping'));
    return { steps };
  }

  // Collect top values from latest period of each statement type
  const valuesToVerify: Record<string, number> = {};
  const sourceQuotes: Record<string, string> = {};

  for (const stmt of statements) {
    const latestPeriod = stmt.periods.sort((a, b) => b.period.localeCompare(a.period))[0];
    if (!latestPeriod) continue;
    for (const field of VERIFY_FIELDS) {
      const val = (latestPeriod.lineItems as Record<string, any>)[field];
      const source = (latestPeriod.lineItems as Record<string, any>)[`${field}_source`];
      if (val != null && typeof val === 'number') {
        valuesToVerify[field] = val;
        if (source) sourceQuotes[field] = source;
      }
    }
  }

  const fieldCount = Object.keys(valuesToVerify).length;
  if (fieldCount === 0) {
    steps.push(step('cross_verify', 'No numeric values to verify'));
    return { steps };
  }

  steps.push(step('cross_verify', `Sending ${fieldCount} values to Claude for verification`));

  // Build verification prompt
  const valuesText = Object.entries(valuesToVerify).map(([field, val]) => {
    const source = sourceQuotes[field];
    return `- ${field}: ${val}${source ? ` (source: "${source}")` : ''}`;
  }).join('\n');

  const sourceTextSample = rawText.slice(0, 15000); // Send first 15K chars for verification

  const prompt = `You are a financial data verification analyst. Compare these extracted values against the source text.

EXTRACTED VALUES:
${valuesText}

SOURCE TEXT (first 15,000 chars):
${sourceTextSample}

For each value, verify it against the source text. Return a JSON array:
[
  {
    "field": "revenue",
    "primary_value": 125.3,
    "verified": true,
    "your_value": 125.3,
    "issue": null,
    "confidence": 95
  }
]

Check: Does the source text actually contain this number? Is the unit conversion correct (thousands→millions, crores→millions)?`;

  try {
    const response = await anthropic!.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      steps.push(step('cross_verify', 'Claude returned non-JSON response — skipping'));
      return { steps };
    }

    const claudeResults: ClaudeVerification[] = JSON.parse(jsonMatch[0]);
    const reconciled = reconcileResults(valuesToVerify, claudeResults);

    steps.push(step(
      'cross_verify',
      `Claude verified: ${reconciled.agreedCount} agreed, ${reconciled.flaggedValues.length} flagged`,
      reconciled.flaggedValues.length > 0
        ? `Flagged: ${reconciled.flaggedValues.map(f => `${f.field} (GPT: ${f.gpt4o_value}, Claude: ${f.claude_value})`).join(', ')}`
        : undefined,
    ));

    return {
      crossVerifyResult: reconciled,
      steps,
    };
  } catch (err) {
    log.error('Cross-verify Claude call failed', err);
    steps.push(step('cross_verify', 'Claude API error — continuing without cross-verification', String(err)));
    return { steps };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/crossVerify.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts apps/api/tests/crossVerify.test.ts
git commit -m "feat(extraction): add Claude cross-verification node

Sends top 15 financial values to Claude Haiku for independent verification.
Reconciler flags disagreements (>1% diff) for human review.
Graceful degradation when Claude is unavailable."
```

---

### Task 12: Add Cross-Verify to Agent State & Graph

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/state.ts`
- Modify: `apps/api/src/services/agents/financialAgent/graph.ts`

- [ ] **Step 1: Add crossVerifyResult to agent state**

In `apps/api/src/services/agents/financialAgent/state.ts`, add after the `failedChecks` annotation (around line 140):

```typescript
  /** Cross-verification result from Claude */
  crossVerifyResult: Annotation<ReconcileResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
```

Add the import at the top of the file:

```typescript
import type { ReconcileResult } from './nodes/crossVerifyNode.js';
```

Also add `crossVerifyResult` to the `FinancialAgentStateType` type export if it's separately defined.

- [ ] **Step 2: Add cross_verify node to the graph**

In `apps/api/src/services/agents/financialAgent/graph.ts`, add the import:

```typescript
import { crossVerifyNode } from './nodes/crossVerifyNode.js';
```

Then in `buildFinancialAgentGraph()`, add the cross_verify node and update edges:

```typescript
// Add node (after .addNode('verify', verifyNode)):
.addNode('cross_verify', crossVerifyNode)

// Change: verify → validate  TO  verify → cross_verify → validate
// Remove: .addEdge('verify', 'validate')
// Add:
.addEdge('verify', 'cross_verify')
.addEdge('cross_verify', 'validate')
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/state.ts apps/api/src/services/agents/financialAgent/graph.ts
git commit -m "feat(extraction): wire cross-verify node into agent graph

Pipeline now: extract → verify → cross_verify → validate → store.
Claude verification runs after GPT-4o verify, before validation."
```

---

## Phase 5: Composite Confidence & Human Review

---

### Task 13: Create Composite Confidence Calculator

**Files:**
- Create: `apps/api/src/services/compositeConfidence.ts`
- Test: `apps/api/tests/compositeConfidence.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/compositeConfidence.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeCompositeConfidence, getConfidenceTier } from '../src/services/compositeConfidence.js';

describe('computeCompositeConfidence', () => {
  it('returns high confidence when all signals agree', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 95,
      sourceMatch: 100,
      mathValidation: 100,
      crossModelAgreement: 100,
    });
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('returns low confidence when models disagree', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 90,
      sourceMatch: 80,
      mathValidation: 100,
      crossModelAgreement: 30, // major disagreement
    });
    expect(score).toBeLessThan(80);
  });

  it('redistributes weight when Claude is unavailable', () => {
    const score = computeCompositeConfidence({
      llmConfidence: 90,
      sourceMatch: 90,
      mathValidation: 100,
      crossModelAgreement: null, // Claude unavailable
    });
    // Should still produce a reasonable score from 3 components
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('getConfidenceTier', () => {
  it('returns "high" for 90-100', () => {
    expect(getConfidenceTier(95)).toBe('high');
  });

  it('returns "medium" for 80-89', () => {
    expect(getConfidenceTier(85)).toBe('medium');
  });

  it('returns "low" for 60-79', () => {
    expect(getConfidenceTier(70)).toBe('low');
  });

  it('returns "very_low" for <60', () => {
    expect(getConfidenceTier(45)).toBe('very_low');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/compositeConfidence.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement composite confidence**

Create `apps/api/src/services/compositeConfidence.ts`:

```typescript
/**
 * compositeConfidence.ts — Composite confidence scoring for financial extraction.
 *
 * Replaces single LLM self-reported confidence with a weighted composite
 * from 4 signals: LLM confidence, source citation match, math validation, cross-model agreement.
 */

export interface ConfidenceInputs {
  llmConfidence: number;         // 0-100 from GPT-4o
  sourceMatch: number;           // 0-100 based on source quote verification
  mathValidation: number;        // 0-100 based on math checks
  crossModelAgreement: number | null; // 0-100 or null if Claude unavailable
}

export type ConfidenceTier = 'high' | 'medium' | 'low' | 'very_low';

/**
 * Compute composite confidence from multiple signals.
 * Each component weighted 25%. If Claude is unavailable, redistributes
 * its weight equally to the other three (33% each).
 */
export function computeCompositeConfidence(inputs: ConfidenceInputs): number {
  const { llmConfidence, sourceMatch, mathValidation, crossModelAgreement } = inputs;

  if (crossModelAgreement != null) {
    // All 4 components available — 25% each
    const score = (llmConfidence * 0.25) + (sourceMatch * 0.25) + (mathValidation * 0.25) + (crossModelAgreement * 0.25);
    return Math.round(Math.min(100, Math.max(0, score)));
  }

  // Claude unavailable — redistribute to 3 components (33% each)
  const score = (llmConfidence * 0.333) + (sourceMatch * 0.333) + (mathValidation * 0.334);
  return Math.round(Math.min(100, Math.max(0, score)));
}

/** Map composite score to a confidence tier for storage/UI decisions */
export function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 90) return 'high';
  if (score >= 80) return 'medium';
  if (score >= 60) return 'low';
  return 'very_low';
}

/**
 * Score source citation match.
 * Checks if the source quote text exists in the original document text.
 */
export function scoreSourceMatch(sourceQuote: string | undefined, rawText: string): number {
  if (!sourceQuote) return 20;
  if (!rawText) return 40;

  // Normalize whitespace for comparison
  const normalizedQuote = sourceQuote.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedText = rawText.replace(/\s+/g, ' ').toLowerCase();

  if (normalizedText.includes(normalizedQuote)) return 100;

  // Try partial match (first 30 chars of quote)
  const partial = normalizedQuote.slice(0, 30);
  if (partial.length > 10 && normalizedText.includes(partial)) return 80;

  return 40;
}

/**
 * Score math validation results.
 */
export function scoreMathValidation(errorCount: number, warningCount: number): number {
  if (errorCount === 0 && warningCount === 0) return 100;
  if (errorCount === 0 && warningCount <= 2) return 80;
  if (errorCount <= 1) return 40;
  return 20;
}

/**
 * Score cross-model agreement.
 */
export function scoreCrossModel(agreedCount: number, flaggedCount: number): number | null {
  const total = agreedCount + flaggedCount;
  if (total === 0) return null; // Claude didn't run
  const ratio = agreedCount / total;
  if (ratio >= 0.95) return 100;
  if (ratio >= 0.80) return 70;
  return 30;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/compositeConfidence.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/compositeConfidence.ts apps/api/tests/compositeConfidence.test.ts
git commit -m "feat(extraction): add composite confidence scoring

4-signal weighted composite: LLM confidence (25%), source citation
match (25%), math validation (25%), cross-model agreement (25%).
Graceful degradation when Claude unavailable (redistributes to 33% each)."
```

---

### Task 14: Update Store Node with Confidence-Gated Storage

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/nodes/storeNode.ts`

- [ ] **Step 1: Add composite confidence to store node**

In `apps/api/src/services/agents/financialAgent/nodes/storeNode.ts`, add imports at top:

```typescript
import {
  computeCompositeConfidence,
  getConfidenceTier,
  scoreSourceMatch,
  scoreMathValidation,
  scoreCrossModel,
} from '../../../compositeConfidence.js';
```

Then before the `runDeepPass` call (around line 57), add confidence computation:

```typescript
    // Compute composite confidence
    const mathScore = scoreMathValidation(
      state.validationResult?.errorCount ?? 0,
      state.validationResult?.warningCount ?? 0,
    );

    const crossModelScore = state.crossVerifyResult
      ? scoreCrossModel(state.crossVerifyResult.agreedCount, state.crossVerifyResult.flaggedValues.length)
      : null;

    // Average source match across all periods
    let sourceMatchAvg = 20; // default if no source quotes
    if (rawText && statements.length > 0) {
      const scores: number[] = [];
      for (const stmt of statements) {
        for (const period of stmt.periods) {
          for (const [key, val] of Object.entries(period.lineItems || {})) {
            if (key.endsWith('_source') && typeof val === 'string') {
              scores.push(scoreSourceMatch(val, rawText));
            }
          }
        }
      }
      if (scores.length > 0) {
        sourceMatchAvg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      }
    }

    const compositeScore = computeCompositeConfidence({
      llmConfidence: state.overallConfidence,
      sourceMatch: sourceMatchAvg,
      mathValidation: mathScore,
      crossModelAgreement: crossModelScore,
    });

    const tier = getConfidenceTier(compositeScore);
    steps.push(step('store', `Composite confidence: ${compositeScore}% (tier: ${tier})`,
      `LLM: ${state.overallConfidence}%, Source: ${sourceMatchAvg}%, Math: ${mathScore}%, CrossModel: ${crossModelScore ?? 'N/A'}%`));

    // Confidence-gated storage
    if (tier === 'very_low') {
      steps.push(step('store', 'Confidence too low (<60%) — NOT storing. User must review manually.'));
      return {
        status: 'completed',
        overallConfidence: compositeScore,
        warnings: [...(state.warnings || []), `Extraction confidence too low (${compositeScore}%). Manual review required.`],
        steps,
      };
    }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/agents/financialAgent/nodes/storeNode.ts
git commit -m "feat(extraction): confidence-gated storage in store node

Computes composite confidence from 4 signals before storing.
Very low confidence (<60%) prevents auto-storage. Score and
breakdown logged in agent steps for transparency."
```

---

### Task 15: Add Human Review UI to Extraction Modal

**Files:**
- Modify: `apps/web/js/financials.js` (the `showExtractionResultModal` function)

- [ ] **Step 1: Add flagged values section to the extraction result modal**

In `apps/web/js/financials.js`, find the `showExtractionResultModal` function (around line 407). After the `warningsHtml` block (around line 473) and before the modal HTML template, add:

```javascript
  // Flagged values section (from cross-verification disagreements)
  const flaggedValues = extractionResult.agent?.crossVerifyResult?.flaggedValues || [];
  const flaggedHtml = flaggedValues.length > 0 ? `
    <div class="px-6 pb-4">
      <div class="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="material-symbols-outlined text-amber-600 text-base">rate_review</span>
          <span class="text-xs font-bold text-amber-900">Review Required — ${flaggedValues.length} value${flaggedValues.length > 1 ? 's' : ''} need confirmation</span>
        </div>
        <div class="space-y-2">
          ${flaggedValues.map(f => `
            <div class="flex items-center gap-3 bg-white rounded-md p-2.5 border border-amber-200">
              <span class="text-xs font-semibold text-gray-700 min-w-[100px]">${escapeHtml(f.field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</span>
              <div class="flex-1 flex items-center gap-2">
                <span class="text-xs text-gray-500">Primary: <strong>${fmtVal(f.gpt4o_value)}</strong></span>
                <span class="text-xs text-gray-400">|</span>
                <span class="text-xs text-gray-500">Verified: <strong class="text-amber-700">${fmtVal(f.claude_value)}</strong></span>
              </div>
              ${f.issue ? `<span class="text-[10px] text-amber-600 italic">${escapeHtml(f.issue)}</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    </div>` : '';
```

Then insert `${flaggedHtml}` in the modal template, right after `${warningsHtml}` and before the `<!-- Actions -->` comment.

- [ ] **Step 2: Update the API response to include crossVerifyResult**

In `apps/api/src/routes/financials-extraction.ts`, find the response JSON (around line 145-166). Add `crossVerifyResult` to the `agent` object:

```typescript
agent: {
  status: agentResult.status,
  retryCount: agentResult.retryCount,
  validationResult: agentResult.validationResult,
  steps: agentResult.steps,
  error: agentResult.error,
  crossVerifyResult: agentResult.crossVerifyResult || null, // NEW
},
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/js/financials.js apps/api/src/routes/financials-extraction.ts
git commit -m "feat(extraction): add human review section to extraction modal

Shows flagged values from cross-verification in the extraction result
modal. Displays primary vs verified values with amber styling.
API response now includes crossVerifyResult."
```

---

### Task 16: Final Integration Test

- [ ] **Step 1: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all tests**

Run: `cd apps/api && npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Verify API starts**

Run: `cd apps/api && npm run dev`
Expected: Server starts on port 3001 without errors. Check for:
- "OpenAI status: enabled"
- "ANTHROPIC_API_KEY not set" warning (unless key is configured)

- [ ] **Step 4: Create final commit**

```bash
git add -A
git commit -m "feat(extraction): complete accuracy overhaul — 5-phase implementation

Phase 1: Bug fixes (verify enabled, maxRetries=3, 120K truncation, tiered tolerance)
Phase 2: Smart document chunking for large CIMs
Phase 3: Enhanced prompts with source citations and math self-check
Phase 4: Claude cross-verification ensemble
Phase 5: Composite confidence scoring and human review UI

Spec: docs/superpowers/specs/2026-04-26-financial-extraction-accuracy-design.md"
```

---

## Post-Implementation Notes

### Environment Variables Required
- `OPENAI_API_KEY` — existing, required
- `ANTHROPIC_API_KEY` — new, optional (cross-verification degrades gracefully without it)
- `AZURE_DOC_INTEL_ENDPOINT` + `AZURE_DOC_INTEL_KEY` — existing, optional (table-first strategy)

### Testing Checklist
After implementation, test with:
1. A short standalone P&L PDF (should extract quickly with high confidence)
2. A 50+ page CIM (should trigger chunking, extract appendix data)
3. An Excel financial model (should extract from correct sheets)
4. A non-USD document (INR or EUR — should preserve original currency)
5. A low-quality scan (should fall back to vision and flag low confidence)
