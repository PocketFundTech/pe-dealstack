# 🔴 ONE MIGRATION PENDING — `usage-cost-accuracy-migration.sql` (2026-09-29)

Run **only this one**. It supersedes `model-prices-anthropic-direct-seed.sql`
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
| 1 | `apps/api/usage-cost-accuracy-migration.sql` | Correct Claude prices, new providers, reconciliation table | ☐ |

Verify after running (queries also at the bottom of the file):
```sql
select model, "inputPricePer1M", "outputPricePer1M", "cacheReadPricePer1M"
  from public."ModelPrice" where model like 'claude-%' order by model;
-- claude-sonnet-5 = 2 / 10; claude-sonnet-4-6 = 3 / 15
select to_regclass('public."UsageReconciliation"');  -- not null
```

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
