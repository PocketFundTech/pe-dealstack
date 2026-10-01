# Financial Extraction & Model — Fix Plan

Source: the team's test of a real deal, **Strong Ready Mix, Ltd.** (USD, ~15 financial documents:
a QuickBooks P&L Jan 2023 – Sep 2025, an LBO workbook with "CFS Source" tabs, and a derived
`SRM_Valuation_Summary.xlsx`). Investigated 2026-09-30 against production `main` (76ac195, after
PR #160). **No code has been changed yet.** Paths: `A/` = `apps/api/src/`, `W/` = `apps/web-next/src/`.

**Developers:** start with [`FINANCIALS-INVESTIGATION-NOTES.md`](FINANCIALS-INVESTIGATION-NOTES.md) — how each part works today,
exact code paths, proposed designs, and the working checklist (§8). Tick boxes here as PRs merge.

---

## What the team saw → why it happens

| # | What the team saw | Root cause (verified in code) |
|---|---|---|
| 1 | P&L numbers right, but the table is a confusing flat list: raw accounts ("Sand Cos", "Fly Ash Cos", "Discounts") after Net Income in no order; "Goodwill" in the P&L; EBITDA missing | (a) The live Claude extraction prompt never asks for a parent line, so raw accounts get flat names (`sand_cos`) the UI can't nest — the `<parent>_<label>` rule exists only in the old prompt (`A/services/extractionPrompt.ts:185-196`). (b) The web table uses **one** row order for all three statements (`W/app/(app)/deals/[id]/deal-financials-constants.ts:46-58`) and appends every unknown key after Net Income in Postgres JSONB key order (shortest name first) (`deal-financials-table.tsx:143-189`). A `goodwill_amortization_754` expense pulls a "Goodwill" (balance-sheet) parent into the P&L. (c) EBITDA is never derived on the live Claude path (see #6). |
| 2 | Balance sheet shows only 4 lines, "Source: SRM_Valuation_Summary.xlsx" | The valuation summary, not the real statements, became the active source (see #3). Nothing drops lines — the summary only had 4. No completeness check flags a balance sheet without totals. |
| 3 | Cash flow totals right, but 2025 debt repayment −$930K (real −$1.30M), 2024 owner distributions +$1.3M (should be −$1.27M), capex split is the valuation model's own analysis | **Nothing distinguishes a real statement from a derived model.** Every `.xlsx` gets the same authority rank (`A/services/financialSourceAuthority.ts:36-58`); on a tie the **first document to write a period wins** (`A/services/financialExtractionOrchestrator.ts:185-249`). "Extract all" runs docs in parallel under a 2-per-org slot limit and **skips** the rest instead of queueing (`A/routes/financials-extraction.ts:116-118, 359`; `concurrency.ts:7`) — small files like the valuation summary finish first. The Excel sheet scorer gives "CFS Source" / "BS Source" the minimum score (`A/services/excelFinancialExtractor.ts:79-82`), and the Claude prompt never says "prefer the reported statements over valuation/analysis tabs" (`A/services/extraction/extractionSchema.ts:173`). **No sign normalisation** for outflows anywhere (`extraction/normalize.ts:70-88` only scales). |
| 4 | Build model only uses headline figures; EBITDA blank, margin 0%; entry EBITDA / EV / debt / equity all 0; IRR "n/a"; no high/base/low | Model reads only revenue, COGS, GP, EBITDA, D&A, NI from income statements; balance sheet and cash flow are discarded (`A/services/dealModel/assumptions.ts:81-141`). EBITDA has no fallback (`:127`). The entry period is simply the last column — here **2025 YTD (9 months)**, which has no EBITDA → entry EBITDA 0 → EV, fees, debt, equity 0 → IRR has no sign change → "n/a" (`A/services/dealModel/workbook.ts:287-300, 389-405, 506`). YTD is also used as a full base year for projections. Margin formula treats blank EBITDA as 0 (`workbook.ts:265`). Schema fields `entryBasis` / `debtQuantumMode` are ignored. Scenarios are half-built: the `DealModel` table already supports named cases (`deal-model-migration.sql:18-26`) but the route hard-codes "Base case" (`A/routes/deals-model.ts:33`). |
| 5 | AI analysis wrong: false −27.68% drop in 2023, 29.79% CAGR, "volatile revenue", skipped 2025's ~40% growth | **Periods are sorted as plain strings** (`A/services/analysis/helpers.ts:64`): `2021, 2024, 2025, 2025 YTD (…), FY2023 (…), FY2024 (…)` — so FY2023 was compared to 2025 YTD. CAGR divides by the number of periods, not years (`operationalAnalysis.ts:61-66`). The period normaliser gives up on labels with a trailing "(Jan - Dec 2023)" (`A/services/financialPeriodNormalizer.ts:179-220`, all rules end-anchored), so "FY2024 (Jan–Dec 2024)" and "2024" (from the valuation file) are two separate periods. No YTD/partial-period concept exists (`periodType` = HISTORICAL/PROJECTED/LTM only). |
| 6 | Ratios: numbers right but columns in the wrong order, so the trend arrow shows profits falling; EBITDA margin and all liquidity/leverage/return ratios missing | Same string sort feeds the ratios and `trendDirection` (`A/services/analysis/ratioAnalysis.ts:14`, `helpers.ts:33-46`). EBITDA is only read if printed — derivation (`computeDerivedFields`, `A/services/financialClassifier.ts:743-776`) runs only on the **legacy** engine, never on the live Claude path (`A/services/extraction/normalize.ts`). Liquidity/leverage/returns are blank because the balance sheet came from the 4-line valuation summary (#2/#3). |
| 7 | Analysis misses the real issues: one customer at 39% of revenue (also a part-owner), negative FCF in both years, equipment spending funded with loans | The analysis engine only computes from extracted statement numbers; it doesn't read the CIM/notes for concentration or related parties, and FCF/funding can't be right while the cash flow comes from the wrong file. |

---

## To-do — in recommended order

> **Status 2026-10-01:** every item below has an open PR. Merge order: **#163 → #164 → #165 → #166 / #167 → #168**.
> After merging: run #164's migration + backfill (founder), then **Re-extract** the SRM deal (with the team's OK) and have Pushkar re-test.
> Tick each box when its PR is merged.

Sizes: **S** ≤ ½ day · **M** 1–2 days · **L** 3–5 days. "Mig" = needs a Supabase migration (founder runs it).

### Phase A — Stop showing wrong analysis (fastest client-visible win)

- [ ] **A1 · One period model, one ordering (M)** → **PR #163**
  - Add a shared `parsePeriod(label)` → `{ fiscalYear, months, kind: FY|YTD|LTM|Q|H|M|EST, endDate, canonicalKey }` in `packages/shared`, reading trailing ranges: "FY2023 (Jan - Dec 2023)" → FY 2023 (12 months, key `2023`); "2025 YTD (Jan - Sep 2025)" → YTD 2025 (9 months).
  - Add one `comparePeriods(a, b)` (by end date, then kind) and use it everywhere: analysis `prepareData` (`helpers.ts:64`), ratios, the web tables/charts (delete the hand-copied `W/…/deal-financials-period-scope.ts:133`), the model builder, and both chat agents' `getDealFinancials` sort helpers.
  - Fix `inferPeriodScope` so "FY2023 (Jan - Dec 2023)" is annual, not "monthly" (matches "JAN" today).
  - Done when: SRM periods order 2021 → FY2023 → FY2024 → 2025 YTD everywhere, and "FY2024 (Jan–Dec 2024)" and "2024" are recognised as the same year.
- [ ] **A2 · Growth, CAGR and consistency use full years only (S)** → **PR #163** — `A/services/analysis/operationalAnalysis.ts`, `qoeAnalysis.ts`
  - Growth/CAGR/consistency/QoE flags on FY periods only; CAGR over the real year span.
  - Show YTD separately: "YTD vs prior-year YTD" when both exist, else "annualised run-rate (estimate)" = value × 12/months (SRM: 29.0 × 12/9 = 38.7 → ~+41% vs FY2024).
  - Done when: SRM shows FY2023 → FY2024 +30%, 2025 run-rate ~+41% (marked as estimate), no false −27.7% and no "volatile" flag.
- [ ] **A3 · Derive EBITDA on the live extraction path (S)** → **PR #163**
  - Move `computeDerivedFields` to a shared helper; call it in `A/services/extraction/normalize.ts` for income statements. Order: EBIT + D&A → GP − total OpEx → net income + interest + tax + D&A. Tag `ebitda_source: "derived: …"` so the UI can mark it.
  - Safety net: ratios fall back to EBIT + D&A, then `ebitda_margin_pct`.
  - Bump `EXTRACTION_SCHEMA_VERSION` so Re-extract recomputes.
  - Done when: SRM shows EBITDA and EBITDA margin in the table, ratios, and the model.
- [ ] **A4 · Store the canonical period (M, Mig)** → **PR #164 (migration + backfill pending)**
  - Columns on `FinancialStatement`: `periodKey`, `periodKind`, `periodMonths`, `periodEndDate` (add `YTD` handling). Cross-document conflict lookup matches on `periodKey`, not the raw label (`financialExtractionOrchestrator.ts:185`).
  - Backfill existing rows (pattern: `apps/api/scripts/dedup-existing-statements.ts`).

### Phase B — Use the right source documents

- [ ] **B1 · Real statements beat derived models (M)** → **PR #164** — `A/services/financialSourceAuthority.ts`, `financialExtractionOrchestrator.ts`
  - New rank below "source statement": derived/model files (signals: valuation, summary, returns, DCF, sensitivity, model output).
  - Have the Claude container extraction report, per statement, the **sheet name** and `sourceKind` (`source_statement` | `model_derived`); store both on the row.
  - Break ties by `sourceKind`, then completeness (line-item count, presence of totals) — never by who wrote first.
  - Done when: SRM's balance sheet and cash flow come from the LBO workbook's source tabs; the valuation summary's rows are inactive "needs review" alternatives.
- [ ] **B2 · Point the extractor at the statement tabs (S)** → **PR #163**
  - Sheet scoring: match `cfs`/`bs`/`pl`/`is` as words (not only whole names), bonus for "source / historical / actuals", lower score for valuation/returns/sensitivity/summary (`A/services/excelFinancialExtractor.ts:38-85`).
  - Container prompt: "Prefer tabs with the company's reported historical statements (e.g. '*Source*', 'Historical', 'Actuals'); extract every balance-sheet and cash-flow line from them; never take them from valuation or analysis tabs; report the sheet name."
- [ ] **B3 · Queue documents instead of skipping them (S–M)** → **PR #163** — `A/routes/financials-extraction.ts:359`, `A/services/ingestDeepPass.ts:36-41`, `A/routes/documents-upload.ts:484-491`
  - Replace parallel `Promise.allSettled` + "skipped_no_slot" with a bounded queue (`utils/limitConcurrency` `mapWithConcurrencyLimit` exists), source statements first, derived models last.
  - Make the conflict check + upsert atomic per (deal, statement, period) so completion order can't decide the winner.
  - Done when: "Extract all" on a 15-doc deal processes all 15 (reports progress), none silently skipped.
- [ ] **B4 · Cash-flow signs and statement checks (S–M)** → **PR #163**
  - Deterministic sign pass in `extraction/normalize.ts` (and legacy): cash outflows — capex, debt repayment, dividends/distributions, acquisitions — stored ≤ 0; prompt rule "cash outflows negative". Stop treating capex as positive in the legacy prompt.
  - Validator (error level → triggers repair): CFO + CFI + CFF ≈ net change in cash; balance sheet has totals and assets = liabilities + equity (`A/services/financialValidator.ts`).
  - Map `total_debt` to its own key (today it's aliased to `long_term_debt`, which mislabels it).
  - Done when: SRM 2024 distributions −$1.27M, 2025 debt repayment −$1.30M.

### Phase C — A P&L that reads like a P&L

- [ ] **C1 · Extraction records the parent line, label and order (M)** → **PR #164 (source label/row order deferred)** — `A/services/extraction/extractionSchema.ts:93`, `normalize.ts`
  - Add a `parent` field (restricted to standard keys) per line item; store the source's own label and row order (`lineItemMeta` or `<key>_label`); add `other_income` / `other_expense` standard keys; enforce signs (contra-revenue like discounts/refunds negative; costs positive).
  - Bump the schema version.
- [ ] **C2 · Statement-specific layout in the table (M)** → **PR #163** — `W/app/(app)/deals/[id]/deal-financials-table.tsx`, new `deal-financials-layout.ts`
  - Income statement sections: Revenue → COGS → **Gross Profit** → OpEx → **EBITDA** → D&A → **EBIT** → Interest/Other → **EBT** → Tax → **Net Income**; raw accounts nested as collapsible children under their section; balance-sheet/cash-flow keys never shown on the P&L; leftovers in one collapsed "Unclassified accounts" group.
  - Show derived values (e.g. EBITDA) marked "derived"; negatives in accounting style; fix the label bug that upper-cases any short word ("Fly ASH").
  - Done when: SRM's P&L reads top-down like the source QuickBooks statement, with Cement/Fly Ash/Sand under COGS and Discounts/Refunds under Revenue.

### Phase D — Model builder: correct numbers

- [ ] **D1 · Pick the right base / entry period (M)** → **PR #163** — `A/services/dealModel/assumptions.ts`, `workbook.ts`
  - Base = LTM (FY(n−1) + YTD(n) − YTD(n−1)) when a prior-year YTD exists, else the last full fiscal year; YTD shown for information only, never as a full year.
  - Drop or flag sparse rows (e.g. a revenue-only "2021" from a CIM chart); default growth from full-year CAGR over real years.
- [ ] **D2 · Entry values and formula fixes (S)** → **PR #163**
  - Entry EBITDA = base-period EBITDA (derived if needed, A3), fallback `Deal.ebitda`; write it as a labelled input; warn instead of silently writing 0.
  - Honour `entryBasis` (revenue-based entry) and `debtQuantumMode`; EBITDA-margin formula shows blank (not 0%) when EBITDA is missing; set `fullCalcOnLoad` so previews show values; fix the Projections row-10 label (Net income vs Unlevered FCF); fix the Notes text ("cash sweeps are not modelled" — they are); make the panel preview use margin × revenue.
  - Done when: SRM's model has non-zero entry EV / debt / equity and a real IRR and MoM.

### Phase E — Model builder: what the team asked for

- [ ] **E1 · Model every P&L line (L)** → **PR #167** — each line gets a driver (% of revenue / growth / fixed / subtotal), seeded from historical averages; subtotals as live formulas; per-line driver table in the panel. Requires replacing the fixed cell map (`ASSUMPTION_CELLS`) with a generated one and updating `tests/deal-model-workbook.test.ts`.
- [ ] **E2 · High / base / low scenarios (M)** → **PR #167** — use the existing named-case support in `DealModel`; Low/Base/High columns per driver with an "active case" switch in the workbook (`CHOOSE`), a case switcher and per-case save in the panel, and an IRR/MoM summary per case.
- [ ] **E3 · Balance-sheet and cash-flow driven items (L)** → **PR #168** — working capital (DSO/DIO/DPO), capex schedule from historical cash flows, opening net debt into sources & uses, multiple debt tranches, levered FCF feeding the cash sweep. Integrated balance sheet with a balance check is a later L+.

### Phase F — Analysis depth

- [ ] **F1 · Surface the qualitative red flags (M)** → **PR #165 (cash-flow flags) + #166 (customer concentration)** — customer concentration and related-party customers from the CIM/notes (the deal chat can already read documents); negative free cash flow and debt-funded capex from the (now correct) cash flow; feed both into Quality of Earnings and Key Findings.

### Checks before / alongside the fixes

- [ ] **V1 · Confirm on the SRM deal's stored data** (needs a founder SQL run — Claude Code can't read production data):
  ```sql
  -- which documents' rows are active vs inactive, per statement and period
  select "statementType", period, "isActive", "mergeStatus", "documentId", jsonb_object_keys("lineItems") as key
    from "FinancialStatement" where "dealId" = '<SRM deal id>' order by 1, 2, 3 desc;
  ```
  Confirms whether the LBO workbook's rows exist as inactive alternatives (B1) or were never extracted (B3), and the exact line-item keys (C1).
- [ ] **V2 · Build a regression fixture from the SRM files** (with the team's permission — they're a real company's financials) as a golden case in `A/services/extraction-evals/` so each phase is measured against the analyst's correct figures.
- [ ] **V3 · After Phases A–B ship: re-extract SRM** and have the analyst re-check the same screens.

---

## Suggested delivery

| PR | Contents | Size |
|---|---|---|
| 1 | A1 + A2 + A3 (periods, analysis, EBITDA) | ~3 days |
| 2 | B1 + B2 + B3 + B4 (right sources, queue, signs, checks) | ~4 days |
| 3 | A4 migration + backfill (founder runs SQL) | ~1 day |
| 4 | C1 + C2 (P&L layout) | ~3 days |
| 5 | D1 + D2 (model correctness) | ~2 days |
| 6+ | E1, E2, E3, F1 (model features, analysis depth) | 1–2 weeks |
