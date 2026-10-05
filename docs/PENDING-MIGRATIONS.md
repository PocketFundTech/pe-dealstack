# ⏳ `financials-period-key-unique-migration.sql` (2026-10-02) — PENDING (founder runs)

One active row per fiscal period (fix plan G9, PR C). "2024" and "FY2024 (Jan - Dec 2024)" are the same year (`periodKey` '2024'), but the only database guard was on the raw label, so both could stay active, giving two columns for one year.

**Order matters — the SQL refuses to run until step 1 is done:**

1. Backfill period keys on older rows (fills `periodKey`, changes nothing else). Run from a checkout with `apps/api/.env`:
   ```bash
   cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run
   cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts
   ```
2. Run `apps/api/financials-period-key-unique-migration.sql` in the Supabase SQL Editor. Where a deal has more than one active row for the same period, it:
   - keeps one: a reported statement over a model-derived one, then the higher confidence, then the newer;
   - flags the kept row `needs_review` and deactivates the rest (nothing is deleted);
   - adds a unique index so it can't happen again.

Idempotent, safe to re-run.

| # | Migration file | Adds | Run? |
|---|---|---|---|
| 1 | `apps/api/scripts/backfill-statement-period-keys.ts` | `periodKey` on older rows | ⏳ |
| 2 | `apps/api/financials-period-key-unique-migration.sql` | duplicate cleanup + `idx_financial_statement_active_period_key_unique` | ⏳ |

Verify (expect 1, 0, 0):
```sql
select
  (select count(*) from pg_indexes where indexname = 'idx_financial_statement_active_period_key_unique') as unique_index,
  (select count(*) from (select 1 from "FinancialStatement" where "isActive"
     group by "dealId", "statementType", "periodKey" having count(*) > 1) d) as duplicate_groups,
  (select count(*) from "FinancialStatement" where "isActive" and "periodKey" is null) as active_without_key;
```

# ✅ `webhook-subscriptions-migration.sql` (2026-10-02) — RUN AND VERIFIED 2026-10-02

Creates the `WebhookSubscription` table behind **Settings → Webhooks** and `/api/webhook-subscriptions` (outbound events for n8n, Zapier and Make).
Founder ran it 2026-10-02; `to_regclass` returned `"WebhookSubscription"`.
Idempotent, safe to re-run.

| # | Migration file | Adds | Run? |
|---|---|---|---|
| 1 | `apps/api/webhook-subscriptions-migration.sql` | `WebhookSubscription` table (RLS on) | ✅ 2026-10-02 |

Verify:
```sql
select to_regclass('public."WebhookSubscription"');  -- not null
```

# ✅ `api-keys-migration.sql` (2026-10-02) — RUN AND VERIFIED 2026-10-02

Creates the `ApiKey` table behind **Settings → API Keys** (org API keys for n8n, Zapier and scripts; see `docs/API-KEYS.md`).
Founder ran it 2026-10-02; `to_regclass` returned `"ApiKey"`. (Before it ran, the API Keys section showed "Couldn't load API keys…", key creation fails, and every `avise_sk_…` key was rejected with 401.)
Idempotent, safe to re-run.

| # | Migration file | Adds | Run? |
|---|---|---|---|
| 1 | `apps/api/api-keys-migration.sql` | `ApiKey` table (hash-only storage, RLS on) | ✅ 2026-10-02 |

Verify:
```sql
select to_regclass('public."ApiKey"');  -- not null
```

# ✅ 2026-09-29 → 2026-10-01 BATCH — ALL THREE RUN AND VERIFIED (2026-10-02)

The founder ran all three in the Supabase SQL Editor on 2026-10-02 and the combined check passed:
6 new `FinancialStatement` columns, `claude-sonnet-5` = 2 / 10, `UsageReconciliation` exists, 0 deals left on `SCREENING` / `LOI_NEGOTIATION`.
The optional period-key backfill for #3 is `apps/api/scripts/backfill-statement-period-keys.ts`.

## 1. `usage-cost-accuracy-migration.sql` (2026-09-29)

Run this one first. It supersedes `model-prices-anthropic-direct-seed.sql`
(flagged 2026-09-28 — do not run that one separately; everything it did is
included here, with corrected prices).

What it fixes in the AI cost ledger (`UsageEvent`):
- **`claude-sonnet-5` priced at $3/$15 instead of the $2/$10 list price** —
  every chat, memo, NDA, scorecard and managed-agent row overstated by 50%.
- **`claude-sonnet-4-6` missing** — deal chat and legacy extraction recorded **$0**.
- Adds optional explicit cache prices (Fable 5.1 cache reads at $0.25/MTok).
- Allows `tavily` / `llamaparse` providers — until it runs, Tavily and
  LlamaParse usage rows fail to insert (logged, nothing else breaks).
- Creates `UsageReconciliation` for the daily check against Anthropic's own
  cost report — until it runs, the job computes but can't store results.

The code is written to work before and after this runs; until it does, the
price fixes above are not in effect. Idempotent — safe to re-run.

| # | Migration file | Fixes | Run? |
|---|---|---|---|
| 1 | `apps/api/usage-cost-accuracy-migration.sql` | Correct Claude prices, new providers, reconciliation table | ✅ 2026-10-02 |

Verify after running (queries also at the bottom of the file):
```sql
select model, "inputPricePer1M", "outputPricePer1M", "cacheReadPricePer1M"
  from public."ModelPrice" where model like 'claude-%' order by model;
-- claude-sonnet-5 = 2 / 10; claude-sonnet-4-6 = 3 / 15
select to_regclass('public."UsageReconciliation"');  -- not null
```

## 2. `deal-stage-cleanup.sql` (2026-09-30) — data fix

Deals created from **Data Rooms → New data room** were saved with stage
`SCREENING`, and deals moved by the **deal chat / AI assistant** could be saved
as `LOI_NEGOTIATION`. Neither is a pipeline stage, so those deals are
**invisible on the Deals kanban**. The code now rejects unknown stages; this
moves existing deals onto real ones (`SCREENING` → Initial Review,
`LOI_NEGOTIATION` → LOI Submitted). Data only, idempotent.

| # | File | Fixes | Run? |
|---|---|---|---|
| 2 | `apps/api/deal-stage-cleanup.sql` | Makes hidden deals show on the kanban | ✅ 2026-10-02 |

Verify: the `SELECT` at the bottom of the file returns no rows.

## 3. `financials-source-period-migration.sql` (2026-10-01)

Fix plan A4 + B1 ([`FINANCIALS-FIX-PLAN.md`](FINANCIALS-FIX-PLAN.md)). Adds to
`FinancialStatement`: `periodKey`, `periodKind`, `periodMonths`, `periodEndDate`
(canonical period — "FY2024 (Jan - Dec 2024)" and "2024" share key `2024`) and
`sourceKind`, `sheetName` (reported statement vs valuation model, and which tab).

The code works before and after this runs: until it does, extraction writes
without the columns (one warning in the API log) and matches periods by
parsing labels. Idempotent — safe to re-run. Then run the backfill (fills NULL
columns only, never changes which row is active):

```bash
cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run
cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts
```

| # | File | Fixes | Run? |
|---|---|---|---|
| 3 | `apps/api/financials-source-period-migration.sql` + backfill script | Canonical periods, source provenance | ✅ 2026-10-02 |

Verify: the queries at the bottom of the file — 6 columns, then 0 rows missing `periodKey` after the backfill.

---

# ✅ 2026-08-18 BATCH — ALL RUN AND VERIFIED

> **HARD GATE.** Vercel does **not** run `apps/api/*.sql`. Code can ship green,
> pass every test, and still 500 in production because the tables don't exist.
>
> **No feature on this list may be reported as complete, merged to `main`, or
> demoed until the founder has manually run its SQL in Supabase AND confirmed
> that back in writing.** Tests passing is not confirmation. A green PR is not
> confirmation. Only an explicit "I ran it" from the founder counts.

**Status: 🟢 COMPLETE — all four migrations run by the founder and verified live against Supabase on 2026-08-18.**

Keep this file. The gate above still governs any FUTURE migration: a new
`.sql` gets a new row, the status drops back to 🔴, and no feature
depending on it may be called complete until the founder runs it.

---

## Queue (run in this order)

| # | Migration file | Feature | Branch | Run? |
|---|---|---|---|---|
| 1 | `apps/api/doc-request-migration.sql` | Document Requests | `feat/doc-requests` | ☑ 2026-08-18 |
| 2 | `apps/api/deal-reactivation-migration.sql` | Deal Reactivation | `feat/deal-reactivation` | ☑ 2026-08-18 |
| 3 | `apps/api/nda-review-migration.sql` | NDA Redlining | `feat/nda-review` | ☑ 2026-08-18 |
| 4 | `apps/api/deal-model-migration.sql` | Model Export | `feat/model-export` | ☑ 2026-08-18 |

_Rows 2–4 are added as each feature lands. A row with an unchecked box blocks
that feature's completion claim._

---

Applied via the combined script `apps/api/migrations-2026-08-18-all.sql`.
Verified live against Supabase 2026-08-18:
  - 6 tables present (DocRequest, DocRequestItem, DocRequestEvent,
    DealReactivation, NdaReview, DealModel)
  - 6 Deal columns present (passReason, passedAt, revisitAt, lastRescoredAt,
    scorecardHistory, scorecard)
  - CHECK + FK constraints enforcing (pg 23514, 23503)
  - RLS blocking the anon key on every new table (pg 42501 on write,
    0 rows on read)

## How to run them

All four are idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT
EXISTS`), so re-running is safe.

**Option A — Supabase SQL editor (what we normally do):**
1. Open the project → SQL Editor → New query.
2. Paste the contents of one file, run it, confirm "Success".
3. Tick its box above.
4. Repeat for the next file, in order.

**Option B — psql, all at once:**
```bash
cd "/Users/ganesh/AI CRM"
for f in apps/api/doc-request-migration.sql \
         apps/api/deal-reactivation-migration.sql \
         apps/api/nda-review-migration.sql \
         apps/api/deal-model-migration.sql; do
  echo "── $f"
  psql "$SUPABASE_DB_URL" -f "$f" || break
done
```

---

## Post-run verification

After running, confirm the objects exist:

```sql
-- Expect 5 rows
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('DocRequest','DocRequestItem','DocRequestEvent',
                     'NdaReview','DealReactivation','DealModel');

-- Expect 5 rows (Deal columns added by the reactivation migration)
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'Deal'
  and column_name in ('passReason','passedAt','revisitAt',
                      'lastRescoredAt','scorecardHistory');

-- Every new table must have RLS on (browser anon key sees zero rows)
select relname, relrowsecurity from pg_class
where relname in ('DocRequest','DocRequestItem','DocRequestEvent',
                  'NdaReview','DealReactivation','DealModel');
```

RLS must read `true` on every row — these tables hold share/request tokens,
and the browser holds an anon key.

---

## Then, and only then

1. Tick every box above.
2. Change the status line at the top to 🟢 RUN + confirmed, with the date.
3. Smoke-test one endpoint per feature against production.
4. Only now may the features be called done.

---

## Why this file exists

The founder asked for it explicitly on 2026-08-18: build all four features
first, then run every migration in Supabase in one pass — and treat an
unconfirmed migration as a **red flag that blocks completion**, not a
footnote. Prior incidents in this repo (scorecard, deal-share) shipped code
whose tables didn't exist yet and 500'd in production only.
