# CONTEXT — where things stand (updated 3 Oct 2026, 04:10 IST)

The one-page handoff for whoever picks up next (person or agent). The detailed day-by-day log is
[`PROGRESS.md`](PROGRESS.md); working rules are in [`CLAUDE.md`](CLAUDE.md).

## Product in one line
**Avise** — AI CRM for private-equity deal teams. Monorepo: Express API (`apps/api`), Next.js 16 web app
(`apps/web-next`, the live frontend), legacy `apps/web`, shared package `packages/shared`. Supabase Postgres.
One Vercel project `pocket-funds-projects/pe-dealstack` serves `deals.avise.io` and `app.avise.io`.

## 🔴 Blocking right now
1. **Production is out of AI credit.** Anthropic: *"Your credit balance is too low"*; OpenAI: *"429 no credits remaining"*.
   Every AI feature fails — extraction, PDF ingest, chat, memos, insights — including for real customers
   (seen on a "Kliniva" deal). Founder must top up (Anthropic Console → Plans & Billing). Check first with
   `vercel logs --environment production --since 1h --query "credit balance"`.

## Open PRs
None from the financials work — everything below is merged.

## Recently shipped (all on `main`)
- **Smooth Flows** user-flow fixes — Batch 1 (#158), Batch 0 (#160), Batch 2 onboarding/invites/auth (#170).
  List: [`docs/USERFLOW-SMOOTHING-TODO.md`](docs/USERFLOW-SMOOTHING-TODO.md).
- **Financials fix plan** from Pushkar's Strong Ready Mix (SRM) test — every item A1–F1:
  periods/growth/EBITDA/signs/queue/P&L layout/model base (#163), real statements beat valuation models +
  canonical periods + account parents (#164), cash-flow red flags (#165), customer concentration from the CIM (#166),
  every P&L line + Low/Base/High scenarios + working capital/capex/debt (#169, carrying #167 + #168).
  Plan + notes: [`docs/FINANCIALS-FIX-PLAN.md`](docs/FINANCIALS-FIX-PLAN.md), [`docs/FINANCIALS-INVESTIGATION-NOTES.md`](docs/FINANCIALS-INVESTIGATION-NOTES.md).
- **Financials Phase G — post-SRM hardening (G1–G16)**, from three audits after A–F (plan: FINANCIALS-FIX-PLAN.md → Phase G):
  - **#173**: the model .xlsx carries a computed value for every formula, so it no longer opens blank in Protected View or previews. QA guide: `docs/MODEL-EXPORT-TESTING-GUIDE.md`.
  - **#181 (A)**:
    - entry multiple vs deal-record EBITDA mismatch → 5× plus a warning;
    - bottom-up EBITDA strips other income / expense;
    - nested cash-flow signs;
    - revenue per employee divides by headcount.
  - **#182 (B)**:
    - provider rejections (out of credit) fail extraction with the reason instead of "no financial data";
    - no placeholder AI insights;
    - Analysis / Build model panel show real reasons;
    - model route DB errors are explicit.
  - **#183 (C)**: one active row per canonical period (dedup, conflict resolution, DB index), and analysis uses one currency.
  - **#184 (D1)**: Low/High margin delta through Fixed costs; "summary" names; model always in millions.
  - **#185 (D2)**: fiscal year-end hint for bare "FY2025"; restatements win; the fast deal read's units are re-checked in code.
- **Financials Phase H — model extras while AI credit is out** (founder's pick, 3 Oct 2026; plan: FINANCIALS-FIX-PLAN.md → Phase H):
  - **#188 (H1)**: a parity test checks every cached workbook value against the live preview (`projectModel`/`summariseCase`). Found and fixed a real bug: `INDEX` over another sheet's range cached as 0, so exported-model previews showed exit EV 0 / IRR "n/a" until opened in Excel with editing enabled.
  - **#189 (H2)**: a revolving credit facility — off by default (commitment 0). Draws only to hold minimum cash, repaid first from spare cash before the sweep, interest on the opening drawn balance + fee on the undrawn commitment (no circularity).
  - **#191 (H3)**: an integrated balance sheet with a balance check. Entry uses a goodwill plug (founder's choice): goodwill = entry EV − net working capital − PP&E − other net operating assets bought; fees expensed at close; no dividends during the hold. New `Balance Sheet` sheet in the workbook + a read-only panel section with a "Balances" / "Check off by …" badge.
  - **H4 (per-account label/order)** is the only item left in Phase H — held until AI credit is back, since it needs an extraction schema change.
- Earlier the same week: token/cost work (#145, #149, #150, #154–#156), uploads (#151), bugs (#152), icon font (#153).

## Migrations
**Pending (founder runs, in this order)** — from #183, steps + verify query in [`docs/PENDING-MIGRATIONS.md`](docs/PENDING-MIGRATIONS.md):
1. `cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run`, then without the flag.
2. `apps/api/financials-period-key-unique-migration.sql` in the Supabase SQL Editor (refuses to run before step 1).
3. Verify query → expect 1, 0, 0.
The app works before and after; the SQL cleans up existing duplicate periods and adds the guard index.

## Waiting on the founder
- Top up Anthropic (and OpenAI, or keep moving features to Claude).
- With the team's OK: **Re-extract** the SRM deal; Pushkar re-tests with his document.
- Team decision: SRM FY2024 EBITDA — $2.21M (from the P&L) vs $6.1M (deal record).
- #170 decisions taken with defaults: users in another org can't be invited (409); **Analyst = view-only** (consider MEMBER);
  founders can't invite Admins; only admin/founder can change an existing firm profile.
- Ops checklist: [`docs/PENDING-OPS-CHECKLIST.md`](docs/PENDING-OPS-CHECKLIST.md) — Google OAuth keys in Vercel (Gmail/Google
  connect 500s), delete `Antropic_api_avise`, set `ANTHROPIC_ADMIN_KEY`, revoke keys pasted in chat, test invite email with a
  real address, rotate the QA account password after testing.

## What's next (engineering)
1. After credit is back:
   - Re-run the live QA checks that failed only on credit: Excel re-extract on "Northwind Cold Chain", PDF upload, model entry/IRR, data-room insights.
   - Check the Phase G warnings show (Build model panel, Analysis currency note) and the Phase H Balance Sheet section renders and balances on a real deal.
   - Then re-extract SRM and have Pushkar re-test.
   - While credit is still out, #182 is verifiable: extraction should say the AI provider is out of credits, not "no financial data".
2. **Financials H4 / PR E — headcount extraction + per-account label/order** (founder's choice; G17/H4 in the plan). Held until credit is back, because both change the extraction prompt and bump `EXTRACTION_SCHEMA_VERSION`. Founder's design choices already recorded: headcount extracted (not deferred); labels/order stored as `<key>_label`/`<key>_order` inside `lineItems` (no migration), not a separate `lineItemMeta` column.
3. Smooth Flows **Batch 3** (stop losing work) → **Batch 4** (pagination, extraction status, public large uploads, mobile nav, shared Dialog).
4. Financials deferred items remaining: none — integrated BS, balance check and revolver all shipped in Phase H (#188–#191).

## Testing on production
QA login `qa.tester@example.com` (ADMIN) in its own org **"Avise QA Test Org"**; password in the session scratchpad
(`qa-creds.txt`) or reset via Supabase admin API. `@example.com` never receives mail. Test data: deals "Northwind Cold Chain",
"QA-Room", "QA-Dash-Check"; contact; NDA template; memo; invitee `qa.invitee1@example.com`. Drive it with `playwright-cli`.

## Gotchas learned this week
- **`apps/api/scripts/` is gitignored** (`.gitignore` rule `scripts/`) — new scripts need `git add -f`.
- **Stacked PRs:** merging a child PR after its base already merged lands it on the dead base branch, not `main`
  (happened to #167/#168 → re-opened as #169). Merge bottom-up and retarget to `main` before merging. CI (`pr.yml`) only runs on
  PRs **into `main`**.
- **Worktrees** need `packages/shared` built and `node_modules/@ai-crm/shared` symlinked to the worktree copy, or tests use the
  main checkout's stale shared package.
- The main checkout (`/Users/ganesh/AI CRM`) sits on an old branch — always work and audit from a fresh `origin/main` worktree.
- Vercel's "Account is blocked" PR status is usually transient (concurrent builds); check `vercel ls` before worrying.
- Vitest 4: a throwing `vi.fn` behind a route's dynamic `import()` can fail a test even when caught — use plain functions.
- Automated production DB reads/writes from Claude Code are blocked by the safety classifier; give the founder paste-ready SQL
  plus one combined verification query instead.
- **ExcelJS drops a cached formula result of exactly `0`** in its `cell.value` getter/setter (truthy copy). Write results via
  `cell.model.result`, and test the raw sheet XML, not `cell.value` (`dealModel/workbook/calc.ts`).
- **fast-formula-parser:**
  - A parser instance is not reentrant; use one instance per recursion depth (see `calc.ts`).
  - `CHOOSE` / `INDEX` / `IF` get a leading context argument even when overridden.
- **Two PRs that both add a top entry to `PROGRESS.md` conflict.** Rebase the second onto `main`, keep both entries, newest first.
- **`apps/web-next` icon-font test scans for icon names.** Any new Material icon must be in `src/lib/iconFont.ts`, and
  string literals inside `material-symbols-outlined` spans count as icon names.
- **fast-formula-parser's `INDEX` loses the sheet** when it resolves a range reference, so `INDEX(OtherSheet!C5:G5,1,n)` reads the
  *formula's own* sheet instead — silently caches as 0/blank. `calc.ts` overrides `INDEX` the same way it already overrides
  `CHOOSE`/`MATCH`, resolving the range through the sheet-aware lookup. Any new cross-sheet `INDEX`/lookup formula should be
  covered by `tests/deal-model-parity.test.ts` (workbook vs. live-preview numbers), not just a formula-shape test — that's
  exactly what caught this one.
- **Merging own PRs when green is authorized** (founder, 3 Oct 2026, while away) — full CI + local `apps/api` + `apps/web-next`
  suites green first, `gh pr merge --merge --admin` (branch protection needs an approving review; admin bypasses it on purpose).
  Start the next PR from fresh `origin/main` each time.
- **A PR can go from green to `CONFLICTING`/`DIRTY` between opening and merging** if another PR merges into `main` first
  (happened between #189 and #190). Re-fetch and check `gh pr view <n> --json mergeable,mergeStateStatus` right before merging,
  not just when CI first passes. If a rebase tries to replay a branch's own prior commits (already on `main` under a different
  merge-commit SHA) and conflicts, don't fight it — diff the branch's unique changes against its old base
  (`git diff <old-base> <branch-tip> -- apps packages`), branch fresh off `origin/main`, and re-apply the diff instead.
