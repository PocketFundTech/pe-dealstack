# Pending Ops Checklist — Founder/Ops Actions

> **Purpose:** every manual action (SQL, env var, dashboard click) the founder needs to take **once** to make the security/trust workstream fully effective in production. Updated as each feature ships.
>
> **Rule:** code can ship, deploys can land, but a feature isn't *complete* until its row here is checked.

---

## 🔴 Open as of 30 Sep 2026 (Smooth Flows + live QA)

Most urgent first. Tick each box once it's done and verified.

### Database (Supabase → SQL Editor → New query → paste the file → Run)

These couldn't be run from Claude Code: the service keys can't change the database structure, and the automated production-write checks blocked the data update.

- [ ] **OPS-4 — Run `apps/api/usage-cost-accuracy-migration.sql`** (safe to re-run)
  - Fixes AI cost tracking:
    - Sonnet 5 is currently priced at $3/$15 instead of $2/$10.
    - Sonnet 4.6 is missing from the price list, so its calls record $0.
    - Adds cache prices and allows the Tavily/LlamaParse providers.
    - Creates the `UsageReconciliation` table.
  - Verify:
    ```sql
    select model, "inputPricePer1M", "outputPricePer1M" from "ModelPrice" where model like 'claude-sonnet%';
    -- claude-sonnet-5 = 2 / 10, claude-sonnet-4-6 = 3 / 15
    select to_regclass('public."UsageReconciliation"');  -- not null
    ```
- [ ] **OPS-5 — Run `apps/api/deal-stage-cleanup.sql`** (data only, safe to re-run)
  - Moves deals saved with stages the pipeline doesn't show onto real stages: `SCREENING` → Initial Review, `LOI_NEGOTIATION` → LOI Submitted. Until it runs, those deals are hidden from the Deals kanban.
  - Optional preview first: run the commented `SELECT` at the top of the file.
  - Verify:
    ```sql
    select stage, count(*) from "Deal" where stage in ('SCREENING','LOI_NEGOTIATION') group by stage;  -- no rows
    ```

### Merge and deploy

- [ ] **OPS-6 — Merge PR #160 (Smooth Flows batch 0)**. It fixes the wrong Excel financials, PDF uploads, "mark all as read", Firm Profile saving, data-room insights and dropped uploads.
- [ ] **OPS-7 — After #160 is live, re-extract financials on affected deals.**
  - Deals uploaded before the fix keep their wrong numbers (EBITDA 0, revenue rounded to 100s) until someone clicks **Re-extract Financials** on the deal.
  - Likely affected: deals uploaded with INR crore/lakh figures, plus the QA deal "Northwind Cold Chain".
  - The extraction cache is versioned, so re-extract recomputes rather than replaying the old result.

### Vercel environment variables (Project `pe-dealstack` → Settings → Environment Variables → Production)

- [ ] **OPS-8 — Add the Google OAuth client ID and secret.** Gmail and Google "Connect" return a 500 before Google even opens (seen in live QA). Use the same variable names as the Google integration code, then redeploy. This also unblocks Gmail sync, Drive import and the cancel-sign-in path.
- [ ] **OPS-9 — Delete `Antropic_api_avise`** (misspelled leftover). The app reads `ANTHROPIC_API_KEY`.
- [ ] **OPS-10 — Set `ANTHROPIC_ADMIN_KEY`** (an `sk-ant-admin01…` key from the Anthropic Console). It enables the daily cost reconciliation against Anthropic's own billing.

### Accounts and keys

- [ ] **OPS-11 — Revoke the two Anthropic API keys pasted into chat on 28–29 Sep** (Anthropic Console → API Keys). Treat anything pasted into a chat as exposed.
- [ ] **OPS-12 — Check that invite emails are delivered.** The QA invite said "email could not be sent", but it went to an `@example.com` address that never accepts mail. Send one invite to a real address and check the email provider's logs.
- [ ] **OPS-13 — Decide on OpenAI.** Some features may still call OpenAI, which has no working key or credit in production. Data-room insights were moved to Claude in #160. Either restore OpenAI credit or keep moving features to Claude.

### Small fixes in the app

- [ ] **OPS-14 — Fix the Settings page title "GAsjab"** (typed test text, visible in Settings).
- [ ] **OPS-15 — Rotate the QA test account password** once browser testing is finished (`qa.tester@example.com`; reset in Supabase → Authentication → Users). The account and the "Avise QA Test Org" are kept for re-testing.

---

## Carry-overs from earlier shipped PRs

These items still pending from PRs #9 / #30 / #34 / #35.

- [ ] **OPS-1 — `POCKET_FUND_STAFF_EMAILS` env var on Vercel**
  - Where: Vercel Dashboard → Project `pe-dealstack` → Settings → Environment Variables
  - Add: `POCKET_FUND_STAFF_EMAILS` = comma-separated staff emails (e.g., `ganeshjagtap7@gmail.com,dev@pocket-fund.com`)
  - Scope: Production
  - Without it: PR #30 staff access log middleware no-ops cleanly — the feature ships dead-effective.

- [ ] **OPS-2 — Expose Supabase `auth` schema in PostgREST**
  - Where: Supabase Dashboard → Project Settings → API → "Exposed schemas"
  - Add: `auth`
  - Without it: Active sessions UI shows "Session management unavailable", security dashboard's `activeSessions` metric returns null.

- [ ] **OPS-3 — Promote founder to ADMIN role**
  - Where: Supabase Dashboard → SQL Editor
  - Run:
    ```sql
    UPDATE "User" SET role = 'ADMIN' WHERE email = 'ganeshjagtap7@gmail.com';
    SELECT id, email, role, "organizationId" FROM "User" WHERE email = 'ganeshjagtap7@gmail.com';
    ```
  - Without it: security dashboard 403s for founder; admin-only endpoints (audit export, MFA toggle, isolation test) all 403.

---

## New ops items from this batch (Features 5–15)

Filled in as each feature ships. Each row references the PR + feature.

### Database migrations (run in Supabase SQL Editor in this order)

- [ ] **OPS-MIG-1** — _to be filled by an upcoming PR_

### Environment variables (Vercel → Settings → Environment Variables)

- [ ] _to be filled_

### Supabase / external dashboard configuration

- [ ] _to be filled_

---

## Financials fix plan (2026-10-01)

- [ ] **OPS-FIN-1 — Run `apps/api/financials-source-period-migration.sql`, then the backfill**
  - Where: Supabase Dashboard → SQL Editor; then `cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts` (try `--dry-run` first)
  - Without it: works, but periods are matched by parsing labels on every write, and reported-vs-model provenance isn't stored (it's re-derived from file names).
  - Then: **Re-extract** the Strong Ready Mix deal so its balance sheet / cash flow move off `SRM_Valuation_Summary_.xlsx`.

## How to use this doc

When the dev says **"feature N shipped"**, do not consider that feature complete until:

1. Find its row(s) here under "New ops items"
2. Run the SQL / set the env var / click the dashboard toggle
3. Smoke-test the feature in your browser
4. Tick the checkbox in this file (PR is fine, or just edit on disk)

If a feature has **no rows here**, it's effective the moment it deploys.

---

*Last updated: 2026-05-10 (this PR)*
