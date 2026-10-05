# Financials fixes — manual test plan

Branch `fix/financials-phase-a` (8 commits, not pushed). Covers fix-plan items **A1–A3, B2, B3, B4, C2, D1, D2**
from [`FINANCIALS-FIX-PLAN.md`](FINANCIALS-FIX-PLAN.md) (PR #162). Automated: API 2154 tests, web 458 tests, all passing.

Tick each box. Write the actual value in the ✎ column when it differs from the expected value. Anything marked **🔴 blocker** must pass before we push to `main`.

---

## 0. Before you start (5 min)

> ⚠️ **Local `.env` points at the production Supabase project** (`rnipkfubpvyvskswsekk`).
> Sections 1–4 are **read-only**. Sections 5–6 **write to production** — use a **test deal**, never SRM, unless the team agrees.
> In the model panel, **don't click Save** (it writes `DealModel`). Export/Download is safe.

- [ ] `git checkout fix/financials-phase-a && git pull` *(nothing to pull, it's local — just make sure you're on it)*
- [ ] Node 22+ is required (default Node 20 breaks tests and the Supabase client):
  ```bash
  export PATH=/opt/homebrew/opt/node@23/bin:$PATH
  npm run build --workspace=@ai-crm/shared     # the new period parser lives here
  npm run dev:api                               # terminal 1 → :3001
  npm run dev:next                              # terminal 2 → :3002
  ```
- [ ] Open http://localhost:3002, log in, open **Strong Ready Mix** (deal id `338c3435-…`)
- [ ] Optional sanity run: `cd apps/api && npx vitest run` and `cd apps/web-next && npx vitest run` (both green)

---

## 1. Analysis — period order and growth (A1, A2) · read-only

Deal → AI analysis / deep dive.

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 1.1 🔴 | Revenue Quality → growth chips | **2023 +29.51%**, **2024 +30.35%**. No "2025 --" chip | | [ ] |
| 1.2 🔴 | Dashed YTD chip at the end | **YTD Sep 2025 run-rate (est.) +41.4%**. Hover shows "annualised (× 12 / 9) vs 2024 — an estimate" | | [ ] |
| 1.3 🔴 | No false decline | No **−27.68%** anywhere, no "Revenue Declining" flag | | [ ] |
| 1.4 | Consistency score | **100 Consistent** (was 25 "Volatile") | | [ ] |
| 1.5 | Revenue CAGR | **29.79%** (same number as before, but now over the real 3 years 2021→2024) | | [ ] |
| 1.6 | QoE flags | No "Volatile Revenue Growth" flag | | [ ] |
| 1.7 | Ratio trend arrows (net margin etc.) | Not pointing "declining" just because 2025 YTD is last | | [ ] |
| 1.8 | Period labels in analysis | Show as `2021`, `2023`, `2024`, `YTD Sep 2025` | | [ ] |

## 2. Financial statements table (A1, C2) · read-only

Deal → Financials → Income Statement (also try **Full View**).

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 2.1 🔴 | Column order | 2021 → FY2023 (Jan–Dec 2023) → FY2024 (Jan–Dec 2024) → 2025 YTD (Jan–Sep 2025) → 2026E … 2031E | | [ ] |
| 2.2 🔴 | Toolbar **annual** | Shows 2021, FY2023, FY2024 (before: only 2021) | | [ ] |
| 2.3 | Toolbar **quarterly** | Shows 2025 YTD (non-annual periods) | | [ ] |
| 2.4 🔴 | P&L reads top-down | Revenue → Cost of Goods Sold → Gross Profit → Total OpEx → D&A → EBIT → Other Income → Tax → Net Income → Unclassified | | [ ] |
| 2.5 🔴 | Revenue children | Gross Sales, Discounts, Refunds Allowances, Services Income, Shipping Delivery Income, Other Ordinary Income | | [ ] |
| 2.6 🔴 | COGS children | Cement COS, Fly Ash COS, Sand COS, Large Gravel COS, Equipment Rental COS, Freight Delivery COS, Total Supplies Materials COGS | | [ ] |
| 2.7 | OpEx children | Bad Debts, Insurance, Payroll, Fuel, Repair Maintenance, Legal Professional Fees, **Total Taxes Licenses**, **Disposal Fees** | | [ ] |
| 2.8 🔴 | No "Goodwill" section on the P&L | Goodwill Amortization 754 sits **under D&A** | | [ ] |
| 2.9 | Net Operating Income | Under **EBIT**, not Revenue | | [ ] |
| 2.10 | Collapse/expand | Chevron on sections with accounts hides/shows them. "Unclassified accounts" starts collapsed | | [ ] |
| 2.11 | Labels | "Fly Ash COS" (not "Fly ASH") | | [ ] |
| 2.12 | Negatives | Shown in brackets, e.g. Discounts `(12.6K)` | | [ ] |
| 2.13 | Show empty rows | Toggling still works; hidden count updates | | [ ] |
| 2.14 | Balance Sheet / Cash Flow tabs | Render without errors (still sourced from `SRM_Valuation_Summary_.xlsx`, **expected** until B1) | | [ ] |
| 2.15 | EBITDA row on SRM's P&L | Probably still blank. SRM's stored rows predate A3; it appears (with a **derived** tag) only after a re-extract (§5) | | [ ] |

## 3. Model builder (D1, D2) · read-only if you don't click Save

Deal → Model panel.

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 3.1 🔴 | Preview tiles | Entry EV **≈ 11.1M** and an Equity cheque (not "—"). MoM/IRR show values | | [ ] |
| 3.2 | Default assumptions (if never saved) | Growth **29.8%**, margin **8.1%**, entry multiple **5.0x** | | [ ] |
| 3.3 🔴 | **Download** the workbook → Projections | Base column header **"FY2024 (Jan - Dec 2024) A"** (not 2025 YTD). Revenue **27.3**, EBITDA **2.21** (blue input cells) | | [ ] |
| 3.4 🔴 | Returns sheet | Entry EBITDA 2.21, Entry EV ≈ **11.05**, Debt ≈ **5.5**, Equity ≈ **5.7** — none 0. **IRR is a %, not "n/a"** | | [ ] |
| 3.5 | Historicals sheet | Columns 2021, FY2023, FY2024, 2025 YTD. EBITDA filled for FY2023/24/YTD. 2021 margin **blank**, not 0.0% | | [ ] |
| 3.6 | Row labels | Row 10 = Net income on Historicals. Projections has "Unlevered FCF" on its own row (11) | | [ ] |
| 3.7 🔴 | Notes sheet | Says base = last full fiscal year FY2024, 2025 YTD info only. Has **CHECK: … 2.21 (derived) … deal record says 6.10 … 176% difference** | | [ ] |
| 3.8 | Notes sheet | Does **not** say "cash sweeps are not modelled" | | [ ] |
| 3.9 | Open in Google Sheets / Mac preview | Numbers show on open (fullCalcOnLoad), not blanks | | [ ] |
| 3.10 | Change the entry multiple in the panel, then Download | Entry EV in the file follows (panel edits are merged on export) | | [ ] |

> 📌 **Decision for the team (3.7):** SRM's P&L-derived FY2024 EBITDA is **2.21**, but the deal record says **6.1** (probably adjusted EBITDA). Which one is the right entry basis? It changes EV and every return.

## 4. Deal chat · read-only

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 4.1 | Ask the deal chat: "Show SRM's revenue by year" | Periods in order 2021 → FY2023 → FY2024 → 2025 YTD | | [ ] |
| 4.2 | Global chat: "What were Strong Ready Mix's financials?" | Same ordering | | [ ] |

---

## 5. Re-extract a single document (A3, B2, B4) · ⚠️ writes — test deal only

Use a **test deal** with: a QuickBooks-style P&L (no printed EBITDA line) and a cash flow with capex/distributions. The SRM files are fine to *upload to a test deal* if the team agrees they can be used.

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 5.1 🔴 | P&L without an EBITDA line → Re-extract | EBITDA row filled, with a **derived** tag. Hover shows the formula (e.g. "ebit + da") | | [ ] |
| 5.2 | EBITDA margin row | Filled for those periods | | [ ] |
| 5.3 🔴 | Cash flow | Capex, debt repayment, dividends and **owner distributions are negative** (brackets) | | [ ] |
| 5.4 | Cash-flow warnings | If CFO + CFI + CFF ≠ net change in cash, the extraction shows a "sections don't sum" issue | | [ ] |
| 5.5 | Balance sheet with no totals (e.g. valuation summary) | Warning "Balance sheet has no total assets …" | | [ ] |
| 5.6 | Workbook with tabs like "BS Source" / "CFS Source" | Balance sheet and cash flow come from those tabs, not a valuation/summary tab | | [ ] |
| 5.7 | Total debt line | Shows as **Total Debt**, not Long-term Debt | | [ ] |

## 6. Extract all (B3) · ⚠️ writes — test deal only

Test deal with **6+ financial files**, including one named like `*Valuation*Summary*.xlsx`.

| # | Check | Expected | ✎ | Pass |
|---|---|---|---|---|
| 6.1 🔴 | Click Extract (all) | Label shows **"Extracting… 45s · 2/6 documents"** and the count goes up | | [ ] |
| 6.2 🔴 | When done | Every document processed. **None skipped** ("slot unavailable" should not appear) | | [ ] |
| 6.3 | API log (`api.log`) | Statement files start first, the valuation/summary file last | | [ ] |
| 6.4 | Large deal (> ~4 min of work) | A second request is sent automatically for pending docs, and the batch completes | | [ ] |
| 6.5 | Toast | "Re-extracted across N documents" with the right N | | [ ] |
| 6.6 | Conflicts panel | Still works. Same period from two files → one active, one "needs review" | | [ ] |
| 6.7 | New-deal upload with several files | Deep pass runs for all files (no "skipped — concurrency cap" in the log) | | [ ] |

---

## 7. Regression — other deals · read-only

Pick 3 other deals with different period styles.

| # | Deal type | Check | Pass |
|---|---|---|---|
| 7.1 | Monthly P&L (Jan-25, Feb-25 …) | Table columns in calendar order. Charts OK. Analysis growth month-on-month, no crash | [ ] |
| 7.2 | Plain annual (2022, 2023, 2024) | Analysis, ratios and model look as before | [ ] |
| 7.3 | Deal with a printed EBITDA | Model entry EBITDA = the printed value. No "derived" tag | [ ] |
| 7.4 | Deal with no financials | Analysis/model show their empty states, no errors | [ ] |
| 7.5 | Balance sheet + cash flow tabs on any deal | Render. Sections in statement order | [ ] |
| 7.6 | Browser console | No new errors on the deal page | [ ] |

---

## 8. Go / no-go for pushing to `main`

- [ ] All **🔴 blocker** rows pass
- [ ] §7 regression passes on at least 3 deals
- [ ] The decision on SRM entry EBITDA (2.21 vs 6.1) is noted (it doesn't block the push)
- [ ] Any failures are logged below, with deal, screen, expected vs actual, and a screenshot

Then: push → PR → CI green → merge → Vercel deploy → **Re-extract SRM** (with the team's OK) → analyst re-checks the same screens (plan V3).

## Issues found

| # | Section | Deal | Expected | Actual | Screenshot |
|---|---|---|---|---|---|
| | | | | | |
