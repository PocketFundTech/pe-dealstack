# Security & Trust — Master TODO

> **Last updated:** 2026-05-07 (after PR #30, #31, #32)
> **Audience:** any developer picking up the next slice of security/trust work.
> **Read first:** [`docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`](SECURITY-TRUST-DEVELOPER-HANDOFF.md) for context on what already shipped.

This is the single source of truth for what's left. Pick a priority, branch off `main`, ship a focused PR.

---

## 🚨 Outstanding ops items (block features from being "fully done")

| # | What | Owner | Blocks |
|---|---|---|---|
| **OPS-1** | Set `POCKET_FUND_STAFF_EMAILS` env var on Vercel (production scope, comma-separated staff emails) | Founder | PR #30 staff access log being **effective** — without it the middleware no-ops cleanly so the feature is dead-effective until set |
| **OPS-2** | Expose Supabase `auth` schema in PostgREST (Project Settings → API → Exposed schemas) | Founder | Active sessions UI shows real data instead of "Unavailable"; security dashboard's `activeSessions` metric becomes non-null |

Until these are done, the relevant features ship code-complete but are limited in customer-visible value. Re-check at every demo prep.

---

## Where we stand right now (2026-05-07)

### ✅ Shipped to production (PR #9 + #28)

Live at `https://lmmos.ai/`:

- **Public Trust Center** at `/security` — hero, encryption, tenant isolation, AI handling, 9-vendor sub-processor table, compliance roadmap, contact
- **Security overview PDF** at `/assets/pocket-fund-security-overview.pdf`
- **Footer + auth-page links** to `/security` from landing, login, signup
- **In-app Settings → Security panel additions** — data home, encryption status, isolation badge, AI handling, action buttons (download PDF / sub-processors / DPA mailto)
- **Active sessions list + revoke** (graceful degradation when Supabase auth schema not exposed)
- **Live tenant isolation test endpoint + button** — admin clicks, runs 8 cross-org access checks in <3s, terminal-style output
- **Audit log filter row + CSV export** in Admin Dashboard activity feed (date / action type / resource type filters, admin-only)
- **Org-wide 2FA enforcement** — `Organization.requireMFA` column + middleware + admin toggle in Settings → Team + frontend redirect on 403
- **Whitepaper rate-limit numbers fixed** — verified against `app.ts:141-167` (was 200/15min, actual 600/15min general / 10/min AI / 30/min writes)
- **Documentation** — handoff guide, executive summary, implementation plan, Phase 1.5 design spec + plan

### ⚠️ Critical gap (the most-asked demo question)

**"Which Pocket Fund employees accessed my data?"**

This is the #1 unanswered prospect question. The `/security` page is *marketing* — it makes claims. Customers logged in have access to *their team's* audit log. But there's no in-product proof that **Pocket Fund staff has not (or has) accessed their data**. That's the next thing to build.

---

## Priority 1 — Customer-visible Pocket Fund staff access log

**Effort:** ~3 dev days
**Phase 1.5 component:** B1
**Spec:** [`docs/superpowers/specs/2026-05-05-trust-without-soc2-design.md`](superpowers/specs/2026-05-05-trust-without-soc2-design.md) → "B1 — Customer-visible Pocket Fund staff access log"
**Plan:** [`docs/superpowers/plans/2026-05-05-trust-without-soc2-implementation.md`](superpowers/plans/2026-05-05-trust-without-soc2-implementation.md) → Tasks 1, 2, 3, 6

### What it does

Every time a Pocket Fund employee (anyone whose email is in `POCKET_FUND_STAFF_EMAILS` env var) accesses a customer's data via the API, an audit event is written into THAT customer's audit log with action `STAFF_ACCESS`. The customer can see this in Settings → Security:

> *"Pocket Fund staff has accessed your data **0 times** in the last 90 days."*

When non-zero, the section lists each access: timestamp, employee email, route, method.

### Why it matters

This is THE demo killer. Sales line:

> *"You're worried about my engineers reading your pipeline? Click here. Empty. The moment we touch your data, it shows up here in real-time."*

No PE-CRM competitor offers this.

### Tasks (from the implementation plan)

- [ ] **T1**: Migration — add `staffAccessWebhookUrl`, `staffAccessNotifyEmail` columns to `Organization` (idempotent SQL)
- [ ] **T2**: Add `STAFF_ACCESS`, `STAFF_WEBHOOK_TEST` to `AUDIT_ACTIONS` in `apps/api/src/services/auditLog.ts`
- [ ] **T3**: Build `apps/api/src/middleware/staffAccessLogger.ts`
  - Reads `POCKET_FUND_STAFF_EMAILS` env var (comma-separated list)
  - On every request that hits an instrumented route (`/api/deals`, `/api/documents`, `/api/folders`, `/api/financials`, `/api/memos`, `/api/contacts`, `/api/companies`, `/api/audit`)
  - If `req.user.email` is in the staff list AND request resolves to a customer org (different from staff's home org) → write `STAFF_ACCESS` event to that customer's audit log
  - Best-effort: never blocks the request; failures swallowed
  - Wired into the global middleware chain after `authMiddleware` + `orgMiddleware`
  - Includes vitest tests with mocked Supabase
- [ ] **T6**: Frontend rendering in `apps/web-next/src/app/(app)/settings/SecuritySection.trust.tsx` (or new sibling component)
  - Fetch `GET /api/audit?action=STAFF_ACCESS&limit=10`
  - Empty state: large green checkmark + "Pocket Fund staff has accessed your data **0 times** in the last 90 days."
  - Non-empty: count + list of recent entries (timestamp, email, route)

### Acceptance

- A user whose email is in `POCKET_FUND_STAFF_EMAILS` hits `GET /api/deals` for a customer org → that customer's audit log gets a `STAFF_ACCESS` row with the staff's email + route
- Settings → Security shows the empty state for orgs with no staff access
- Non-staff users hitting routes do NOT generate `STAFF_ACCESS` events
- Staff hitting their OWN org's data does NOT generate events (only cross-org access)
- Tests pass

### Deployment

- Apply migration via Supabase SQL Editor (column add is idempotent + safe)
- Set `POCKET_FUND_STAFF_EMAILS` env var on Vercel (production)
- Deploy via merged PR

### Caveat

Without an explicit "staff impersonation" flow (where staff toggle into a customer org), this middleware fires only when staff happen to be members of the customer's org — which won't happen in practice. v1 ships the middleware in place for forward compatibility; the impersonation pattern is a Priority 1.5 follow-up.

---

## Priority 2 — Slack/email webhook on staff access

**Effort:** ~1 dev day after Priority 1
**Phase 1.5 component:** B5
**Plan:** Tasks 4, 5, 7

### What it does

Customer admin pastes a Slack incoming webhook URL OR an email address into Settings → Security. When a `STAFF_ACCESS` event fires, the configured webhook gets a real-time payload AND/OR an email goes out via Resend.

Demo line:

> *"Want your security team to get a Slack ping the moment any Pocket Fund staff touches your data? Drop a webhook URL. They'll know before we finish the read."*

### Tasks

- [ ] **T4**: `apps/api/src/services/staffAccessNotifier.ts` — fires webhook + email, best-effort, swallowed errors
- [ ] **T5**: `apps/api/src/routes/org-webhook.ts` — `PATCH /api/organizations/me/staff-access-webhook` to set/clear/test config
- [ ] **T7**: Frontend config UI in `SecuritySection` — three fields (webhook URL, notify email, enable toggle), "Save and test" button. On save, backend fires a test event automatically.

### Acceptance

- Customer can configure webhook URL + email
- Saving fires a test event to Slack ("This is a test from Pocket Fund.") and to email
- Real `STAFF_ACCESS` events trigger webhook + email within 5s
- Failed webhook delivery logged but doesn't crash the audit write
- Customer can clear the config

---

## Priority 3 — Self-serve "Delete all my data" button

**Effort:** ~2 dev days
**Phase 1.5 component:** B2
**Plan:** Tasks 8, 9, 10

### What it does

Settings → Security → "Delete organization data" — admin-only, requires typing org name + checking "I understand this is irreversible after 24 hours" → schedules deletion 24h out. Banner appears across the app. Cancel anytime in 24h. After 24h, Vercel cron executes the cascade delete, sets `isActive=false`, sends a deletion certificate email via Resend.

Demo line:

> *"This is your panic button. Whether you stop paying us or just change your mind, your data is gone in 24 hours. Want me to demo it on a test org right now?"*

### Tasks

- [ ] **T8**: `apps/api/src/routes/org-deletion.ts`
  - `POST /me/schedule-deletion` (admin)
  - `POST /me/cancel-deletion` (admin)
  - `POST /admin/internal/execute-pending-deletions` (cron-only, gated by `CRON_SECRET` header)
- [ ] **T9**: `vercel.json` cron entry pinging the executor hourly
- [ ] **T10**: Frontend
  - Deletion control in Settings → Security with red styling + 2-step confirm
  - Pending-deletion banner across all pages (when `org.deletionStatus === 'PENDING'`)
- [ ] **Migration**: add `Organization.deletionScheduledAt`, `Organization.deletionStatus` columns (already in T1 of Priority 1's migration if combined)

### Cascade delete order

```
AuditLog → ChatMessage / Conversation → Memo / MemoSection
→ DocumentChunk → Document / Folder / FolderInsight
→ FinancialStatement → Activity → DealTeamMember → Deal
→ Task → Notification → Contact → Company → Invitation
→ User (where organizationId = X)
→ Organization (set isActive=false; tombstone, do NOT delete row)
```

Wrap in a transaction if Supabase JS supports it; else use an RPC function for atomicity.

### Acceptance

- Admin can schedule deletion only after typing org name correctly
- Banner appears across app when scheduled
- Cancel works during 24h grace period
- Cron executes 24h+ later, all org-scoped data deleted, certificate email sent
- Audit events: `ORG_DELETION_SCHEDULED`, `ORG_DELETION_CANCELLED`, `ORG_DELETION_EXECUTED`
- Non-admins get 403 on schedule/cancel

### Deployment

- Apply migration (deletion columns)
- Set `CRON_SECRET` env var on Vercel (random secret string)
- Deploy via merged PR

---

## Priority 4 — Trust onboarding sandbox tier

**Effort:** ~3 dev days
**Phase 1.5 component:** B3
**Plan:** Tasks 11, 12, 13

### What it does

New orgs default to `mode = 'SANDBOX'` and get pre-loaded with 3-5 synthetic deals (`apps/api/src/data/synthetic-deals.json`). Document upload is disabled in sandbox mode. Banner across app: *"Sandbox mode — these are demo deals. Graduate to production →"*. Admin clicks Graduate → confirmation → sandbox deals archived → mode flips to PRODUCTION → upload unlocked.

Demo line:

> *"On signup you don't have to upload anything real. We pre-load sample deals so you can play. Most prospects spend 1-2 weeks in sandbox before graduating. We'll never push you."*

### Tasks

- [ ] **T11**: `apps/api/src/data/synthetic-deals.json` — 3-5 anonymized deals with realistic financials
- [ ] **T12**: `apps/api/src/middleware/sandboxMode.ts` — `enforceProductionMode` middleware that returns 403 + `code: SANDBOX_MODE` when sandbox orgs hit production-only routes (`/api/documents-upload`, etc.). Plus signup hook that seeds synthetic deals on org creation.
- [ ] **T13**: `apps/api/src/routes/org-sandbox.ts` — `POST /me/graduate` (archive sandbox deals + flip mode), `POST /me/reset-sandbox` (re-seed, sandbox-only). Frontend interceptor in `auth.js` that catches `SANDBOX_MODE` and shows graduation modal. Sandbox banner in `layout.js`.
- [ ] **Migration**: `Organization.mode` column with backfill `mode = 'PRODUCTION'` for existing orgs (CRITICAL — without backfill, current customers lose upload access)

### Critical migration detail

```sql
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'SANDBOX'
    CHECK ("mode" IN ('SANDBOX', 'PRODUCTION'));

-- Backfill existing orgs to PRODUCTION; only NEW signups land in sandbox
UPDATE "Organization" SET "mode" = 'PRODUCTION'
  WHERE "mode" = 'SANDBOX' AND "createdAt" < NOW();
```

### Acceptance

- New signups land in sandbox with synthetic deals visible
- Document upload returns 403 + `SANDBOX_MODE` in sandbox mode
- Banner visible across app
- Graduate flow archives sandbox deals and flips mode
- After graduation, upload works normally
- Existing orgs are unaffected (mode = PRODUCTION)
- Audit events: `ORG_GRADUATED`, `SANDBOX_RESET`

---

## Priority 5 — One-click data export

**Effort:** ~1.5 dev days
**Phase 1.5 component:** B4
**Plan:** Tasks 14, 15

### What it does

Settings → Security → "Export all data". Click → backend builds a `.zip` containing CSVs for deals, documents (metadata + 24h-signed URLs), folders, memos, contacts, audit log + a `manifest.json` and `README.txt`. Uploads to Supabase Storage with 24h signed link, emails the link to the requester via Resend.

Demo line:

> *"You're not locked in. Click here, we email you a zip of everything in 15 minutes. Take it to a competitor. You always own your data."*

### Tasks

- [ ] **T14**: `apps/api/src/services/orgExporter.ts` — builds the zip using `jszip` (~120KB dep). `apps/api/src/routes/org-export.ts` — `POST /me/export` admin-or-equivalent, rate-limited 1/day per org.
- [ ] **T15**: Frontend "Export All Data" button in actions block. On click, POST `/me/export`, show toast "Email coming in 5-15 minutes."

### Acceptance

- Admin clicks → modal closes → email arrives within 15 min
- Zip contains expected files (verified via test fixture)
- Document URLs in the zip work and expire after 24h
- Non-admin gets 403
- Audit event: `ORG_DATA_EXPORTED`

---

## Priority 6 — Founder pledge section on /security

**Effort:** ~0.5 dev day
**Phase 1.5 component:** B6
**Plan:** Task 16

### What it does

Add a "Founder pledge" section to `apps/web-next/src/app/security/page.tsx` (or a sibling `security-pledge` page) with:

- Founder's name + title
- Specific commitments (data not sold/shared, not used for ML training, audit-logged staff access, 90-day sub-processor change notice, 72h breach notification, 30-day deletion on request)
- Date signed
- Mailto for any concerns

### Demo line

> *"Read the founder's pledge. He signs his name to this. If anything goes sideways, you have a name to call."*

### Acceptance

- Pledge visible on `/security`
- Linked from Settings → Security action buttons
- Date signed and visible

---

## Priority 7 — Production polish + ops items

These are smaller items that improve the existing shipped work. Pick them up in any order.

### 7.1 Configure Supabase `auth` schema exposure

**Effort:** 1 minute, no code
**Why:** Active sessions feature (`/api/auth/sessions`) currently degrades gracefully when the Supabase JS SDK doesn't expose `listUserSessions`. The fallback queries `auth.sessions` directly. For that to work, the `auth` schema must be in the PostgREST exposed-schemas list.

**Action:**
- Supabase Dashboard → Project Settings → API → "Exposed schemas" → add `auth`
- Verify in browser: log in to lmmos.ai → Settings → Security → "Active sessions" should show your current session, not "Session management unavailable"

### 7.2 Set up `POCKET_FUND_STAFF_EMAILS` env var (Priority 1 dependency)

**Effort:** 1 minute
**Action:**
- Vercel Dashboard → Project `pe-dealstack` → Settings → Environment Variables
- Add `POCKET_FUND_STAFF_EMAILS` = comma-separated list of staff Gmail addresses (e.g. `ganesh@pocket-fund.com,dev@pocket-fund.com`)
- Production scope only
- Trigger redeploy or wait for next push

### 7.3 Set up `CRON_SECRET` env var (Priority 3 dependency)

**Effort:** 2 minutes
**Action:**
- Generate a random secret: `openssl rand -hex 32`
- Vercel → Settings → Environment Variables → add `CRON_SECRET` (production only, encrypted)
- The cron job in `vercel.json` automatically passes this via `x-vercel-cron-secret` header to the executor endpoint
- Verify: `curl -X POST -H "x-cron-secret: WRONG" https://lmmos.ai/api/admin/internal/execute-pending-deletions` should return 403

### 7.4 Add `www.lmmos.ai` Vercel alias

**Effort:** 1 minute
**Why:** Currently `www.lmmos.ai/security` returns 404. Apex `lmmos.ai` works fine, but redirecting www → apex is standard practice.

**Action:**
- Vercel → Project `pe-dealstack` → Settings → Domains
- Add `www.lmmos.ai` → set up redirect to `lmmos.ai` (or vice versa, depending on canonical preference)
- Verify: `curl -I https://www.lmmos.ai/security` returns 200 or 301/308 redirect to apex

### 7.5 Confirm Google Gemini SOC 2 tier on Trust Center

**Effort:** 5 minutes
**Why:** Sub-processor table on `/security` lists Google as "SOC 2" while OpenAI / Anthropic / Vercel / Supabase show "SOC 2 Type II". If Gemini is actually Type II (most Google Cloud services are), upgrade the label.

**Action:**
- Verify via [Google Cloud compliance page](https://cloud.google.com/security/compliance)
- If Type II, update `apps/web-next/src/app/security/page.tsx` and `apps/web-next/public/assets/pocket-fund-security-overview.pdf` (regenerate via `apps/api/scripts/generate-security-pdf.ts`)

### 7.6 Build proper auth+org test harness

**Effort:** ~1 dev day
**Why:** PR #9 skipped automated tests for `/api/organizations/me`, MFA enforcement, audit export, sessions, and isolation test endpoints because the existing test files (`audit.test.ts`, `org-isolation.test.ts`) didn't fit the pattern. A simple `tests/helpers/testHarness.ts` with `createTestOrgAndUser`, `authHeader`, `seedAuditLogs` would unblock all five test files referenced in the implementation plan.

**Action:**
- Read existing patterns in `apps/api/tests/audit.test.ts` (mocked Supabase) and `apps/api/tests/org-isolation.test.ts` (live API)
- Build a minimal harness following the spec in [`docs/superpowers/plans/2026-05-01-security-trust-implementation.md`](superpowers/plans/2026-05-01-security-trust-implementation.md) Task 9 "Step 5: Tests"
- Backfill skipped tests for: `organizations.test.ts`, `org-mfa-enforcement.test.ts`, `audit-export.test.ts`, `auth-sessions.test.ts`, `admin-security.test.ts`

### 7.7 Optimize settingsSecurity → use `/api/organizations/me`

**Effort:** ~30 minutes
**Why:** Cosmetic — the in-app Settings → Security UI currently fetches `/api/users/me` (existing endpoint) for org info instead of `/api/organizations/me` (new endpoint built in PR #9). Works fine but the new endpoint is a cleaner contract.

**Action:**
- In `apps/web-next/src/app/(app)/settings/SecuritySection.trust.tsx` (or whichever file fetches org info)
- Switch from `api.get('/users/me')` to `api.get('/organizations/me')`
- Verify org name + ID still render correctly
- Drop the now-unused field extraction from the user response

---

## Priority 8 — Founder/ops workstream (NOT eng work)

These are NOT for the developer to build. Founder owns. Documenting here so the team has visibility.

| Item | Cost | Time | Notes |
|---|---|---|---|
| **DPA template** drafted by SaaS lawyer | $1-3K once | 1 week | Cooley / Gunderson / AngelList templates work fine. Once drafted, replace `mailto:DPA Request` fallback in Settings → Security and `/security` with `<a href="/assets/pocket-fund-dpa.pdf">View DPA</a>` |
| **Cyber insurance** ($1M coverage) | $5-10K/yr | 1 week | Coalition / At-Bay / Vouch. Once bound, add line to `/security`: "We carry $1M cyber-liability coverage via [Insurer]." |
| **Pre-filled SIG-Lite questionnaire** | $0 | 1 day | Save at `docs/security-questionnaires/SIG-Lite-2026.md`. Sales sends on request. |
| **Mutual NDA template** | $0 | 0.5 day | Save at `docs/legal/mutual-nda-template.pdf`. Sales sends before any first demo with sensitive content. |
| **Reference customer** (one PE firm willing to vouch publicly) | ~$0 | ongoing | Comp them with a free year if needed. Once secured, add quote + logo to `/security` and update sales decks. |

---

## Priority 9 — SOC 2 Type I (long-term)

**Effort:** 8-12 weeks calendar, ~10-20 dev hours total
**Cost:** $8-15K/yr for vendor (Vanta / Drata / Secureframe)

### Why eventually do this

For prospects above ~$500M AUM, SOC 2 is non-negotiable. The Phase 1.5 work (Priorities 1-6) buys time for sub-$500M prospects. SOC 2 unlocks the next tier.

### Action

- Engage Vanta / Drata / Secureframe — get sales call, pick vendor (~$8-15K/year)
- Vendor handles ~80%: policy templates, evidence collection, auditor coordination
- Founder owns: vendor selection, policy approval, auditor introduction
- Engineering owns:
  - Enable integrations (GitHub, Vercel, Supabase, AWS)
  - Respond to evidence requests
  - Adopt required controls (background checks for hires, mandatory MFA org-wide via the toggle we just shipped, etc.)
- Target: SOC 2 Type I report in 8-12 weeks
- After award: replace "in progress" on `/security` with badge + NDA-gated report download

---

## Recommended sequence

If a single dev is picking up everything sequentially, this is the optimal order:

| Week | Tasks | Why |
|---|---|---|
| 1 | Priority 7.1, 7.2, 7.3, 7.4 (ops items) | Unblocks Priorities 1, 3 + closes existing gaps. <1 day total. |
| 1-2 | Priority 1 (staff access log) | Highest demo-conversion item. |
| 2 | Priority 2 (Slack webhook) | Builds on Priority 1, fast follow. |
| 3 | Priority 6 (founder pledge) | Quick win between bigger items. |
| 3-4 | Priority 3 (delete-my-data) | Settles "lock-in" objection. |
| 4-5 | Priority 5 (data export) | Same fear as Priority 3, complementary. |
| 5-7 | Priority 4 (sandbox tier) | Highest UX investment, do last because it touches more surfaces. |
| 7+ | Priority 7.5, 7.6, 7.7 (polish) | Cleanup pass. |
| In parallel | Priority 8 (founder/ops) | Founder-led. |
| Continuous from week 1 | Priority 9 (SOC 2) | 8-12 week track regardless of code. |

**Total eng calendar for Priorities 1-7:** ~5-7 weeks with one developer at full-time.

---

## How to start (for the next developer)

1. **Read the existing handoff:** [`docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`](SECURITY-TRUST-DEVELOPER-HANDOFF.md)
2. **Read the Phase 1.5 spec + plan:** [`docs/superpowers/specs/2026-05-05-trust-without-soc2-design.md`](superpowers/specs/2026-05-05-trust-without-soc2-design.md) and [`docs/superpowers/plans/2026-05-05-trust-without-soc2-implementation.md`](superpowers/plans/2026-05-05-trust-without-soc2-implementation.md) — every Priority 1-6 task already has code stubs, file paths, acceptance criteria
3. **Pick a priority** from this doc
4. **Branch off `main`:** `git checkout -b feature/<short-name>`
5. **Ship per the plan's task breakdown** — each task ends with a Conventional Commit
6. **Open a focused PR** with the spec linked
7. **Run prod smoke checks** after merge using the patterns in `SECURITY-TRUST-DEVELOPER-HANDOFF.md` ("Production deployment runbook")

## Critical things to NOT miss

These were called out in earlier handoffs and burned us. Don't forget:

- **Migration backfill on `mode` column** (Priority 4) — without `UPDATE ... SET mode='PRODUCTION'` for existing rows, current customers lose upload access
- **`POCKET_FUND_STAFF_EMAILS` env var** (Priority 1) — without it, the staff access log middleware never fires
- **`CRON_SECRET` env var** (Priority 3) — without it, the deletion executor is either unauthenticated (security hole) or nonfunctional
- **No framework migration mid-feature** — stay vanilla / Next.js / Express per the existing app structure. We discussed this once and it cost half a day of wrong-tree work.
- **Public route classifier** (`apps/web-next/src/lib/supabase/routing.ts`) — when you add new public-facing pages, append to `PUBLIC_PAGE_PREFIXES` AND add a regression test in `routing.test.ts`. PR #28 was a hotfix for forgetting this on `/security`.
- **Reuse audit log infrastructure** — don't write new logging. Use `logAuditEvent(entry, req?)` from `apps/api/src/services/auditLog.ts`. Add new actions to the `AUDIT_ACTIONS` const.
- **Use `req.originalUrl` not `req.path` in middleware** — Express strips mount prefixes from `req.path`, so middleware that prefix-matches paths needs `originalUrl`.
- **Fail-open on transient errors** — middleware that depends on Supabase lookups (org-MFA enforcement, sandbox mode, staff access logger) should `next()` on error rather than 500. Logging is fine; locking out customers on Supabase blips is not.

## Reference: existing code map

When in doubt, read these:

```
apps/api/src/
├── app.ts                                       — middleware chain + route mounts
├── middleware/
│   ├── auth.ts                                  — JWT verify, enforceOrgMfaMiddleware (good template)
│   ├── orgScope.ts                              — getOrgId, verifyDealAccess, etc.
│   └── rbac.ts                                  — 9-role hierarchy + requirePermission
├── services/
│   ├── auditLog.ts                              — logAuditEvent, getAuditLogs, AUDIT_ACTIONS
│   └── supabase.ts                              — service-role client
└── routes/
    ├── audit.ts                                 — GET /api/audit (existing)
    ├── audit-export.ts                          — GET /api/audit/export.csv (PR #9)
    ├── organizations.ts                         — GET/PATCH /api/organizations/me (PR #9)
    ├── auth-sessions.ts                         — GET/DELETE /api/auth/sessions (PR #9)
    └── admin-security.ts                        — POST /api/admin/security/run-isolation-test (PR #9)

apps/web-next/src/
├── middleware.ts                                — Supabase session refresh + auth redirects
├── lib/supabase/routing.ts                      — public/auth/system route classifier (HOTFIX target)
├── app/security/page.tsx                        — public Trust Center
├── app/(app)/settings/SecuritySection*.tsx      — in-app trust panel
└── app/(app)/admin/ActivityFeed.tsx             — audit log filters + CSV export

apps/api/                                        — migrations live flat in this dir
├── security-trust-migration.sql                 — requireMFA column (already applied to prod)
└── trust-without-soc2-migration.sql             — Priority 1-4 columns (TBD on next phase)
```

---

## Questions / blockers

If anything in this doc is unclear, the canonical answers live in (in order of preference):

1. The relevant Phase 1.5 plan task (already specifies code, files, tests)
2. `docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`
3. The PR #9 commit history for working examples
4. Founder ping in `#engineering` Slack
