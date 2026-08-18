# Financial Extraction Accuracy Overhaul — Design Spec

**Date:** 2026-04-26
**Goal:** Achieve 90%+ extraction accuracy across CIMs, standalone financials, and Excel models
**Approach:** Full ensemble — bug fixes + smart chunking + enhanced prompts + multi-model verification

---

## Problem Statement

The current financial extraction pipeline produces vague, inaccurate numbers. Root causes identified:

1. **Verify node always disabled** — `skipVerify: true` hardcoded in `index.ts:78`, bypassing two-pass verification
2. **60K character truncation** — CIMs with 500K+ chars lose ~88% of content, including financial tables in appendices
3. **maxRetries defaults to 1** — Self-correction only gets one attempt instead of the intended 3
4. **Vision extractor hardcodes USD** — International financials (EUR, INR, GBP) extracted as USD regardless of source
5. **No source-text citation** — No way to trace where a number came from
6. **5% validation tolerance** — Allows "close but wrong" values through
7. **Confidence threshold too low** — 70% lets weak data auto-store
8. **No cross-model verification** — Single-model extraction with no second opinion

---

## Phase 1: Bug Fixes & Configuration (Foundation)

Zero-risk changes to the existing codebase. No new code, just fixing misconfigurations.

### Changes

| File | Line | Current | New | Rationale |
|------|------|---------|-----|-----------|
| `agents/financialAgent/index.ts` | 78 | `skipVerify: true` | `skipVerify: false` | Enable two-pass unit-scale/digit error detection |
| `agents/financialAgent/index.ts` | 77 | `maxRetries ?? 1` | `maxRetries ?? 3` | Allow 3 self-correction attempts as originally designed |
| `services/financialClassifier.ts` | ~125 | `text.slice(0, 60000)` | `text.slice(0, 120000)` | GPT-4o supports 128K tokens — use most of the context window |
| `services/visionExtractor.ts` | prompt | `"convert to millions USD"` | `"convert to millions in the document's original currency"` | Fix non-USD extraction bug |
| `services/financialValidator.ts` | ~10 | `TOLERANCE = 0.05` | `TOLERANCE = 0.01` for values > $1M, `0.02` otherwise | Catch "close but wrong" values |
| `agents/financialAgent/nodes/validateNode.ts` | ~15 | `CONFIDENCE_THRESHOLD = 70` | `CONFIDENCE_THRESHOLD = 80` | Stop weak data from auto-storing |

### Expected Impact
- Accuracy: ~60% → ~80%
- Cost: No change (verify node uses GPT-4o-mini at ~$0.003/run)
- Latency: +5-10 seconds (verify node)

---

## Phase 2: Smart Document Chunking & Table-First Strategy

### Problem
Even at 120K chars, very large documents lose data. Financial tables in appendices are critical.

### Smart Chunking Strategy

**When:** Document text exceeds 100K characters after extraction.

**How:**
1. Split text at section boundaries using header detection:
   - Regex patterns for common CIM headers: `Financial Summary`, `Income Statement`, `Historical Financials`, `Appendix`, `Projected`, etc.
   - Fall back to paragraph/page boundaries if no headers found
2. Each chunk gets up to 100K chars with 2K char overlap at boundaries
3. Score chunks by financial keyword density (revenue, EBITDA, margin, assets, cash flow, etc.)
4. Extract from each chunk independently (parallel GPT-4o calls)
5. Merge results by statement type + period

**Merge logic:**
- Same period, same value (within 1%) → keep higher-confidence version
- Same period, different values → flag as `needs_review` with both values stored
- Unique periods → keep as-is

### Table-First Strategy (When Azure Configured)

Azure Document Intelligence can extract structured tables from PDFs with high accuracy:

1. Run Azure `prebuilt-layout` model on the PDF
2. Score extracted tables for financial relevance (reuse existing Excel sheet scoring logic)
3. Convert relevant tables to CSV format
4. Send CSV to GPT-4o classifier — structured tabular data yields much higher accuracy than raw text
5. Only fall back to text extraction if Azure finds no financial tables

**When Azure is NOT configured:** Skip directly to text extraction with smart chunking. Azure is an optional accuracy booster, not a hard dependency.

### New File
`apps/api/src/services/documentChunker.ts`
- `chunkDocument(text: string, maxChunkSize: number): Chunk[]`
- `scoreChunkRelevance(chunk: string): number`
- `mergeExtractionResults(results: ClassificationResult[]): ClassificationResult`

### Expected Impact
- Accuracy for long CIMs: ~70% → ~85%
- Cost: +$0.02-0.04 per extraction (additional GPT-4o calls for multiple chunks)
- Latency: +10-20 seconds (parallel chunk extraction)

---

## Phase 3: Enhanced Prompt Engineering

### 3a. Source Citation Requirement

Every extracted value must include a `source_quote` — the exact text from the document where the number was found.

**New lineItems format:**
```json
{
  "revenue": 125.3,
  "revenue_source": "Total Revenue of $125.3 million for the year ended December 2023",
  "ebitda": 31.2,
  "ebitda_source": "Adjusted EBITDA was $31.2M (25% margin)",
  "confidence": 92
}
```

**Implementation:**
- Source quotes are stored alongside values in the `lineItems` JSONB column
- Keys follow pattern: `{field}_source` (e.g., `revenue_source`, `ebitda_source`)
- Source quotes are used by the verify node to cross-check against original text
- UI can optionally show source quotes as tooltips on financial values

### 3b. In-Prompt Math Validation

Add explicit verification instructions to the extraction prompt:

```
BEFORE returning your response, verify these math relationships:
1. revenue - cogs = gross_profit (within 1%)
2. ebitda / revenue * 100 ≈ ebitda_margin_pct (within 1pp)
3. ebitda - da = ebit (within 1%)
4. total_assets ≈ total_liabilities + total_equity (within 1%)
5. operating_cf - capex = fcf (within 1%)

If any check fails, re-examine your extraction and fix the error.
If the source document itself has inconsistent numbers, set confidence to 60-70
and add a warning explaining the discrepancy.
```

### 3c. Unit Scale Detection (Dedicated Step)

Before extracting values, GPT-4o must identify units:

```
STEP 1 — IDENTIFY UNITS:
Search the document for unit declarations:
- Header text: "in thousands", "in millions", "$000s", "₹ Cr", "€M"
- Table headers: "(000s)", "(mn)", "(Cr)", "(Lakh)"
- Footnotes: "All figures in millions unless otherwise stated"

State your finding: "UNITS DETECTED: [description]"

If NO unit declaration is found:
- Examine number magnitudes in context of company size
- Revenue of "125,000" for a mid-market company → likely thousands ($125M)
- Revenue of "125" → likely already in millions ($125M)
- Set confidence to 70 max when units are inferred, not declared
```

### 3d. Currency Detection (First Step)

```
STEP 0 — IDENTIFY CURRENCY:
Before extracting any financial data, determine the document currency:
- Symbols: $, €, £, ₹, ¥
- Text: "USD", "EUR", "GBP", "INR", "JPY", "dollars", "euros", "pounds", "rupees"
- If multiple currencies appear, use the one in the main financial statements
- Return ISO 4217 code (e.g., "USD", "INR", "EUR")
- Default to "USD" only if genuinely no currency indicator found
```

### 3e. Structured Output Schema

Use OpenAI's `response_format: { type: "json_schema" }` to enforce output structure:

```typescript
response_format: {
  type: "json_schema",
  json_schema: {
    name: "financial_extraction",
    strict: true,
    schema: {
      // Full schema defined during implementation — mirrors the
      // ClassificationResult type with added source_quote fields.
      // Key benefit: prevents GPT-4o from returning malformed JSON
      // or inventing field names not in our schema.
    }
  }
}
```

### Files Modified
- `apps/api/src/services/financialClassifier.ts` — restructured prompt with all enhancements
- `apps/api/src/services/visionExtractor.ts` — currency parameter, updated prompt
- `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts` — pass currency hint to vision

### Expected Impact
- Accuracy: ~80% → ~88%
- Cost: Minimal increase (same number of LLM calls, slightly longer prompts)
- Latency: No change

---

## Phase 4: Multi-Model Ensemble Verification

### Architecture

After GPT-4o extracts and the verify node runs, a Claude verification step cross-checks the top 15 most important financial values.

**Flow:**
```
GPT-4o Extraction + Verify Node
         │
         ▼
  Claude Verification (parallel with self-correct decision)
         │
         ▼
    Reconciler
    ├── Both agree (within 1%) → Store with high confidence
    └── Disagree (>1% diff)   → Flag for human review
```

### Claude Verifier

**Model:** Claude Haiku 4.5 (fast, cheap, accurate enough for verification)

**Input:**
1. Source text (same text/chunks GPT-4o saw)
2. GPT-4o's extracted values with source quotes
3. List of top 15 values to verify (revenue, EBITDA, net income, total assets, total liabilities, total equity, gross margin, operating CF, capex, FCF, debt, cash, revenue growth, EBITDA margin, interest expense)

**Prompt:**
```
You are a financial data verification analyst. You have received:
1. SOURCE TEXT from a financial document
2. EXTRACTED VALUES from a primary extraction model, each with a source quote

Your job: verify each extracted value against the source text.

For each value:
- Find the source quote in the original text
- Confirm the number matches what the text says
- Check unit conversion is correct (thousands → millions, crores → millions, etc.)
- Check currency is correctly identified

Return for each value:
{
  "field": "revenue",
  "primary_value": 125.3,
  "verified": true/false,
  "your_value": 125.3 (or corrected value if different),
  "issue": null (or description of the problem),
  "confidence": 95
}
```

**Output:** Array of verification results, one per checked value.

### Reconciler Logic

```typescript
for (const field of verifiedFields) {
  const primary = gpt4oResult[field];
  const verified = claudeResult[field];

  if (verified.verified && Math.abs(primary - verified.your_value) / primary < 0.01) {
    // Both agree — boost confidence
    finalConfidence[field] = Math.min(100, avgConfidence + 10);
  } else {
    // Disagreement — flag for review
    flaggedValues.push({
      field,
      gpt4o_value: primary,
      claude_value: verified.your_value,
      issue: verified.issue,
    });
  }
}
```

### Graceful Degradation
If Claude API is unavailable (timeout, rate limit, error):
- Log the failure in agent steps
- Continue with GPT-4o results only
- Do NOT block the extraction pipeline
- Confidence scores are computed without the cross-model component (weighted at 0)

### New Files
- `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts` — Claude verification node
- Update `apps/api/src/services/agents/financialAgent/graph.ts` — add cross-verify after verify node

### Expected Impact
- Accuracy: ~88% → ~93-95%
- Cost: +$0.03-0.05 per extraction (Claude Haiku)
- Latency: +10-15 seconds (parallel with other post-extraction steps)

---

## Phase 5: Composite Confidence Scoring & Human Review

### Composite Confidence

Replace single self-reported LLM confidence with a weighted composite:

```
Final Confidence = weighted average of:
  ├── LLM self-reported confidence    (25%)
  ├── Source citation match            (25%) — does the quote exist in the document?
  ├── Math validation pass             (25%) — do the numbers add up?
  └── Cross-model agreement            (25%) — do GPT-4o and Claude agree?
```

**Source citation match scoring:**
- Quote found verbatim in source text → 100%
- Quote found with minor differences → 80%
- Quote not found → 40%
- No quote provided → 20%

**Math validation scoring:**
- All math checks pass → 100%
- Minor discrepancies (< 2%) → 80%
- Significant discrepancies (> 2%) → 40%
- Cannot validate (missing fields) → 60%

**Cross-model scoring:**
- Both models agree (within 1%) → 100%
- Minor difference (1-5%) → 70%
- Major difference (> 5%) → 30%
- Claude unavailable → N/A (redistribute weight to other factors, each gets 33%)

### Confidence Tiers & Storage Actions

| Tier | Score | Storage | UI Treatment |
|------|-------|---------|-------------|
| High | 90-100 | Auto-store | Green badge, no review needed |
| Medium | 80-89 | Auto-store | Amber "review suggested" badge |
| Low | 60-79 | Store with `needsReview: true` flag | Yellow warning, user must confirm in review modal |
| Very Low | < 60 | Do NOT store | Red alert, show both model outputs, user must manually enter or re-extract |

**Note:** "Needs review" uses a new boolean `needsReview` field on the `FinancialStatement` table (default `false`). The GET endpoint returns these rows but the UI renders them with a review prompt. Once user confirms, `needsReview` is set to `false`.

### Human Review UI

When extraction produces low-confidence values, the extraction result modal gains a **"Review Required"** section:

- Listed below the confidence bar in the existing modal
- Each flagged value shows:
  - Field name (e.g., "Revenue")
  - GPT-4o value and Claude value (if different)
  - Source quote (if available)
  - Editable input field (pre-filled with higher-confidence value)
  - Accept / Dismiss buttons
- "Confirm All" button at bottom stores reviewed values
- Unreviewed low-confidence values are NOT stored

### Agent Steps Transparency

All decisions logged to the agent `steps[]` array:
- Extraction path used (text/vision/excel/azure)
- Number of chunks processed
- Unit scale detected and currency identified
- Verify node findings (caught errors, corrections)
- Claude verification results (agree/disagree per value)
- Composite confidence breakdown per period
- Values flagged for human review and why

This powers the existing "Agent Log" tab on the deal page.

### Files Modified
- `apps/api/src/services/agents/financialAgent/state.ts` — add `compositeConfidence`, `flaggedValues`, `crossVerifyResult` to state
- `apps/api/src/services/agents/financialAgent/nodes/storeNode.ts` — confidence-gated storage logic
- `apps/web/js/financials.js` — human review section in extraction result modal

---

## Implementation Phases

The work is designed to be shipped incrementally. Each phase is independently valuable:

| Phase | Description | Effort | Accuracy Gain |
|-------|-------------|--------|---------------|
| 1 | Bug fixes & config | 1-2 hours | 60% → ~80% |
| 2 | Smart chunking + table-first | 1 day | ~80% → ~85% |
| 3 | Enhanced prompts + source citations | 1 day | ~85% → ~88% |
| 4 | Multi-model ensemble | 1 day | ~88% → ~93% |
| 5 | Composite confidence + human review | 1 day | ~93% → ~95% |

**Total estimated cost per extraction after all phases:** $0.15-0.25
**Total estimated latency:** 45-90 seconds (vs current 30-60s)

---

## Testing Strategy

### Unit Tests
- Validation tolerance changes (Phase 1)
- Document chunker: chunk splitting, overlap, merge logic (Phase 2)
- Composite confidence calculation (Phase 5)
- Reconciler logic: agree/disagree/graceful degradation (Phase 4)

### Integration Tests
- Extract from known CIM with verified numbers → compare output accuracy
- Extract from Excel with known values → compare
- Extract from non-USD document → verify currency handling
- Extract from 50+ page CIM → verify chunking captures appendix data
- Claude unavailable → verify graceful degradation

### Accuracy Benchmark
Create a test set of 10 documents with known correct values:
- 3 CIMs (English USD, English EUR, non-English INR)
- 3 standalone P&L/BS PDFs
- 2 Excel models
- 2 scanned/image PDFs

Run extraction before and after each phase. Track:
- Per-field accuracy (extracted vs. actual)
- Overall confidence scores
- Number of values flagged for review
- Cost and latency per extraction

---

## Dependencies

- **OpenAI API** — GPT-4o for extraction, GPT-4o-mini for verify node (existing)
- **Anthropic API** — Claude Haiku 4.5 for cross-verification (new dependency)
- **Azure Document Intelligence** — optional, for table-first strategy (existing optional)
- **No new npm packages required** — Anthropic SDK already available or easily added

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude API adds latency | Run in parallel with verify node; graceful degradation if unavailable |
| Smart chunking misses financial sections | Score chunks by keyword density; always include first and last 20K chars |
| Source citation increases prompt token usage | Source quotes are short (1 sentence); adds ~500 tokens per extraction |
| Human review slows down users | Only triggered for low-confidence values; most extractions auto-store |
| Higher cost per extraction ($0.15-0.25) | User confirmed accuracy > cost; ROI is immediate (fewer manual corrections) |
