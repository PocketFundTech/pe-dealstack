# Financial Extraction & Analysis — Fix Log

A running record of bug fixes and pipeline changes for the financial
extraction & analysis subsystem. Newest first. Each entry lists the
symptom, the root cause, the fix, and any caveats. Commit hashes are
intentionally omitted from the body — `git log -- docs/financial-extraction-fixes.md`
or `git log -- apps/api/src/services/agents/financialAgent/` will surface
them as the file moves.

The pipeline at a glance:

```
upload → text-extract → classify → extract → verify → crossVerify → store
   |          |             |          |         |          |          |
 multer   pdfExtractor   financial-  Claude   GPT-4.1-   Claude    Supabase
   /     excelTo-       Classifier  Sonnet   mini       Haiku    Financial-
multipart Markdown                  4.5      (corrects)  (cross-  Statement
                                                          checks) rows
```

Period-scope inference + dedup happen between `classify` and `store`
(server side, in `runDeepPass`). The frontend does its own scope-grouping
in the growth chart on top of whatever periods come back from the API.

---

## Just shipped (this commit) — multi-doc re-extract + force ACTUALS + extended dedup

Three independent fixes for the production symptom on the Fight_AI deal:
re-extract showed `Revenue $6.7M / EBITDA $6.4M` (off by 1000×) plus
multiple X-axis duplicates (`FY26 Est`, `FY26 Est.`, `2026 FY Est`,
`YTD Total`, `YTD Total (Jan-Apr 20, 2026)`) even after clicking
Re-extract — and the deal had 12 source files but only 1 was being
processed.

### A. Re-extract processes ALL financial documents in the deal

**Symptom:** the Re-extract button on the Financial Analysis tab posted
to `/api/deals/:dealId/financials/extract` with no body. The endpoint
picked the most-recent CIM/FINANCIALS doc with `.limit(1).single()`
and stopped. Other 11 docs (other financial models, balance sheets,
historical periods, appendices) silently ignored. ss3 confirmed every
column header in the income table for Fight_AI shows the same
`Fight_AI_YTD_Fin…` source.

**Fix:** added a new `mode` param to `extractSchema`:
- `'single'` (default — backwards compat): existing behaviour
- `'all_financials'`: every doc where `type IN ('CIM', 'FINANCIALS')`
- `'all'`: every doc on the deal regardless of type

When multi-doc, the route loops sequentially through the docs (one at
a time so the per-org `acquireExtractionSlot` invariant holds), runs
`runFinancialAgent` on each, and collects per-doc results. The
`runDeepPass` upsert merges by `(dealId, statementType, period)` so
multiple docs that contribute to the same statement+period combine
naturally.

The aggregate response now includes `documentsProcessed[]`,
`result.documentsUsed`, `result.documentsFailed`, and per-doc
`{status, statementsStored, periodsStored, error?}`. A doc failure
doesn't short-circuit the loop; aggregate `success` is `true` if at
least one doc completed.

The frontend Re-extract button (`deal-financials.tsx:133`) now sends
`mode: "all_financials"` by default, with a follow-up toast naming the
doc count when N > 1.

**Files:**
- `apps/api/src/routes/financials-extraction.ts` (350 → 480 lines, all
  new code in `processOneDoc` helper + the rewritten POST handler)
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials.tsx`
  (re-extract call + multi-doc toast)

### B. Force ACTUALS when source has no explicit unit marker

**Symptom:** the same value `6700` from the Fight_AI Excel was tagged
3 different ways inside one extraction:
- `YTD Total (Jan-Apr 20, 2026) = 6700` → `unitScale: ACTUALS` (✓ $6.7K)
- `YTD Total = 6700` → `unitScale: MILLIONS, value 6.7` (✗ $6.7M)
- `FY26 Est = 22027` → `unitScale: MILLIONS, value 22.027` (✗ $22.0M)

The classifier was second-guessing on numbers > 1000 and tagging them
THOUSANDS / MILLIONS even though the source disclaimer literally said
`"All figures in USD"` (no scale modifier). The verifier's atomic
multiplier guard didn't fire because the verifier didn't think there
was an issue.

**Fix — two parts:**

1. **Strengthened classifier prompt** (`apps/api/src/services/extractionPrompt.ts`)
   - New "CRITICAL — DEFAULT TO ACTUALS WHEN IN DOUBT" block telling
     Claude not to guess scale based on value magnitude
   - Worked examples: same value `2,500` resolves to `$2.5B` /
     `$2.5M` / `$2,500` depending on the header — without a header,
     ACTUALS
   - Explicit clarification that `"All figures in USD"` is currency,
     not scale

2. **Deterministic post-classifier override** (`apps/api/src/services/financialClassifier.ts`)
   - New `detectExplicitUnitInText(text)` regex-scans for `$M`, `$K`,
     `$B`, `$000s`, `(in millions)`, `(in thousands)`, `(in billions)`,
     `(M)`, `(B)` (case-insensitive)
   - After classification, if a statement is tagged `MILLIONS` or
     `THOUSANDS` but no marker is found in the source text, override to
     `ACTUALS` and `log.warn` so we can monitor the LLM's tendency to
     over-guess in prod

Conservative: only fires when the LLM picked MILLIONS/THOUSANDS/BILLIONS
without textual evidence. ACTUALS values left untouched. The worst
case (sheet has a marker the regex misses) is recoverable — display
shows the source value at native scale, asymmetrically better than
silent 1000× inflation.

### C. Period dedup handles year-first FY-Est + plain "YTD Total"

**Symptom:** ss3 showed 5 income-statement columns for what should be
2 distinct concepts: `FY26 Est`, `FY26 Est.`, `2026 FY Est`, `YTD Total`,
`YTD Total (Jan-Apr 20, 2026)`. The earlier dedup pass collapsed
trailing-period and parentheses-year variants but not the year-first
ordering nor the bare `YTD Total`.

**Fix:** extended `normalizePeriodLabel` and `dedupePeriods`:

1. **Year-first FY-Est rule** — regex
   `^(\d{2,4})\s+FY\s+Est(?:imated?)?\.?$` (case-insensitive) →
   canonical `"FY<YY> Est"`. Handles `2026 FY Est`, `2026 FY Est.`,
   `2026 FY Estimate`, `2026 FY Estimated`, `26 FY Est`. Output matches
   the existing canonical so the existing dedup loop folds them with
   any pre-existing `"FY26 Est"` rows.

2. **Plain `YTD Total` → infer year from siblings.** New
   `inferYearFromSiblings` helper walks every sibling label in the
   bucket (same `statementType + periodType`), collects 4-digit and
   2-digit year tokens. If exactly one year emerges, rewrites the bare
   `"YTD Total"` → `"YTD <YEAR>"`. If years are mixed (cross-year
   doc), bails — leaves it as `"YTD Total"` to avoid wrong-year merges.

Logged: `Period dedup: inferred year for 'YTD Total' from siblings → 'YTD 2026'` and
`Period dedup: merged 'A' + 'B' + 'C' into 'X' (3 → 1, kept highest-confidence values)`.

**File:** `apps/api/src/services/financialPeriodNormalizer.ts`
(282 → 407 lines).

**Deliberately not normalised** (intentional — false-merge risk):
quarterly variants `Q1 2026 / Q1-2026 / Q1'26`, half-year `H1 2026`,
month-name variants `Jan-26 / January 2026`. Revisit when prod evidence
surfaces these.

### Frontend follow-up notes

The Re-extract button now defaults to multi-doc; per-doc Re-extract
endpoints (e.g. clicking re-extract from a single document in the data
room) keep the single-doc path. If a "this doc only" toggle is wanted,
the API supports `mode: "single" | "all_financials" | "all"` — UI work
is just adding the toggle.

---

## Previously shipped — chronological period sort + cashcap empty cards

### Charts + tables sort periods chronologically, not alphabetically

**Symptom:** Revenue, Growth, and the income/balance/cashflow tables on the
Financial Analysis tab rendered periods in **alphabetical** order
(`Apr-26 < Aug-26 < Dec-26 < Feb-26 < Jan-26 …`) because every consumer
used `rows.sort((a, b) => a.period.localeCompare(b.period))`. Bars
appeared in scrambled order; growth deltas computed across alphabetically-
adjacent periods (Apr → Aug → Dec) were meaningless.

**Fix:** new `comparePeriodChronologically(a, b)` and `periodChronoKey(p)`
helpers in `deal-financials-period-scope.ts`. Parse `(year, sub)` from
the label using a `MONTH_INDEX` table, the existing `inferPeriodScope`,
and a year extractor that handles both 4-digit (`2026`) and 2-digit
(`FY26`, `Apr-26`) forms. Sort by `(year asc, sub asc)` where sub
encodes:
- monthly / MTD: `0.01–0.12` (Jan = 0.01, Dec = 0.12)
- quarterly: `0.25 / 0.50 / 0.75 / 1.00`
- YTD: `1.10`, LTM: `1.20`, annual: `1.50`, FY estimate: `1.80`, other: `2.00`

So within a year, monthly periods sort Jan → Dec, then YTD sits after
December, then annual, then FY estimates last (projections come after
historicals). Across years, year wins.

**Files:**
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-period-scope.ts` (added comparator)
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-charts.tsx` (3 sort sites: RevenueChart, GrowthChart, BalanceSheetChart)
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-table.tsx` (Income / Balance / Cash Flow tables)
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-modal.tsx` (extraction-result modal — descending order for "latest first")

**Server-side `localeCompare` sorts** in `apps/api/src/routes/financials.ts:83`,
`apps/api/src/services/financialValidator.ts:319`, and CSV parsers
(`bankParser`, `stripeParser`, `squareParser`, `paypalParser`) are
**deliberately untouched** — the parsers use a separate `periodSort`
field that's already chronological (e.g. `2026-04`); the API + validator
sort is a follow-up if validator growth warnings still misfire.

### Cash & Capital tab now explains which document each card needs

**Symptom:** the Cash & Capital tab on the AI Financial Analysis surface
appeared "broken" / empty when a deal only had a P&L source document
(e.g. Fight_AI's `YTD P&L` sheet). The catch-all empty-state copy said
"will appear here once enough financial data is extracted" — useless,
because the user couldn't tell what specifically was missing.

**Root cause:** the three sub-cards (Cash Flow Analysis, Working Capital,
Debt Capacity) require different source data. Cash Flow needs
INCOME_STATEMENT (ebitda) + CASH_FLOW (capex / fcf). Working Capital
needs BALANCE_SHEET (AR / AP / inventory / current assets / current
liabilities). Debt Capacity needs BALANCE_SHEET (debt + cash) + INCOME
(interest expense). On an income-only deal, all three return either
`undefined` or objects full of nulls, and the panel collapses to one
generic empty state.

**Fix:** per-card emptiness detection. Each of the three cards now either
renders with data, or shows an inline `CashCapEmptyCard` that names the
exact source document needed. Top-level fallback (when *all three* are
empty) explicitly says "needs a Balance Sheet and Cash Flow statement
in addition to the Income Statement".

**File:** `apps/web-next/src/app/(app)/deals/[id]/deal-analysis-cashcap.tsx`

---

## Previously shipped — pipeline honors the source's actual unit scale

The whole financial-extraction pipeline was forcibly converting every
value to "MILLIONS" regardless of source. A startup spreadsheet with
`Revenue: $6,700` (actual dollars) ended up stored as `0.0067` with
`unitScale: MILLIONS`. Five places baked that assumption in. Three
parallel agents (X / Y / Z) ripped it out across prompts, storage, and
UI in one coordinated pass.

**Production symptoms this fixes:**
- Tiny absolute values (`$0.0067M`) appearing for small-business
  extractions, with `M` suffix everywhere even when source has no unit
  hint or is explicitly in actual dollars / thousands.
- Cross-document verification flagging huge phantom discrepancies
  because doc A stored revenue at `MILLIONS=53.7` and doc B at
  `ACTUALS=53,700,000` — same underlying number, but compared raw
  triggered a 999,999% discrepancy.
- AI cross-verify (Claude Haiku) confused into flagging valid actual-
  dollar values because the prompt told it to assume millions.
- `EBITDA margin > 95%` validator warnings firing on legitimate small
  SaaS numbers because validator thresholds are calibrated for
  millions-scale companies.

### Agent X — strip "convert to MILLIONS" from every prompt + default

**Files modified (5 in scope, +3 symmetric fixes the agent found):**
- `apps/api/src/services/excelFinancialExtractor.ts` — `detectUnitScale`
  hints now name the source unit and instruct Claude to *preserve* it
  (`"Store values as written; set unitScale to <UNIT>. Do NOT convert."`)
  rather than the prior "divide by N to get millions".
- `apps/api/src/services/agents/financialAgent/nodes/selfCorrectNode.ts`
  — system rule "Normalize all values to MILLIONS USD" → "Preserve the
  source's unit scale. Set unitScale to whatever the source uses". JSON
  schema example placeholder `"<MILLIONS|THOUSANDS|ACTUALS|BILLIONS — match the source>"`.
- `apps/api/src/services/agents/financialAgent/nodes/verifyNode.ts` —
  prompt now opens with a per-unitScale interpretation table (showing
  `value 6700, unitScale ACTUALS = $6,700` is correct) and tells the
  verifier `correctValue MUST be expressed at the SAME unitScale as the
  statement`.
- `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts`
  — `collectTopValues` now returns `{ values, meta }` carrying per-field
  `{ unitScale, currency }`. `buildVerifyPrompt` annotates each value
  line as `revenue: 6700  (unitScale: ACTUALS, currency: USD)` so Haiku
  verifies at the right scale. Replaced "in millions USD unless
  otherwise stated" with the per-unitScale interpretation table.
- `apps/api/src/services/financialClassifier.ts` — `UnitScale` type
  now includes `'BILLIONS'`. `normalizeUnitScale` defaults unknown /
  missing to `'ACTUALS'` (was silently `'MILLIONS'`) and emits
  `log.warn` so we catch model regressions in prod.
- `apps/api/src/services/extractionPrompt.ts` (the *original* "always
  millions" sin) — STEP 1 now sets `unitScale: ACTUALS` when no header
  is found; STEP 2 rule 2 → "PRESERVE THE SOURCE'S UNIT SCALE … Do NOT
  convert"; UNIT CONVERSION block became a unit-scale-tagging block;
  JSON example shows the placeholder rather than `"MILLIONS"`.
- `apps/api/src/services/visionExtractor.ts` — same `normalizeUnitScale`
  treatment as the classifier.
- `apps/api/src/services/documentChunker.ts` — chunk-merge fallback
  `?? 'MILLIONS'` → `?? 'ACTUALS'`.
- `apps/api/src/routes/financials.ts` — Zod enum extended with
  `'BILLIONS'` so the API patch endpoint accepts it.

### Agent Y — thread `unitScale` through storage, API responses, and cross-doc compare

**Schema check:** `FinancialStatement.unitScale TEXT NOT NULL DEFAULT 'MILLIONS' CHECK (… IN ('MILLIONS','THOUSANDS','ACTUALS'))` already exists. CHECK constraint did NOT include `'BILLIONS'`. **New migration required** before a BILLIONS classification can land — see deploy-step note below.

**Storage path verified:** `financialExtractionOrchestrator.ts:154,187`
both INSERT and UPSERT include `unitScale: stmt.unitScale`. CSV parsers
(`squareParser.ts`, `bankParser.ts`, `paypalParser.ts`) all set
`unitScale: 'ACTUALS'`. No fix needed there.

**Read paths fixed:**
- `apps/api/src/routes/financials-merge.ts:42-58` — conflicts endpoint
  versions array now exposes `unitScale + currency` per version.
- `apps/api/src/routes/deals-chat-ai.ts:20-64,213-218` — `FinancialRow`
  interface gained `unitScale + currency`. The hard-coded "All values
  in $M USD" header in the LLM context now shows actual scales, with
  per-statement labels when mixed.

**Cross-doc verification fix (the user-reported "millions of issues"):**
`apps/api/src/routes/financials-analysis.ts:221-285` was comparing raw
`lineItems` values across documents without normalising for `unitScale`.
Added `toMillions` helper that converts each value to a common scale
before computing `discrepancyPct`. Display values preserve the source
scale; only the comparison is normalised. Per-version `unitScale` now
returned in `values[]` so the frontend renders each at the right unit.

**Bonus normalisation fix:** `financials-memo.ts:33-83` peer-benchmark
endpoint had the same cross-deal raw-comparison bug. Same `toMillions`
helper applied.

**Frontend type chain updated:**
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-conflicts.tsx:3-15`
  — `ConflictVersion` gained `unitScale + currency`.

### Agent Z — frontend `formatFinancialValue` + per-call-site rollout

**New helper** in `apps/web-next/src/lib/formatters.ts` (164 → 288 lines):
- `formatFinancialValue(value, unitScale?, { currency?, precision? })`
  — converts the stored value to actual dollars via `unitScale`, then
  auto-renders at the most appropriate magnitude:
  `< 1,000` raw, `1K–999K`, `1M–999M`, `≥ 1B`. Em-dash on null /
  undefined / NaN. INR uses `Cr`/`L`. Default scale `ACTUALS`,
  precision `1`. Worked examples:
  - `formatFinancialValue(0.0067, 'MILLIONS')` → `"$6.7K"`
  - `formatFinancialValue(6700, 'ACTUALS')` → `"$6.7K"` (same dollar
    amount, different storage unit, same display)
  - `formatFinancialValue(53.7, 'THOUSANDS')` → `"$53.7K"`
  - `formatFinancialValue(1.5, 'BILLIONS')` → `"$1.5B"`
- `formatPercent(value, decimals?)` — kept distinct from currency for
  ratio / margin / growth fields.
- `toActualDollars(value, unitScale?)` — chart datasets share the
  scaling logic without duplicating the multiplier table.

**Applied across 13 call sites** (replacing hardcoded `${val}M`-style
literals):
1. `deal-financials-formatters.tsx` — `fmtMoney` delegates to the new helper.
2. `deal-financials-table.tsx` — per-row `unitScale` (was first-row only).
3. `deal-financials-charts.tsx` — `RevenueChart` + `BalanceSheetChart`
   pre-convert via `toActualDollars`; y-axis ticks + tooltips
   auto-scale.
4. `deal-financials-modal.tsx` — fmtVal uses helper + latest statement's `unitScale`.
5. `deal-analysis-diligence.tsx` (Cross-Document Verification) — replaced
   `${v.value}M` with `formatFinancialValue(v.value, scale, { currency })`.
6. `deal-analysis-cashcap.tsx` — Cash Flow / Working Capital / Debt
   Capacity panels (8 sites in this file).
7. `deal-analysis-overview.tsx` — EBITDA Bridge (3 sites).
8. `deal-analysis-deepdive.tsx` — Financial Ratios + Cost Structure.
9. `deal-analysis-valuation.tsx` — LBO entry EBITDA + Benchmark (3 sites).
10. `deal-analysis-types.ts` — `AnalysisData` and `CrossDocConflict`
    extended with optional `unitScale + currency` per value.
11. `deal-financials-conflicts.tsx` — `ConflictVersion` extended.
12. `formatters.test.ts` — 16 new tests, all passing.

**Hardcoded `M` suffixes** in 5 files removed in favour of auto-scaled
labels. Chart axes now derive their suffix from the rendered tick value.

**Percentages kept separate** — `_pct` / `_margin` / IRR / CAGR / growth
all routed through `formatPercent`, not `formatFinancialValue`.

### Deploy step required for BILLIONS support

Before any extraction can return `unitScale: BILLIONS`, run the migration:

```
apps/api/financial-statement-billions-migration.sql
```

It drops + re-adds the CHECK constraint to allow `BILLIONS` alongside
the three existing values. Idempotent. Until this runs, a BILLIONS
classification will hit a Postgres CHECK violation on insert. The
classifier doesn't currently emit BILLIONS for the deals we've seen,
but $B-scale source documents will trigger it.

### Backwards compatibility

**Existing rows tagged `MILLIONS` aren't migrated.** Old extractions
that were silently converted to millions stay tagged that way. Their
displayed value will look correct because (a) the storage value is at
the millions scale and (b) the new formatter respects the stored
`unitScale`. No data loss; no display change for old data. Re-extract
a deal to get the new "honor source unit" behaviour.

The default-flip from `MILLIONS` → `ACTUALS` in `normalizeUnitScale`
means any older code path that *relied* on the silent default will
now tag values as ACTUALS instead. Mitigated by the new `log.warn` so
we can spot regressions in prod logs.

---

## Just shipped (previous commit)

Three independent fixes pushed together because they all chase the same
production symptom — the `Fight_AI_YTD_Financials_2026.xlsx` extraction
producing the chart spike of `+14079.1%` between `2026 YTD` and
`Apr-26 MTD`, plus 12 false `EBITDA margin > 95%` warnings.

### A. Growth chart filters by inferred period scope

**Symptom:** the Financial Analysis growth chart on `/deals/<id>` rendered
nonsense — a single time series mixing cumulative YTDs, single-month
MTDs, and full-year FY estimates on one X-axis, with growth deltas
computed pairwise across them. Real prod screenshot showed 10 X labels
including duplicates (`2026 YTD`, `YTD 2026`, `YTD Total`,
`YTD Total (Jan-Apr 20, 2026)`, `FY26 Est`, `FY26 Est.`).

**Root cause:** `GrowthChart` in `deal-financials-charts.tsx` computed
`(period[N] − period[N−1]) / period[N−1]` between adjacent points
without filtering by period scope. Comparing a YTD cumulative ($6.7M)
to a single MTD ($950K) yields a meaningless ratio.

**Fix:** parse the period *label string* (the DB `periodType` column
only carries `ACTUAL/PROJECTED` — actual scope lives in the label). A
new helper `inferPeriodScope` regex-classifies labels into one of:
`annual / quarterly / monthly / ytd / mtd / ltm / estimate / other`.
Periods are grouped by scope and growth is computed only inside each
group, never across. Each group renders as its own Chart.js dataset
sharing the X-axis, with a per-scope colour (Banker Blue for Annual,
green for Monthly, amber for YTD, etc.). Legend appears when more than
one scope is present. Tooltip header now reads e.g. `Apr-26 · Monthly`
so the user sees which scope the comparison belongs to.

**Files:**
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-charts.tsx` (rewrote `GrowthChart`)
- `apps/web-next/src/app/(app)/deals/[id]/deal-financials-period-scope.ts` (new, 101 lines)

**Guards:** single period in a group → group dropped. Missing/empty
period label → bucketed to `"other"` rather than corrupting another.
`prev === 0 || prev == null || curr == null` → pair skipped (existing
check preserved). No usable pairs → empty-state message.

### B. Server-side period dedup + label normalisation

**Symptom:** the same logical period appearing as multiple
`FinancialStatement.period` rows for one deal — e.g. `FY26 Est` plus
`FY26 Est.` (trailing punctuation), `YTD 2026` plus `2026 YTD` plus
`YTD Total` plus `YTD Total (Jan-Apr 20, 2026)` — all collapsing to two
real concepts.

**Root cause:** the LLM (Claude Sonnet in `financialClassifier`) reads
spreadsheet column headers verbatim. No normalisation step before the
upsert.

**Fix:** new helper `normalizePeriodLabel(label)` applies these rules
in order:

1. Trim whitespace.
2. Strip trailing punctuation (`.`, `,`, `:`, `;`).
3. Collapse internal whitespace runs to one space.
4. `"FY<NN> Estimated"` / `"FY<NN> Est."` / `"fy26 est"` → `"FY<NN> Est"`.
5. `"YTD Total (… <YEAR> …)"` → `"YTD <YEAR>"`.
6. `"<YEAR> YTD"` → `"YTD <YEAR>"`.

`dedupePeriods` then merges by lowercased normalised label, bucketed by
`(statementType, periodType)` so a `PROJECTED` "FY26 Est" never collides
with a hypothetical `HISTORICAL` "FY26". Merge winner = highest
`confidence`; tie → most non-null fields; tie → first occurrence. The
loser fills holes in the winner's `lineItems` so we don't lose
information from the loser-row's columns.

Wired into `runDeepPass` in `financialExtractionOrchestrator.ts`, so it
catches every caller — `storeNode`, the vision-extract path, the manual
re-extract endpoint.

**Files:**
- `apps/api/src/services/financialPeriodNormalizer.ts` (new, 282 lines)
- `apps/api/src/services/financialExtractionOrchestrator.ts` (import + dedup call before the upsert loop)

**Logged:** info-level lines `Period dedup: <N> input → <M> output (dropped <N-M> duplicates)` per statement, plus a deal-level summary.

**Deliberately not normalised** (to avoid false-positive merges across
docs spanning multiple years): `"Q1 2026"` vs `"Q1-2026"` vs `"Q1'26"`,
`"Jan-26"` vs `"January 2026"`, `"YTD Total"` (no year) vs `"YTD 2026"`.

### C. Verify-node corrections atomic per statement

**Symptom:** the verify node's `applyCorrections` block was leaving
statements at mixed unit scales — neighbouring periods off by 1000×
because the LLM's per-field corrections only covered a subset of fields.
Combined with #A, this is what drove the `+14079.1%` chart spike. The
prod log showed `25 corrections applied` with `unitScaleIssue: "Source
appears to be in THOUSANDS but extraction assumed MILLIONS"` followed
by 12 EBITDA-margin warnings (95–98%) from the validator catching the
verifier's mess.

**Root cause:** `verifyNode.applyCorrections` overwrote
`(statement, period, field)` cells one by one. When the LLM emitted
unit-scale corrections for revenue/EBITDA/gross-profit but didn't think
to also correct operating-cf/capex/etc, those uncorrected fields stayed
at the wrong scale.

**Fix:** new helper `inferUniformMultiplier(corrections, statementType)`:

1. Collects `correctValue / extractedValue` ratios from numeric corrections.
2. Skips sign-flip corrections (negative ratio) and corrections on
   non-scalable fields (margins, percentages, ratios, headcount, counts,
   `_source` strings).
3. Snaps each ratio onto a known scale set:
   `[0.001, 0.01, 0.1, 1, 10, 100, 1_000, 1_000_000]` with 5% relative tolerance.
4. Picks the *mode* (not mean) — outliers from sign-error corrections
   shouldn't sway the multiplier.
5. Returns the multiplier only when (a) it covers ≥50% of snappable
   corrections AND (b) `result.unitScaleIssue` from the verifier is
   non-null. Otherwise returns null and the loop falls back to per-cell.

When a uniform multiplier is in play, every numeric line-item field on
every period of the affected statement gets multiplied — except cells
already touched by an explicit correction (those are at the verifier's
intended value already). Non-numeric fields (currency, dates, period
labels) and ratio/margin/count fields are skipped via
`isScalableNumericField`.

**File:** `apps/api/src/services/agents/financialAgent/nodes/verifyNode.ts`

**Tradeoff:** the previous code logged every individual correction as
its own agent step. The new code still logs each *explicit* correction
but emits an aggregate `Verify: applied uniform ×N multiplier across <K>
fields` step rather than spamming K lines when a 4-statement × 8-period
sweep happens. Intentional — keeps the agent-step trail readable.

---

## Already shipped (reverse chronological)

### Cross-verify node strips markdown fences before JSON.parse

**Symptom:** every prod extraction logged
`crossVerifyNode: JSON parse failure raw: ` ` ``` ` json …` — Claude Haiku
wrapped the verification array in a markdown code fence despite the
system prompt explicitly asking for raw JSON. The whole cross-verify
pass was silently skipped, losing the multi-model agreement check used
by `storeNode` for the cross-model confidence score.

**Fix:** strip leading ` ```json ` / ` ``` ` and trailing ` ``` ` before
`JSON.parse`. Same defensive strip pattern used in `memos-suggest.ts`.

**File:** `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts`

### .xlsx upload via data-room now runs full extraction

**Symptom:** uploading an .xlsx to an existing deal via the data-room
saved the bytes and the extracted text (markdown tables) but **never
ran any AI extraction**. Deal-level fields (company, industry, revenue,
EBITDA) didn't populate; the `FinancialStatement` table stayed empty;
the Financial Analysis tab showed nothing.

**Root cause:** `documents-upload.ts` had two extraction branches. The
PDF branch ran `extractDealDataFromText` after text extraction; the
Excel branch only called `excelToMarkdown` for RAG context and stopped
there.

**Fix:**

1. After `excelToMarkdown` succeeds, run `extractDealDataFromText` on
   the markdown — same pattern as the PDF branch. Sets
   `aiExtractedData`, which feeds `extractedDataToSave` /
   `Document.aiAnalysis` / the `autoUpdateDeal` merge path.
2. After the `Document` row is inserted, await
   `runDeepPass({text, dealId, documentId})` — populates the
   `FinancialStatement` table with per-period line items so the
   Financial Analysis tab shows real numbers.

Both calls awaited (Vercel can freeze the function once `res.json` is
sent — fire-and-forget would silently drop). Upload latency goes from
~1s to ~10–30s for a real financial model. Errors logged but never
fail the upload.

**File:** `apps/api/src/routes/documents-upload.ts`

---

## Open follow-ups (not in scope for this round)

- **Run the BILLIONS migration.** `apps/api/financial-statement-billions-migration.sql`
  must be applied to Supabase before any extraction returning
  `unitScale: BILLIONS` will succeed. Idempotent. Until then a CHECK
  violation will surface on insert.
- **Backfill old `MILLIONS`-tagged rows that were actually source-other.**
  Pre-honor-source-unit extractions are tagged `MILLIONS` regardless of
  source. They display correctly because storage + tag are consistent,
  but cross-doc compares against new ACTUALS-tagged extractions of the
  same deal will rely on the unit-aware `toMillions` normaliser. Worth
  a `re-extract all` script for historic deals.
- **Deal-level fields on the Deal table** (`deal.dealSize`,
  `deal.revenue`, `deal.ebitda`) still use the legacy `formatCurrency`
  helper which assumes "value is millions of currency". They don't
  carry a `unitScale` column. If we want them to honor source unit
  too, add `dealRevenueUnit` etc. or move them to the
  `formatFinancialValue` helper after Agent X-style work on
  `aiExtractor.ts` and `dealImportMapper.ts` (they're a separate
  pipeline from FinancialStatement extraction).
- **Encryption utility is dead code.** `apps/api/src/services/encryption.ts`
  implements AES-256-GCM but is never imported. Either wire it up or
  delete.
- **`runFinancialAgent` concurrency throttle (`acquireExtractionSlot`)
  is per-org;** uploads-then-extract via `documents-upload.ts` skips
  it (we call `runDeepPass` directly). If multiple users in one org
  upload Excel at the same time, both run their deep pass in parallel
  and could blow the function memory.
- **`detectUnitScale` per-sheet hint is computed by the Excel parser
  but not threaded through to the verify node.** If it were, the
  verify node could anchor on the parser's hint and avoid even
  *attempting* a unit correction on actual-dollar files. (Lower
  priority now that the verifier reads `unitScale` from each statement.)
- **Period-scope inference duplicated client + server.** Frontend
  `inferPeriodScope` (regex on labels) and server normalisation rules
  drift independently. Long-term they should share a canonical
  `periodScope` field on the `FinancialStatement` row, computed once
  on the server and consumed verbatim by the chart.
- **Validator percentage thresholds.** The `EBITDA margin > 80% — verify`
  rule in `financialValidator` flags small SaaS / IP-license businesses
  that legitimately run >95% margin. Worth raising the threshold or
  pairing with an absolute-revenue gate so we don't false-flag small
  startups.
- **Quarter / month label canonicalisation** (`Q1 2026` ↔ `Q1-2026` ↔
  `Q1'26`, `Jan-26` ↔ `January 2026`) is intentionally NOT in the
  current dedup helper because cross-doc merging has higher false-merge
  risk. Could be added later when conflict-detection moves into the
  same path.
