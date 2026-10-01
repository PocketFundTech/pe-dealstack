# CONTEXT — where things stand (updated 2 Oct 2026, 00:30 IST)

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
| PR | What | State |
|---|---|---|
| #171 | AI out-of-credit errors say so (shared classifier); crore/lakh table headers on deal reads; data room uses app-wide toasts; period-key backfill script; this file + doc updates | CI green, ready to merge |

## Recently shipped (all on `main`)
- **Smooth Flows** user-flow fixes — Batch 1 (#158), Batch 0 (#160), Batch 2 onboarding/invites/auth (#170).
  List: [`docs/USERFLOW-SMOOTHING-TODO.md`](docs/USERFLOW-SMOOTHING-TODO.md).
- **Financials fix plan** from Pushkar's Strong Ready Mix (SRM) test — every item A1–F1:
  periods/growth/EBITDA/signs/queue/P&L layout/model base (#163), real statements beat valuation models +
  canonical periods + account parents (#164), cash-flow red flags (#165), customer concentration from the CIM (#166),
  every P&L line + Low/Base/High scenarios + working capital/capex/debt (#169, carrying #167 + #168).
  Plan + notes: [`docs/FINANCIALS-FIX-PLAN.md`](docs/FINANCIALS-FIX-PLAN.md), [`docs/FINANCIALS-INVESTIGATION-NOTES.md`](docs/FINANCIALS-INVESTIGATION-NOTES.md).
- Earlier the same week: token/cost work (#145, #149, #150, #154–#156), uploads (#151), bugs (#152), icon font (#153).

## Migrations
All pending SQL was run and verified by the founder on 2026-10-02: `usage-cost-accuracy-migration.sql`,
`deal-stage-cleanup.sql`, `financials-source-period-migration.sql`. Nothing pending.
Optional: `cd apps/api && npx tsx scripts/backfill-statement-period-keys.ts --dry-run` then without the flag.

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
1. After credit is back: re-run the live QA checks that failed only on credit — Excel re-extract on "Northwind Cold Chain",
   PDF upload, model entry/IRR, data-room insights.
2. Smooth Flows **Batch 3** (stop losing work) → **Batch 4** (pagination, extraction status, public large uploads, mobile nav, shared Dialog).
3. Financials deferred items: integrated balance sheet + balance check, revolver, per-account source label/row order.

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
