# QA report 1 Oct 2026 (Dev Shah) — triage and fix plan

Source: *Avise Complete QA Test Report*, 1 Oct 2026 (27 items). Every item below was traced in the code on `main`
@ `637ca605` (2 Oct 2026), and the cause was confirmed at the file:line given. Paths: `A/` = `apps/api/src/`, `W/` = `apps/web-next/src/`.
Sizes: **S** ≤ ½ day · **M** 1–2 days · **L** 3+ days.

## Summary

| # | Item | Verdict | Owner | Size |
|---|---|---|---|---|
| 7, 15, 17, 24 | AI features fail | **Ops**: Anthropic/OpenAI credit is exhausted | Founder | — |
| 14 | Raw Anthropic error on the scorecard | **Code**: the scorecard route bypasses the #171 error classifier | Dev | S |
| 6 | Gmail / Google / Granola "unexpected error" | **Ops** (Google env vars) **+ code** (the real reason is hidden) | Founder + Dev | S |
| 10 | Tasks don't save | **Code**: create needs `DEAL_ASSIGN`, which members don't have | Dev | S |
| 19 | Downloads missing from the activity log | **Code**: written to `AuditLog`, but the feed reads `Activity` | Dev | S |
| 25a | Shared page doesn't scroll | **Code**: the root `body` has `overflow-hidden`, and the portal has no scroll wrapper | Dev | S |
| 25b | Share views never update | **Code**: the view insert is fire-and-forget, and Vercel freezes the function | Dev | S |
| 11 | Active sessions empty | **Ops** (`auth` schema) **+ 2 code bugs** | Founder + Dev | S |
| 13 | Markdown in Firm Context | **Code**: the prompt doesn't forbid markdown; nothing strips it | Dev | S |
| 12 | 6 docs took 2m44s | **Code**: 2-at-a-time queue; progress only per round | Dev | S–M |
| 9 | SSO button does nothing | **Already fixed** on `main` (button hidden). Check prod runs the latest deploy | — | — |
| 16 | Deactivate account is a stub | **Code**: confirm only shows a toast; no endpoint; `isActive` not enforced | Dev | S (hide) / M (build) |
| 21 | Notion / OneDrive / Airtable / Xero / SharePoint | **Not built**: document the CSV workaround | Docs | S |
| 4 | Editable bulk invite preview | **Feature** (needs an API change for the deal column) | Dev | M |
| 25c | Shared page redesign | **Feature** | Dev | M |
| 23 | Kondo / LinkedIn Deal Finder | **Feature**: new integration; blocked on #6 for testing | Dev | L |

Passed (no action): #1, #2, #3, #5, #8, #18, #20, #22, #26.

---

## Ops — founder actions (no code)

- [ ] **Top up Anthropic (and OpenAI)**. This unblocks #7, #14, #15, #17, #24 and all of Phase 3 / 5 / 9 testing.
- [ ] **OPS-8: Google OAuth env in Vercel prod**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, and `OAUTH_STATE_SECRET` (≥ 32 chars).
  Also register `${APP_URL}/api/integrations/{gmail,google_calendar}/callback` in the Google Cloud console, and publish the
  OAuth app (out of "testing"). Without `APP_URL`, the redirect URI falls back to `localhost:3001`.
- [ ] **Granola**: confirm `DATA_ENCRYPTION_KEY` is set in prod, and that the tester's Granola plan includes API access (Business/Enterprise).
- [ ] **OPS-2: Active sessions**: expose the `auth` schema to PostgREST, **or** run the RPC migration this PR adds (preferred, see #11).

---

## Batch 1 — this PR (P0 / P1 code fixes, all S)

### #10 Tasks don't save (P0)
- **Cause**: `POST /api/tasks` uses `requirePermission(PERMISSIONS.DEAL_ASSIGN)` (`A/routes/tasks.ts:84`). Only ADMIN / PARTNER /
  PRINCIPAL / OPS have it (`A/middleware/rbac.ts:91-150`). MEMBER (the invite default), ASSOCIATE, VP and ANALYST get a 403.
  The dashboard "My Tasks" box inserts optimistically and rolls back on error (`W/app/(app)/dashboard/use-dashboard-data.ts:162-176`),
  which is the "registers then deregisters" the tester saw. The AI assistant's `create_task` hits the same gate.
- **Fix**: anyone who can view deals can create a task **for themselves**. `DEAL_ASSIGN` is required only when `assignedTo` is
  someone else. The dashboard shows the API's error instead of silently rolling back.
- **Done when**: a MEMBER adds a task on the dashboard, and it survives a reload.

### #14 Raw provider errors shown to users
- **Cause**: `A/routes/deals-scorecard.ts:29` returns `Failed to score deal: ${error.message}` and skips
  `classifyAIErrorObject` (`A/utils/aiErrors.ts:122`, added in #171). The same raw-message pattern is in `deal-import.ts:92, :327`,
  `financials-extraction.ts:510, :652`, `contacts.ts:321, :348` and `outreach.ts:149`. `firm-context.ts:45`, `deals-teasers.ts:66` and
  `firm-teaser.ts:141, :162` put the raw text in `message`.
- **Fix**: route all of them through the classifier ("AI is temporarily unavailable — try again", or the out-of-credit message), and keep the raw text in logs only.
- **Alerting**: no balance API exists, so log one `warn` with tag `ai_quota_exhausted` on the first quota rejection per
  instance (`A/utils/aiErrors.ts`), for a Vercel log alert. A Slack/email hook is a follow-up.

### #6 Integrations "unexpected error" (code part)
- **Cause**: missing Google env throws plain `Error`s (`gmail/client.ts:26`, `googleCalendar/client.ts:35`, `_platform/oauth.ts:15-18`).
  In production `errorHandler.ts:228-232` turns them into "An unexpected error occurred", which the UI shows as-is
  (`W/app/(app)/settings/IntegrationsSection.tsx:124-129`). Granola: only a 401/403 from `validateKey` reaches the UI. Any other
  upstream status, a network error, or a missing `DATA_ENCRYPTION_KEY` becomes a generic 500 (`granola/client.ts:49-58`, `integrations.ts:93`).
- **Fix**: throw `AppError(503, 'INTEGRATION_NOT_CONFIGURED', "Google sign-in isn't set up on this server yet")`. Return Granola's real
  status / message as a 400/502. Pass a reason code through the OAuth callback redirect (`integrations-public.ts:52-55`).

### #19 Downloads missing from the activity log
- **Cause**: `GET /documents/:id/download` writes only `AuditLog` (`A/routes/documents.ts:366, :392`), with no `dealId`. The deal
  activity feed reads the `Activity` table (`A/routes/activities.ts:44-56`). Portal downloads log nothing (`A/routes/portal.ts:222-246`).
- **Fix**: also insert `Activity {dealId, type: 'DOCUMENT_DOWNLOADED'}` (select `dealId` at `documents.ts:331`). Log portal
  downloads (as "downloaded via share link"). Add the activity type + icon (`activities.ts:22-30`, `deal-overview.tsx:393-403`).

### #25a Shared page doesn't scroll
- **Cause**: `W/app/layout.tsx:48` sets `<body className="h-full … overflow-hidden">` for the app shell. `/portal` has no layout, and
  `portal-view.tsx:116` is only `min-h-screen`, so content past the viewport is clipped.
- **Fix**: add `W/app/portal/layout.tsx` with the same scroll wrapper as `(auth)/layout.tsx:16`. Also check `/upload/[token]`.

### #25b Share dialog view counts never update
- **Cause**: `A/routes/portal.ts:123` calls `void recordViewAndNotify(...)` and responds. On Vercel the function is frozen once the
  response is sent, so the `DealShareView` insert is killed. The dialog side is fine (`ShareDealModal.tsx:50-60` refetches on open).
- **Fix**: `await` the view insert, and send the first-view email via `runInBackground` (`A/utils/background.ts`).

### #11 Active sessions empty
- **Cause**: the endpoint queries `auth.sessions` through PostgREST (`A/routes/auth-sessions.ts:36-45`). With `auth` not exposed,
  the error is swallowed and it returns `200 []` (`:46-52, :79`), so the UI shows "No other active sessions" instead of
  "unavailable" (`SecuritySection.sessions.tsx:60, 117-121` expects a 501). The current session is never flagged:
  `req.sessionId` (`:68`) is never set.
- **Fix**: a `SECURITY DEFINER` RPC `list_my_sessions(uid)` (migration in this PR) so no schema exposure is needed. Return
  `501` / `degraded` on failure. Set `req.sessionId` from the JWT `session_id` claim in `authMiddleware`.

### #13 Markdown in Firm Context
- **Cause**: the prompt (`A/services/firmContextService.ts:327`) asks for "prose" but not "no markdown", and feeds inputs as
  `### headings` (`:323-325`). It's saved raw (`:352, :376`) into a plain `<textarea>` (`FirmContextSection.tsx:200`). It also uses
  `toLocaleDateString` instead of `getTodayIso()` (`:321`), against the CLAUDE.md rule.
- **Fix**: add the instruction "plain text only, no markdown"; strip markdown before saving; use `getTodayIso()`.

### #16 Account deactivation stub
- **Current**: `W/app/(app)/settings/page.tsx:366-379` → confirm → toast "not available" (`:217`). There's no endpoint, and
  `authMiddleware` never checks `User.isActive`, so even admin-deactivated users can still sign in.
- **Fix in this PR**: hide the button, and enforce `isActive` in `authMiddleware` (a real security gap).
  Self-deactivation (confirm → deactivate → revoke API keys → sign out → data handling) is a follow-up.

### #12 Extraction speed (6 docs, 2m44s)
- **Cause**: the multi-doc queue runs `MAX_CONCURRENT_PER_ORG = 2` (`A/services/agents/financialAgent/concurrency.ts:7`), which
  means 3 waves for 6 docs. The UI's "n/N documents" only updates when a whole request round finishes (`deal-financials-extract-all.ts:70`).
- **Fix in this PR**: raise the per-request concurrency to 4. Per-document progress (poll statement rows while extracting) is a follow-up.
  Watch: function memory with 4 large workbooks in flight, and the Anthropic rate limit (429s are already classified).

---

## Batch 2 — features (separate PRs)

- **#4 Bulk invite preview**: `W/components/layout/InviteTeamModal.csv.tsx` (read-only table at `:226-264`; parse in
  `.csv.parse.ts`). Needed:
  - editable cells
  - include/skip checkbox + select-all
  - in-file duplicate and missing-field validation inline
  - quoted-comma CSV parsing
  - send only checked rows
  - API: `bulkInviteSchema` (`A/routes/invitations.ts:22-25`) must accept a per-row deal/workspace (today the Deal column is parsed and dropped). **M**
- **#25c Shared page redesign**: header (firm, deal, **stage badge** — `stage` is already in the payload), metric cards
  (Revenue, EBITDA, **Margin**, Deal size), tabs by share toggles, responsive, "Shared by {firm} · {timestamp}" footer.
  The whitelist is safe (no team / thesis / scorecard / notes); memo section content is shown verbatim, so call that out in the dialog. **M**
- **#23 Kondo (LinkedIn Deal Finder)**: settings card (API key), a bounded scan of recent LinkedIn chats, and candidates into the
  existing accept/dismiss UI. Needs Kondo API docs/credentials; testable only after #6. **L**
- **#21**: add the CSV-import workaround for Notion / OneDrive / Airtable / Xero / SharePoint to onboarding + help docs. **S**

## Retest after deploy
Credits topped up → Dev retests Phase 3 / 5 / 7 / 9. Then this batch: #10 (as a MEMBER), #19, #25a, #25b, #11, #13, #14, #6 messages.
Confirm #9 on prod (latest deploy).
