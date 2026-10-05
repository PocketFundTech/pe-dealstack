# Financial Extraction & Model — Investigation Notes

Companion to [`FINANCIALS-FIX-PLAN.md`](FINANCIALS-FIX-PLAN.md). The plan says **what** to do and in
which order; this file holds the **detail a developer needs to do it**: how each part works today,
the exact code paths, proposed designs, and the gotchas found while reading the code.

Investigated read-only on 2026-09-30 against production `main` @ `76ac195` (after PR #160).
Line numbers are from that commit — they drift, so search for the named function if a line has moved.
Paths: `A/` = `apps/api/src/`, `W/` = `apps/web-next/src/`.

Contents
1. [How extraction runs today](#1-how-extraction-runs-today)
2. [Periods: labels, ordering, YTD](#2-periods-labels-ordering-ytd) → Phase A
3. [EBITDA and other derived fields](#3-ebitda-and-other-derived-fields) → A3
4. [Choosing and merging source documents](#4-choosing-and-merging-source-documents) → Phase B
5. [Signs and statement checks](#5-signs-and-statement-checks) → B4
6. [P&L line items and table layout](#6-pl-line-items-and-table-layout) → Phase C
7. [Model builder](#7-model-builder) → Phases D, E
8. [Working in this codebase — checklist](#8-working-in-this-codebase--checklist)
9. [Open questions / not verified](#9-open-questions--not-verified)

---

## 1. How extraction runs today

**Engines.** Production runs the Claude engine: `EXTRACTION_ENGINE=claude`, `EXCEL_EXTRACTION_MODE=container`
(per `PROGRESS.md`; confirm with `vercel env ls production`). The legacy engine (`financialClassifier.ts`) still
exists and is the fallback / rollback path — fixes in shared code must keep both working.

**Entry points** that produce `FinancialStatement` rows:
- Deal "Extract financials" / "Re-extract" → `A/routes/financials-extraction.ts` (modes `single` and `all_financials`).
- Ingest background deep pass after "New deal" upload → `A/services/ingestDeepPass.ts`.
- Data-room upload post-processing → `A/routes/documents-upload.ts:484-491`.

**Pipeline (Claude engine):**
`agents/financialAgent/nodes/extractNode.ts` (cache lookup, then engine) →
`services/extraction/claudeEngine.ts` (PDF via Files API; Excel via container/code execution, text fallback) →
`services/extraction/normalize.ts` `toClassificationResult` (scale to MILLIONS, alias de-dupe) →
`nodes/storeNode.ts` → `services/financialExtractionOrchestrator.ts` `runDeepPass` (per-document period
de-dupe, cross-document conflict resolution, upsert).

**Storage.** `FinancialStatement` (`apps/api/financial-statement-migration.sql`): one row per
(deal, statementType, period, document); `lineItems` JSONB `{ key: number, key_source: "quote" }`;
`isActive` marks the row the UI shows; losing rows get `isActive=false`, `mergeStatus: needs_review`
(visible via `/financials/conflicts`). Unique key `(dealId, statementType, period, documentId)`
(`apps/api/financial-merge-migration.sql:25`).

**Cache.** `A/services/agents/financialAgent/extractionCache.ts`, keyed by content hash + engine + model +
`EXTRACTION_SCHEMA_VERSION` (added in PR #160). **Bump the version whenever a change alters what a stored
extraction means** (prompt, schema, scale/sign/derivation rules), or Re-extract will replay old results for 30 days.

---

## 2. Periods: labels, ordering, YTD

### Today
- **One label normaliser:** `normalizePeriodLabel` in `A/services/financialPeriodNormalizer.ts:98`, run only via
  `dedupeStatementPeriods` / `mergeStatementsBySameType` inside `runDeepPass` (`financialExtractionOrchestrator.ts:109,121`).
  Canonical forms are informal strings: `"2024"`, `"FY26 Est"`, `"YTD 2026"`, `"Q1 2026"`, `"H1 2026"`, `"Apr 2026"`, `"Apr 2026 LTM"`.
- **Every rule is end-anchored**, so a trailing parenthetical defeats all of them:
  FY rule `/^FY\s?(\d{2,4})$/i` (`:181`), YTD rules `/^(\d{4})\s+YTD$/i` (`:214`) and `/^YTD\s+(\d{4})$/i` (`:220`),
  month-year (`:291`). "FY2023 (Jan - Dec 2023)" and "2025 YTD (Jan - Sep 2025)" fall through to `return s` (`:353`) — stored verbatim.
- The Claude engine path copies `p.period` straight through (`A/services/extraction/normalize.ts:104-110`); the prompt only gives
  example labels (`extractionSchema.ts:85,146`) with no canonical-label rule.
- `periodType` is only `HISTORICAL | PROJECTED | LTM` (`financialClassifier.ts:13`, `extractionSchema.ts:44,86`, DB check in
  `financial-statement-migration.sql:19-20`). **No YTD / partial concept, no months-covered, no end date.**
- **Cross-document matching is exact-string** (`financialExtractionOrchestrator.ts:185`, `.eq('period', …)`), and label
  normalisation only happens within one document. So "FY2024 (Jan–Dec 2024)" (P&L) and "2024" (valuation summary) are two periods,
  both active, no conflict raised. Stored rows are never re-normalised on read.

### Where periods are sorted (four different ways)
| Consumer | Today | Effect |
|---|---|---|
| Analysis engine | `A/services/analysis/helpers.ts:64` — `Array.from(allPeriods).sort()` (plain string); `allPeriods` = union of IS+BS+CF labels (`:62-63`); keeps only `HISTORICAL` (`:54`) | `2021, 2024, 2025, 2025 YTD (…), FY2023 (…), FY2024 (…)` |
| Growth | `operationalAnalysis.ts:68-71` adjacent pairs in that order | FY2023 vs 2025 YTD → 21.0/29.0−1 = **−27.6%** |
| CAGR | `operationalAnalysis.ts:61-66`, `years = validRevs.length − 1` (count of periods) | 2021 → FY2024 over "3 years" ≈ **29.8%** |
| Consistency | `operationalAnalysis.ts:74-86` | growths [−27.68, +30.35], σ 29.02 → 40 − 15 = **25 "volatile"** |
| QoE flags | `qoeAnalysis.ts:26-46` (same pairs), margin flags `:73-120` (first vs last) | "Volatile revenue growth ±29.02pp" |
| Ratios + trend | `ratioAnalysis.ts:14` columns; `trendDirection` in `helpers.ts:33-46` = first-half avg vs second-half avg in that order; called `ratioAnalysis.ts:86,136,199` | Net margin arrow shows falling |
| Analysis route | `A/routes/financials-analysis.ts:50,86,172,237` `.order('period')` (text) | re-sorted anyway by `prepareData` |
| Web tables/charts | `comparePeriodChronologically` — API `A/utils/periodChrono.ts:98`, **hand-copied** to `W/app/(app)/deals/[id]/deal-financials-period-scope.ts:133` ("keep in sync" comment) | Order roughly right, but `inferPeriodScope("FY2023 (Jan - Dec 2023)")` misses the annual regex (`period-scope.ts:65`) and matches "JAN" → classified **monthly**; same bug in `periodChrono.ts:58-61` (used by `financialValidator.ts:434`) |
| Web "annual" filter | `W/…/deal-financials.tsx:376` `/^FY\b/` | doesn't match "FY2023 (…)" |
| Web deep dive | `deal-analysis-deepdive.tsx:89,99,105`, overview chips `deal-analysis-overview.tsx:45` | render in API order, no sort |
| Model | `A/routes/deals-model.ts:100` SQL order, then `assumptions.ts:138` chronological | 2021 → FY2023 → FY2024 → 2025 YTD (FY rows mis-scoped as monthly) |
| Chat agents | `periodSortKey` in `agents/globalChatAgent/tools/getDealFinancials.ts:25` and `agents/dealChatAgent/tools/getDealFinancials.ts:44` — return 0 for parentheticals/YTD | unordered |
| Reconciler | `A/services/reconciler/shared.ts:270` `parsePeriodToYearMonth` | its own rules |

### Proposed design (A1, A4)
```ts
// packages/shared (imported by API and web — delete the hand-copied web version)
type PeriodKind = 'FY' | 'YTD' | 'LTM' | 'Q' | 'H' | 'M' | 'EST';
interface CanonicalPeriod {
  label: string;          // original label, for display
  kind: PeriodKind;
  fiscalYear: number;
  months: number;         // 12 for FY/LTM, 9 for "Jan - Sep", 3 for a quarter…
  endDate: string;        // ISO yyyy-mm-dd (end of last month covered)
  canonicalKey: string;   // "2023", "YTD 2025", "LTM Sep 2025", "Q1 2026", "2026E"
}
parsePeriod(label: string): CanonicalPeriod | null
comparePeriods(a, b): number   // by endDate, then kind order M < Q < H < YTD < LTM < FY < EST
```
- Read trailing ranges first: `(Jan - Dec 2023)` → 12 months → FY 2023; `(Jan - Sep 2025)` with "YTD" or a < 12-month span → YTD 2025, months 9.
  Handle fiscal years that don't start in January (`(Apr 2024 - Mar 2025)` → FY2025, months 12).
- Use it: `prepareData` sorts with `comparePeriods` and **groups by `canonicalKey`**; stop taking the IS+BS+CF union for income-statement series.
- A4 (migration): `FinancialStatement` gets `periodKey`, `periodKind`, `periodMonths`, `periodEndDate`; conflict lookup matches on `periodKey`;
  a bare "2025" that clashes with "YTD 2025" is raised as a conflict, not a separate period. Backfill via a script modelled on
  `apps/api/scripts/dedup-existing-statements.ts`. Add a canonical-label rule to the Claude prompt.

### YTD handling (A2, D1)
- No annualisation, exclusion or partial check exists anywhere in analysis or the model (only the reconciler's 3-month ARR logic).
- Growth, CAGR, consistency, trends: **FY periods only**; CAGR over the real year span (`endDate` difference).
- YTD shown separately: "YTD vs prior-year YTD" when both exist; else "annualised run-rate (estimate) = value × 12 / months"
  (SRM: 29.0 × 12/9 = 38.7 → ~+41% vs FY2024 — matches the analyst's ~40%). Margins on YTD are fine as ratios but tag them / exclude from `trendDirection`.

---

## 3. EBITDA and other derived fields

- `computeDerivedFields` (`A/services/financialClassifier.ts:743-776`, called only at `:304`) derives gross profit, then EBITDA from
  EBIT + D&A → revenue − COGS − total OpEx → GP − total OpEx, plus EBIT and margins. **Legacy engine only.**
- `A/services/parsers/accountingParser.ts:312-320` derives EBITDA = net income + D&A + interest + tax, but only on that parser's path.
- The Claude engine derives nothing (`normalize.ts`, `claudeEngine.ts`, `storeNode` — no call); its prompt says "report values exactly as printed".
- Consumers read only `ebitda`: ratios `A/services/analysis/ratioAnalysis.ts:34-38` (QoE falls back to `ebitda_margin_pct` at `qoeAnalysis.ts:78`,
  ratios don't), model `A/services/dealModel/assumptions.ts:124-127`, display routes `deals-financials-timeseries.ts:79`, `financials.ts:155`,
  `deals-financial-summaries.ts:152`, validator `financialValidator.ts:305`. Note `operating_income` is aliased to `ebit` (`financialSchema.ts:89`).

**Fix (A3):** move `computeDerivedFields` to a shared module (e.g. `A/services/financialDerivations.ts`), call it from both
`financialClassifier.ts` and `extraction/normalize.ts` (income statements, after alias de-dupe). Cascade:
1. `ebit + da` 2. `gross_profit − total_opex` (or − (sga + rd + other_opex)) 3. `net_income + interest_expense + tax + da` (QuickBooks-style statements).
Also derive `ebit`, `ebt`, `total_opex`, margins where possible. Write `ebitda_source: "derived: <formula>"` so the UI can mark it and
cross-verify (`storeNode.ts:358-384`) doesn't flag it. **Signs matter:** these formulas assume costs are positive (see §5). Bump the schema version.

---

## 4. Choosing and merging source documents

### Today
- **Which documents:** `all_financials` (`A/routes/financials-extraction.ts:183-210`) takes every doc passing `isFinancialDoc`
  (`financials-extraction-utils.ts:98-121`) — any `.xlsx`/`.csv`/spreadsheet — newest first. No ranking, no exclusion.
- **Parallel with skips:** `Promise.allSettled(docs.map(withDocTimeout))` (`:359`); each doc downloads first, then asks for a slot
  (`processOneDoc`, `:116-118`); `MAX_CONCURRENT_PER_ORG = 2` (`agents/financialAgent/concurrency.ts:7`). With ~15 docs, 2 run and the rest
  return `skipped_no_slot`. The two that win are the fastest downloads (smallest files). 240 s per doc (`:313`) and per agent run
  (`financialAgent/index.ts:41`) — big multi-tab workbooks can time out.
- **Ingest / data-room** use the same 2-slot check and skip rather than queue (`ingestDeepPass.ts:36-41`, `documents-upload.ts:484-491`).
- **Merge:** `runDeepPass` looks up an existing active row by exact period (`financialExtractionOrchestrator.ts:185`); if another document
  holds it, `financialSourceAuthorityRank` decides (`A/services/financialSourceAuthority.ts:36-58`): spreadsheet file types / FINANCIALS/EXCEL = 3,
  narrative docs = 2, else 1. LBO workbook and valuation summary are **both 3 → tie → existing row stays active** (`:199-228`); the newcomer is
  stored inactive / `needs_review` (`:248-249`). So the first writer wins. Check-then-upsert is not atomic across parallel docs.
- No notion anywhere of primary statement vs derived model (grep for valuation/primary/model in extraction, authority and reconciler code: nothing).

### Excel sheet selection
- **Legacy / text path** `A/services/excelFinancialExtractor.ts`: `scoreSheet` (`:64-85`) with patterns (`:38-55`): cash flow / balance sheet /
  income statement / profit and loss = 100, `p&l` = 95, LBO = 75, summary/model = 50; `bs|cf|pl|is|cfs` = 70 **only as the whole name**
  (`/^(bs|cf|pl|is|cfs)$/`, `:79`) → **"CFS Source" / "BS Source" score the minimum 10** (`:82`). No sheet cap (`:269-279`); per-sheet
  classifier calls, 3 in parallel (`extractNode.ts:273`); sheets > 120K chars chunked, capped at `MAX_CHUNKS=4` (`extractNode.ts:293`,
  `config.ts:16`) — silently truncated beyond that.
- **Claude container path** (`claudeEngine.ts:205-231`): the whole file is uploaded and the model is told to "list every sheet"
  (`extractionSchema.ts:171`), so it can see all tabs — but the instruction (`:173`) only separates statements from "assumptions, schedules,
  or other content"; it never says to prefer reported statements over valuation/analysis tabs. On `max_tokens` or container failure it falls back
  to text mode (`claudeEngine.ts:182, 315-321`).

### Fix (B1–B3)
- **Rank:** add a "derived model" tier below source statements; signals: file name (valuation, summary, returns, DCF, sensitivity, model output)
  **and** what the extractor saw — have the container prompt return per statement `sourceKind: 'source_statement' | 'model_derived'` and the
  `sheetName`; store both on the row. Tie-break by `sourceKind`, then completeness (line-item count, presence of totals), never by write order.
- **Prompt:** prefer tabs holding the company's reported historical statements (names like "*Source*", "Historical", "Actuals"); extract every
  balance-sheet and cash-flow line from them; never take BS/CF from valuation or analysis tabs; report the sheet name.
- **Scoring:** `\bcfs\b`, `\bbs\b`, `\bis\b`, `\bpl\b` as words; bonus for source/historical/actuals; lower valuation/returns/sensitivity/summary.
- **Queue, don't skip:** replace `Promise.allSettled` + `skipped_no_slot` with a bounded queue (`mapWithConcurrencyLimit` in
  `A/utils/limitConcurrency`), ordered source statements first, derived models last; same for ingest and data-room. Make the
  conflict check + upsert atomic per (deal, statement, periodKey) — an RPC or advisory lock.

---

## 5. Signs and statement checks

- **No sign normalisation anywhere** for `debt_repayment`, `dividends`, distributions or `capex`: prompt says "exactly as printed"
  (`extractionSchema.ts:138`); `normalize.ts:70-88` only scales; `financialSchema.ts:57-69` checks types only.
- The only cash-flow validator check uses `Math.abs(capex)` (`financialValidator.ts:390-392`) — sign errors never trigger repair.
- Legacy prompt treats capex as positive ("operating_cf − capex = fcf"; `capex_maintenance` / `capex_growth` examples,
  `extractionPrompt.ts:221-227, 246`) — that's where "Growth / Maintenance capex" sub-lines come from.
- The Claude path skips the self-correct loop (`graph.ts:42`); only legacy verify mentions signs (`nodes/verifyNode.ts:182`).
- "Owner distributions" isn't a standard key, so it's stored exactly as returned (+1.3M from the valuation model).
- Balance sheet: no allow-list or minimum — `financialSchema.ts:37-54` is `.passthrough()`, `validateLineItems` keeps unknown keys
  (`:113-150`). The 4 lines were all the valuation summary had. No completeness check. `total_debt` is aliased to `long_term_debt`
  (`financialSchema.ts:97`) — mislabels total debt.

**Fix (B4):** deterministic sign pass in `extraction/normalize.ts` and legacy `normalizeClassificationResult` for CASH_FLOW — outflow keys
(`capex*`, `debt_repayment`, `dividends`, `*distribution*`, `acquisitions`) ≤ 0; prompt rule "cash outflows negative"; stop treating capex as
positive in the legacy prompt. Error-level validator checks (they trigger the repair pass): CFO + CFI + CFF ≈ `net_change_cash`; balance sheet
has totals and assets ≈ liabilities + equity. Give `total_debt` its own key.

---

## 6. P&L line items and table layout

### Today
- Standard keys: `A/services/financialSchema.ts:14-69` (zod `.passthrough()` — unknown keys kept, unchecked). Income statement: revenue, cogs,
  gross_profit, gross_margin_pct, sga, rd, other_opex, total_opex, ebitda, ebitda_margin_pct, da, ebit, interest_expense, ebt, tax, net_income, sde
  (+ aliases `depreciation`, `tax_expense`).
- Live prompt (`extractionSchema.ts:139-143`): "Anything material that doesn't match gets a descriptive snake_case name"; `name` is a free string
  (`:93`) with **no parent field**. The `<parent_canonical_key>_<short_label>` rule (`cogs_cement`, `revenue_discounts`) exists **only** in the legacy
  prompt `A/services/extractionPrompt.ts:185-196`. Result: flat names `sand_cos`, `cement_cos`, `fly_ash_cos`, `discounts`, `gross_sales`.
- `normalize.ts:76` only lowercases/underscores. Alias side effect: `sales` is an alias of `revenue` (`financialSchema.ts:88`); if both appear,
  `dropDuplicateAliases` (`normalize.ts:57-68`) deletes the `sales` row.
- **Web table** (Full View: `fullscreen-modal.tsx:159` → `FinancialStatementsPanel` → `FinancialTable`, `deal-financials.tsx:513`,
  `deal-financials-table.tsx:244`): one `ORDERED_LINE_ITEMS` list for **all three** statements (`deal-financials-constants.ts:46-58`: IS keys,
  then BS keys incl. `goodwill`, then CF). `buildDisplayRows` (`deal-financials-table.tsx:143-189`) walks it, attaches children by longest
  standard-key prefix (`findCanonicalParent`, `:95-119`, children alphabetical `:160`), then appends **every unmatched key at the end** (`:181-187`)
  in `Object.keys` order — which is Postgres JSONB order (shortest key first, then bytes): sand_cos, bad_debts/discounts, cement_cos, fly_ash_cos/gross_sales,
  total_insurance, large_gravel_cos/net_other_income — exactly what the team saw.
- "Goodwill" in the P&L: the only prefixed key is likely `goodwill_amortization_754`, whose parent resolves to `goodwill` (a BS key);
  `applyHideEmpty` shows a parent with no own value if it has a visible child (`:233-237`).
- Labels: unparented rows → `LINE_ITEM_LABELS[k] ?? k.replace(/_/g," ")` title-cased (`:184`) → "Sand Cos". The source label is never stored.
  `labelForChild` (`:122-129`) upper-cases any segment ≤ 3 chars → latent "Fly ASH", "NET FEE". `depreciation` / `tax_expense` have labels
  (`deal-financials-constants.ts:22`) but aren't in the order list.
- Signs: contra-revenue (Discounts −$12.6K, Refunds −$347.6K) shown as printed; costs stored positive; `formatFinancialValue`
  (`W/lib/formatters.ts:219`) just prefixes "−".

### Fix (C1, C2)
- Extraction: nullable `parent` per line item in `EXTRACTION_JSON_SCHEMA` (restricted to standard parent keys); store source label and row order
  (`lineItemMeta: { key: { parent, label, order } }` or `<key>_label` / `<key>_order`); add `other_income` / `other_expense` (between EBIT and EBT);
  sign convention (revenue +, contra-revenue −, costs/D&A/interest/tax +, other income +); validator warns when children ≠ parent. Minimum stopgap:
  port the legacy DYNAMIC SUB-CATEGORIES block into `buildExtractionSystemPrompt`. Bump the schema version.
- Web: replace `ORDERED_LINE_ITEMS` with `STATEMENT_LAYOUT: Record<StatementType, Section[]>` in a new `deal-financials-layout.ts`
  (keep files < 500 lines). Income statement:

  | # | Section | Parent key | Children (collapsible) |
  |---|---|---|---|
  | 1 | Revenue | `revenue` (Total Income) | gross sales, sales, services, shipping income; contra: discounts, refunds, returned fees |
  | 2 | Cost of Goods Sold | `cogs` | labour, equipment rental, freight, cement, fly ash, sand, gravel, additives… |
  | 3 | **Gross Profit** / GM% | `gross_profit`, `gross_margin_pct` | — |
  | 4 | Operating Expenses | `total_opex` (sub-parents `sga`, `rd`, `other_opex`) | insurance, bad debts, rent… |
  | 5 | **EBITDA** / margin | `ebitda` (reported or derived) | — |
  | 6 | D&A | `da` | depreciation, amortisation (goodwill amortisation belongs here) |
  | 7 | **EBIT** | `ebit` | — |
  | 8 | Interest / other | `interest_expense`, `other_income` | net other income… |
  | 9 | **EBT** | `ebt` | — |
  | 10 | Taxes | `tax` | — |
  | 11 | **Net Income** | `net_income` | — |
  | 12 | Memo: SDE | `sde` | — |

  Only keys in the statement's layout render as sections; BS/CF keys never appear on the P&L; leftovers go in one collapsed
  "Unclassified accounts" group. Parent lookup: backend `parent` → prefix → stopgap keyword rules (`_cos|_cost|cost_of` → cogs;
  `discount|refund|allowance|return` → revenue; `other_income|interest_income` → other_income; `amortization|depreciation` → da).
  Collapsible sections (local `Set<string>` state); "derived" marker; accounting-style negatives; only upper-case a known acronym list.

---

## 7. Model builder

### Map
- **Routes** `A/routes/deals-model.ts` (lite bundle `app-lite.ts:348`): `GET /api/deals/:dealId/model` (`:147`) saved or `deriveDefaults()`
  assumptions + history; `PUT` (`:177`) upserts `DealModel` with name hard-coded `'Base case'` (`DEFAULT_CASE`, `:33, :194`);
  `POST …/model/export` (`:212`) merges unsaved panel edits (`:239`) → `buildModelWorkbook()` (`:242`), 400 `NO_FINANCIALS` if no history (`:224`).
  `loadModelInputs` (`:86-124`) reads `Deal` (dealSize, ebitda, currency), active `FinancialStatement` rows, CIM/FINANCIALS doc names;
  `impliedEvMultiple = dealSize / ebitda` (`:52-57`).
- **Service** `A/services/dealModel/assumptions.ts`: `normaliseStatements` (`:81-141`) keeps only non-projected INCOME_STATEMENT rows
  (**BS and CF discarded**, `:82-87`), reads only revenue, cogs, gross_profit (derived rev − cogs), total_opex (read, never written),
  ebitda (**no fallback**, `:127`), net_income, D&A; sorts chronologically (`:138`). `assumptionsSchema` (`:149-176`); `deriveDefaults`
  (`:203-256`): growth = revenue CAGR over the **count of periods** clamped −15..30; margin = latest ebitda/revenue else 15; entry multiple =
  deal-implied else 5; fees 2%, debt 2.5×, interest 10%, amort 5%, sweep 50%, capex 3%, NWC 10%, tax 25%, D&A 3%, exit = entry, WACC 12%.
- **Workbook** `A/services/dealModel/workbook.ts` (exceljs): Cover, Assumptions, Historicals, Projections, Returns, Sensitivity, Notes
  (`:21, :605-624`). Fixed cell maps `ASSUMPTION_CELLS` (`:63-83`, hand-maintained, "lockstep" comment `:58-83`) and `PL_ROWS` (`:208-218`).
  Writers: `writeHistoricals` `:220`, `writeProjections` `:273`, `writeReturns` `:377` (row map `R` `:350`), `writeSensitivity` `:537`.
- **Web** `W/app/(app)/deals/[id]/deal-model-panel.tsx` (mounted `deal-page-left-panel.tsx:158`): GET on load `:112`, PUT on save `:165`,
  POST export with current assumptions `:178`. Live preview (`:139-159`) needs history EBITDA and grows EBITDA by revenue growth (ignores
  margin) — doesn't match the workbook. `setSeries` (`:135`) writes one growth/margin to every year (wipes per-year edits).
- **Formulas:** Projections, margins, Returns, debt schedule, IRR/MoM, DCF, Sensitivity are live formulas off blue Assumptions inputs.
  Historicals and the base column (Projections B4 revenue, B7 EBITDA) are static values. No cached results and no `fullCalcOnLoad` —
  non-Excel previewers may show blanks.

### Root causes of what the team saw
| Symptom | Cause |
|---|---|
| EBITDA blank in Historicals | no `ebitda` key and no fallback (`assumptions.ts:127`); Claude path never derives (§3) |
| EBITDA margin 0.0% everywhere | `IF(rev=0,"",ebitda/rev)` treats blank as 0 (`workbook.ts:265`) → use `IF(OR(rev=0,ISBLANK(ebitda)),"",…)` |
| Entry EBITDA / EV / fees / debt / equity all 0 | Entry "LTM" = `Projections!B7` (`:389`) = `lastActual?.ebitda ?? 0` (`:300`); `lastActual = history.at(-1)` (`:287`) = **2025 YTD** (no EBITDA) → EV (`:393`), fees (`:397`), debt (`:401`), equity (`:405`) all × 0. Multiples/leverage themselves are fine. `entryBasis: 'REVENUE'` and `debtQuantumMode: 'ABSOLUTE'` exist in the schema but workbook.ts never reads them. |
| IRR "n/a", MoM blank, DCF premium blank | cash flows [−0, 0, …, 84.2] → no sign change → IRR #NUM → `IFERROR` "n/a" (`:506`); MoM `IF(B8=0,"")` (`:511`); DCF premium `IF(B5=0,"")` (`:532`) |
| "2021" column (revenue only) | every active non-projected IS row kept, no coverage filter (`:82-87`); also skews `deriveDefaults` CAGR (2021 → 2025 YTD over row count, spanning missing 2022, 9-month end) |
| YTD used as a full year | `lastActual = history.at(-1)`; "2025 YTD" sorts last → base column labelled with "A" (`:290`); Y1 = 29.0 × (1+g) |
| First projection column EBITDA 0 | only revenue and EBITDA written to the base column (`:296-301`); COGS/GP/D&A/EBIT/FCF never written; Projections rows 5–6 empty |
| Row 10 mismatch | row 10 = "Net income" on Historicals but "Unlevered FCF" on Projections (`:305` reuses `PL_ROWS.netIncome`) |
| Notes wrong | Notes (`:590`) say "cash sweeps are not modelled" — a sweep is modelled (`:438`) |
| Column headers truncated | column width 14 (`:221`) |

### Build-out (E1–E3)
- **E1 every P&L line (L):** replace `HistoricalRow` with `lines: Record<canonicalKey, number>` from a line catalogue (standard vocabulary,
  `extractionSchema.ts:140`); add `lineDrivers: Record<key, { method: 'PCT_REVENUE' | 'GROWTH' | 'FIXED' | 'SUBTOTAL', values: number[] }>` to
  `assumptionsSchema`, seeded from historical averages in `deriveDefaults`; `ebitdaMarginPct` becomes an output or override. Workbook: generated row
  registry replaces `PL_ROWS` / `ASSUMPTION_CELLS`; driver block per line on Assumptions; subtotals as formulas on Projections **and** Historicals.
  Update `apps/api/tests/deal-model-workbook.test.ts` (asserts fixed addresses, e.g. "no dead assumption cells" `:182`) and the route's
  `coherentAssumptions` refinements (`deals-model.ts:64-76`). Panel: per-line driver table; replace `setSeries`.
- **E2 scenarios (M):** `DealModel` already has `name` + `UNIQUE("dealId", name)` (`apps/api/deal-model-migration.sql:18-26`) — only the
  hard-coded `DEFAULT_CASE` blocks it. API: `?case=` / `name` on GET/PUT, `GET /model/cases`, export loads all cases (or seeds High/Low from Base
  ± deltas on growth, margin, exit multiple). Workbook: Low/Base/High columns per driver + blue "Active case" cell (data validation) + "Live"
  column via `CHOOSE`/`INDEX`; repoint references at Live (cheap once E1's generated map exists). Per-case IRR/MoM summary needs duplicated
  compact blocks (Excel data tables via exceljs — support unverified). UI: case tabs, save per case.
  `A/services/analysis/debtAndLBO.ts:46+` has a 12-scenario LBO screen (server-side grid, not reusable workbook logic).
- **E3 BS/CF-driven (L):** stop discarding BS/CF in `normaliseStatements` (`:84`); AR / inventory / AP → DSO/DIO/DPO or % revenue; capex and
  PP&E from historical cash flows; opening net debt (cash, ST+LT debt) into sources & uses. Replace scalar `nwcPctRevenue` /
  `capexPctRevenue` (`assumptions.ts:164-165`; FCF formula `workbook.ts:332-337`) with per-year schedules. Debt (`workbook.ts:408-462`) is one
  tranche and the sweep uses **unlevered** FCF (`:439`) — add tranches, interest on average balance, levered FCF after interest and tax, cash
  balance. Integrated balance sheet with a balance check is L+.
- **Prerequisites (S each):** EBITDA derivation (A3); entry-period selection (D1); entry EBITDA fallback to `Deal.ebitda`; honour
  `entryBasis` / `debtQuantumMode`; `wb.calcProperties.fullCalcOnLoad = true`; fix the row-10 label; panel preview = margin × revenue.

---

## 8. Working in this codebase — checklist

- **Branch per phase, PR into `main`**, conventional commits (`fix(financials): …`, `feat(model): …`). Update `PROGRESS.md` with an IST-timestamped
  entry per PR, and tick the box in `FINANCIALS-FIX-PLAN.md`.
- **Tests first.** API: `cd apps/api && npx vitest run && npx tsc --noEmit -p .`. Web: `cd apps/web-next && npx vitest run && npx tsc --noEmit -p .`
  (ignore only the `../../../api/dist/app-*.js` errors when the API isn't built) and `npx eslint src` (0 errors). Relevant existing tests:
  `extraction-normalize.test.ts`, `financial-extraction-cache.test.ts`, `extract-node-engine-flag.test.ts`, `financial-agent-graph-claude.test.ts`,
  `deal-model-workbook.test.ts`, analysis tests under `apps/api/tests`, `deal-financials*` tests in web-next.
  Vitest 4 gotcha: a throwing `vi.fn` inside a module loaded via `await import()` in the route can fail the test even when the route catches it —
  use plain functions for those mocks.
- **Bump `EXTRACTION_SCHEMA_VERSION`** (`A/services/extraction/extractionSchema.ts`) with any prompt/schema/scale/sign/derivation change.
- **Both engines.** Shared normalisation/derivation code must be called from the legacy classifier and the Claude path.
- **Prompts:** keep the current-date injection (`getTodayIso()`) and prompt caching (`cache_control`) intact — see `CLAUDE.md`.
- **Serverless bundle parity:** a new API route must be mounted in `app-lite.ts` / `app-ai.ts` and routed in `W/lib/api-routing.ts` `pickBundle`,
  or it 404s only in production.
- **Migrations are manual:** Vercel doesn't run `apps/api/*.sql`. Add the SQL file, list it in `docs/PENDING-MIGRATIONS.md` and
  `docs/PENDING-OPS-CHECKLIST.md`, and make the code work before **and** after it runs. A feature isn't done until the founder has run it.
- **File size:** keep files under 500 lines (web-next rule) — split layout/helpers into their own modules.
- **Don't change `package-lock.json`** unless adding a dependency on purpose (the Vercel install deletes and regenerates it).
- **Existing data:** fixes don't repair stored rows. After each extraction phase ships, affected deals need **Re-extract Financials**
  (the schema-version bump makes that recompute).

---

## 9. Open questions / not verified

Needs a production data check (founder SQL — see plan V1) or a decision:
- For SRM: were the LBO workbook's rows extracted and lost the tie (inactive, `needs_review`), or never extracted (`skipped_no_slot` / timeout)?
  The exact stored line-item keys and signs; whether `sales` was dropped as an alias; whether FY2024 net income −$119.6K matches the source.
- Production `EXTRACTION_ENGINE` / `EXCEL_EXTRACTION_MODE` values (docs say claude / container).
- Whether the model's 20% Y1 growth and 15.5% margin were saved assumptions (defaults would give ~30% clamped and 15%).
- Whether `Deal.ebitda` is set for SRM (exit EV 84.2 / 11.2 ≈ 7.5× suggests yes).
- exceljs support for Excel data tables (`TABLE()`), for per-scenario summaries.
- Using the SRM files as a regression fixture needs the team's OK — they are a real company's financials.
