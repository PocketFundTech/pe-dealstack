# CONTEXT — where things stand (updated 6 Oct 2026)

The one-page handoff for whoever picks up next (person or agent). The detailed day-by-day log is
[`PROGRESS.md`](PROGRESS.md); working rules are in [`CLAUDE.md`](CLAUDE.md).

## Product in one line
**Avise** — AI CRM for private-equity deal teams. Monorepo: Express API (`apps/api`), Next.js 16 web app
(`apps/web-next`, the live frontend), legacy `apps/web`, shared package `packages/shared`. Supabase Postgres.
One Vercel project `pocket-funds-projects/pe-dealstack` serves `deals.avise.io` and `app.avise.io`.

## 🔴 Blocking right now
1. **AI credit.** Anthropic and OpenAI have both run out more than once (28 Sep, 1 Oct, 5 Oct). Every AI feature fails while
   either is out. Check first: `vercel logs --environment production --since 1h --query "ai_quota_exhausted"`.
2. **Google sign-in on production.** Gmail / Google connect needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `APP_URL=https://app.avise.io`, `OAUTH_STATE_SECRET` and `CRON_SECRET` in Vercel (someone with Vercel access), then a
   redeploy. Works locally already. The Google app is in Testing mode (≤100 named users, reconnect every 7 days).
3. **GitHub Actions runners.** PR checks (#203, #206, #208) were cancelled after 15 min with "job was not acquired by
   Runner" — not a code failure. Re-run; if it repeats, check the org's Actions minutes / billing.

**AI on click only (branch `feat/ai-on-click-only`, 8 Oct).** To stretch the remaining credit, AI runs only when someone
clicks for it. Crons, webhooks, the scheduled Gmail/Granola/Outlook sync, post-upload extraction, scoring after financial
extract, contact auto-enrich, the criteria-save re-score and onboarding deep research all skip their AI step unless the Vercel env
var `AI_BACKGROUND_JOBS=on`. The page-load triggers are now buttons, and they ignore `AI_BACKGROUND_JOBS`: deal Analysis → AI
Insights, onboarding red flags, ingest follow-up questions, memo Generate All, and onboarding firm auto-fill. Helpers live in
`apps/api/src/services/usage/aiOnDemand.ts`.

Everything that needs an outside account (AI, Google, Microsoft, Resend, Supabase SMTP, Dropbox Sign, Kondo) is mapped in
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).

## Open PRs (newest first)
- **#208** QA report 6 Oct — memo, UI, branding fixes.
- **#207** "Generate teasers" button in the deal's empty state (goes with #206).
- **#204** Granola could never connect (`validateKey` hit a nonexistent endpoint) — merge soon.
- **#203** QA follow-ups:
  - no duplicate deals from text / URL / AI ingest / bulk / email / Gmail;
  - no raw DB errors from contacts / outreach;
  - Settings toggle for Gmail auto-create;
  - self-deactivation + Reactivate in Settings → Team;
  - teasers on demand on every intake path (finishes #206).
- **#196** financials unit-scale mismatch checks.

## Recently shipped (on `main`)
- **#206** upload runs only the deal summary; scoring, teasers, financials and discrepancy checks are buttons.
- **#205** ingest AI spend tagged with `dealId` (per-deal cost). **#202** cheapest model that holds quality on every non-Fable path.
- **#201** "Unknown Company" placeholder no longer masks a deal's real name.
- **#200** 5 Oct testing doc: duplicate deals on upload, "AI analysed" wording, layout, refresh, Clear chat, doc-request email
  sender/Reply-To, provider-named AI-credit errors; `docs/DEPENDENCIES.md`.
- **#178 / #174** 1 Oct QA report (27 items): tasks for every role but Viewer, `isActive` enforced, extraction concurrency 4,
  portal redesign + view-count dedupe, bulk invite preview, live extraction progress, per-deal chat history.
- **Financials** A–F (#163–#169), Phase G (#173, #181–#185), Phase H (#188–#191) — plan in
  [`docs/FINANCIALS-FIX-PLAN.md`](docs/FINANCIALS-FIX-PLAN.md). H4 (per-account label/order) waits for AI credit.

## Migrations
All migrations from #174 / #178 / #200 have been run. Still check [`docs/PENDING-MIGRATIONS.md`](docs/PENDING-MIGRATIONS.md)
for the #183 period-key backfill + unique index (founder runs; the app works before and after).

## Waiting on the founder / ops
- Top up Anthropic **and** OpenAI; delete the misspelled `Antropic_api_avise` Vercel var.
- Vercel env for Google (above); Microsoft (`MS_*`), Dropbox Sign key, Kondo API docs.
- Email: Resend domain (SPF/DKIM/DMARC) for app email; **Supabase custom SMTP before real sign-ups** — the built-in sender
  only delivers to project-team addresses. Supabase URL Configuration: Site URL + `/reset-password` redirects.
- Google publishing: domain verification, Google-user-data section in the privacy policy, and the paid CASA assessment that
  `gmail.readonly` needs.
- After credit is back: re-extract SRM; Pushkar and Dev re-test.

## What's next (engineering)
1. Merge #203 / #204 / #207 / #208 once CI runs and they're tested.
2. Kondo / LinkedIn Deal Finder (1 Oct #23) — blocked on API docs.
3. Optional: split Google scopes so Calendar / Drive / Docs can be published without the Gmail assessment.
4. Re-enable NDA signature push detection on the verified domain (`docs/nda-signature-detection-setup.md`).
5. Financials H4 / headcount extraction once credit is back.

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
