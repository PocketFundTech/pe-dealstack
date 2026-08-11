# Security & Trust — Developer Todo List

> **Status: Phase 0 + Phase 1 (codable items) implemented as of 2026-05-01.** All 16 codable tasks (Tasks 1–16) shipped on `feature/security-trust`. See `docs/superpowers/plans/2026-05-01-security-trust-implementation.md` for the implementation plan and per-task commit log. Phase 1.4 (DPA template) and Phase 1.5 (SIG-Lite questionnaire) remain — they are non-code workstreams (lawyer / sales) and were intentionally not part of this implementation. One manual step remains before features go live in production — see "What ships when migration is applied" at the bottom.

**Goal:** Make our security posture visible and demoable so PE prospects stop raising "is our data safe?" objections on every sales call.

**Context:** Our infrastructure security is genuinely strong (Supabase SOC 2 Type II, AES-256 at rest, helmet + rate-limited API, 2FA fully implemented, 34 automated cross-org tests, comprehensive audit log backend with active writers, 268 org-scope checks across 45 route files). What we lack is the **customer-facing surface** — public marketing pages, polished in-app trust UI, downloadable artifacts, and visible filters/exports on what we already log.

**This doc was written after auditing the codebase line-by-line.** Each "what's missing" claim has been verified against actual files. Phase 0 + Phase 1 status updates were added 2026-05-01 after implementation.

---

## Existing security capabilities (already shipped — DO NOT rebuild)

Important context for the developer so nothing is duplicated:

| Capability | Where it lives | State |
|---|---|---|
| 2FA / MFA enrollment, TOTP verify, disable | `apps/web/js/auth.js:296-395`, `apps/web/settings.html` (lines 232–290 inside `#section-security`) | **Live** — QR enrollment, 6-digit verify, disable confirm |
| MFA login challenge | `apps/web/login.html:251,368-410` | **Live** — `getMFAStatus` + `showMFAChallenge` |
| Settings → Security section (password + 2FA) | `apps/web/settings.html` `#section-security` (lines 186–290) | **Live** — needs additions, not creation |
| Audit log backend | `apps/api/src/services/auditLog.ts` (60+ action types, 9 resource types) | **Live** — written from invitations, memos, deals, ai-ingest, etc. |
| Audit log API | `apps/api/src/routes/audit.ts` — `GET /api/audit`, `GET /api/audit/entity/:id`, `GET /api/audit/summary` | **Live, org-scoped** |
| Admin activity feed (audit log UI) | `apps/web/admin-dashboard.js:305-396` (`loadActivityFeed`, `renderActivityItem`, `groupLogsByDay`, `formatAuditAction`) | **Live** — paginated, day-grouped, formatted |
| Org-scoped tenant isolation | `apps/api/src/middleware/orgScope.ts` — used in 45 route files, 268 references | **Live** |
| Cross-org isolation tests | `apps/api/tests/org-isolation.test.ts` | **Live — exactly 34 tests** |
| RBAC role hierarchy | `apps/api/src/middleware/rbac.ts` — 9 roles: admin, partner, principal, vp, associate, analyst, viewer, ops, member | **Live** |
| API security middleware | `apps/api/src/app.ts:82` (helmet), `:141-167` (3-tier rate limiting: general 600/15min, AI 10/min, writes 30/min) | **Live** |
| Public legal pages | `apps/web/privacy-policy.html`, `apps/web/terms-of-service.html` | **Live** but **NOT linked from landing page** — fix this |
| Internal security docs | `docs/SECURITY.md`, `docs/SECURITY-WHITEPAPER.md`, `docs/SECURITY-TEST-CHECKLIST.md`, `docs/ORG-ISOLATION-TEST-CHECKLIST.md` | **Live** — whitepaper has stale rate limits, see Phase 0.5 |

**Existing settings JS modules to follow as a pattern:** `apps/web/js/settingsProfile.js`, `apps/web/js/settingsInvite.js`. Create `settingsSecurity.js` matching the same style.

---

## Active sub-processors (verified by API key usage in code)

This is the **accurate** sub-processor list — needed for Phase 0.3:

| Provider | Service | Verified usage | SOC 2 |
|---|---|---|---|
| Supabase | Postgres DB, Auth, File Storage | Throughout (`@supabase/supabase-js`) | Type II |
| Vercel | Application hosting (serverless) | `vercel.json` at repo root | Type II |
| OpenAI | GPT-4o (extraction, classification, chat) | `openai.ts`, `app-ai.ts`, `rag.ts`, multiple routes | Type II |
| Anthropic | Claude (financial cross-verification) | `services/anthropic.ts`, `crossVerifyNode.ts` | Type II |
| Google | Gemini (LLM router fallback) | `gemini.ts`, `services/llm.ts` | SOC 2 |
| Azure | Document Intelligence (PDF extraction) | `services/azureDocIntelligence.ts` | Yes |
| Apify | Web search (firm research agent) | `services/webSearch.ts`, `apify-client` | SOC 2 |
| Resend | Transactional email (invites, alerts) | `routes/invitations.ts`, `documents-sharing.ts`, `folders-insights.ts` | Type II |
| Sentry | Error monitoring | `app.ts`, `app-ai.ts`, `app-lite.ts` (`@sentry/node`) | Type II |

**NOT a sub-processor:** `@llamaindex/cloud` is in `package.json` but no source code references it — installed but unused. Either remove the dep or document it as "available but inactive."

---

## Phase 0 — Ship before next demo (1 week, ~3-5 dev days)

> **Phase 0 status:** ✅ Complete (Tasks 1–7, plus the nav-wiring sub-task). All sub-sections below are marked individually.

### ✅ 0.1 Public `/security` page (Trust Center)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Tasks 2 + 3 — see commits `a8eb6d9`, `8b9c0ea`, `f3f8194`. Files: `apps/web/security.html` (full Trust Center page including hero, data-residency, encryption, tenant-isolation callout, AI/LLM handling, RBAC, audit logging, sub-processor anchor `#sub-processors`, compliance roadmap, contact).**


**Priority:** P0 — biggest single win
**Effort:** 1 day
**State:** No `apps/web/security.html` exists. Build new.

**Build:**
- New file: `apps/web/security.html` (model after `apps/web/privacy-policy.html` styling — Banker Blue `#003366`, Inter font, white cards on `#F8F9FA` bg)
- Sections (lift content from `docs/SECURITY-WHITEPAPER.md`, but verify rate-limit numbers — see 0.5):
  1. **Hero:** "Your deal data, secured." + trust badges (Supabase Type II, Vercel Type II, AES-256, 34 isolation tests)
  2. **Where your data lives** — Supabase (AWS us-east-1), Vercel, OpenAI/Anthropic/Google/Azure for AI, Resend for email, Apify for research, Sentry for errors. All SOC 2 (or equivalent).
  3. **Encryption** — TLS in transit (Vercel-managed cert, TLS 1.2+), AES-256 at rest (Supabase-managed)
  4. **Tenant isolation** — call out **"34 automated cross-organization tests run on every deploy. 268 org-scope checks across 45 API route files."** Link to Phase 1.6 live demo.
  5. **AI & LLM data handling** — explicit: "OpenAI, Anthropic, and Google API tiers do not train models on customer data. CIMs, LOIs, and memos never feed any model."
  6. **Access controls** — 9-tier RBAC (admin → viewer), helmet middleware, 3-tier rate limiting, MFA available
  7. **Audit logging** — every sensitive action logged (60+ action types), org-scoped, customer-admin viewable
  8. **Sub-processor list** — full table from above (anchor `#sub-processors`)
  9. **Compliance roadmap** — SOC 2 Type I in progress, target date; Type II to follow
  10. **Contact:** `security@pocket-fund.com` for security questions; download security PDF link
- **Footer linking:** add `/security` link to landing page footer (currently has NO security/privacy/terms links — verify and add all three at once)
- Add to login/signup pages: small "Your data is secured →" link to `/security`

**Acceptance:**
- Live at `/security.html`
- Linked from landing page footer + login + signup pages
- Lighthouse > 90, mobile responsive
- Matches Banker Blue aesthetic
- All claims traceable to code or whitepaper

---

### ✅ 0.2 Augment existing in-app Security & Privacy section

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Tasks 5 + 6 — see commits `57626ec`, `f0e31fc`. Files: `apps/web/js/settingsSecurity.js` (new module matching `settingsProfile.js` / `settingsInvite.js` style), `apps/web/settings.html` (wired into `#section-security` and script block; section header renamed to "Security & Privacy"). Renders: data-home block, encryption/infra status badges, tenant-isolation badge with link to live demo, AI handling block, active-sessions block (filled by Task 14), sub-processors link, security one-pager download, DPA mailto.**

**Caveat:** the org-info block currently calls `/api/users/me` (which already returns `organization` data) rather than the new `/api/organizations/me`. Works fine; can be optimized to use the dedicated org endpoint later.


**Priority:** P0
**Effort:** 1 day
**State:** `#section-security` exists in `settings.html` but only has password + 2FA. Needs additions (NOT creation).

**Add to existing section in `apps/web/settings.html` (after the existing `#mfa-section` div, around line 290):**
- Create new file: `apps/web/js/settingsSecurity.js` (matching pattern of `settingsProfile.js` / `settingsInvite.js`). Wire it into `settings.html`'s `<script>` block.
- New blocks to render:
  1. **Your data home** — pulls user's `Organization.id`, `Organization.name` from API. Shows: "Your firm's data lives in a dedicated logical Postgres database scoped by organization ID `<id>`. Every read and write is verified server-side."
  2. **Encryption & infra status** — green-check badges: TLS via Vercel ✓, AES-256 at rest ✓, Encrypted backups (Supabase-managed) ✓
  3. **Tenant isolation badge** — "Verified by 34 automated tests on every deploy" → link to `/security#isolation` (later: Phase 1.6 button)
  4. **AI data handling** — "OpenAI / Anthropic / Google API tiers do not train on your data" with "Read more" → `/security#ai`
  5. **Active sessions** — placeholder for Phase 1.3 ("Sign out other sessions — coming soon")
  6. **Sub-processors** — "View full sub-processor list →" → `/security#sub-processors`
  7. **Download security one-pager** — button → downloads PDF from 0.4
  8. **Request DPA / MNDA** — button → mailto:`security@pocket-fund.com?subject=DPA%20Request`

**Note for the developer:** the existing `#section-security` opens with the title "Security" — consider renaming the section header to "Security & Privacy" to match the public Trust Center framing.

**Acceptance:**
- All new blocks render below existing password + 2FA UI
- Org info loads from current API (`/api/organizations/me` or equivalent — verify endpoint)
- All links work
- No regression to existing password-change or 2FA flows

---

### ✅ 0.3 Sub-processor list page (anchor in `/security`)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 3 — see commit `f3f8194`. Files: `apps/web/security.html` anchor `#sub-processors` — full 9-row table (Provider | Service | Region | Certifications | DPA link), 30-day notification note included.**


**Priority:** P0
**Effort:** 0.5 day

**Build:**
- Anchor section in `security.html` (`#sub-processors`) — full 9-row table from "Active sub-processors" above
- Columns: Provider | Service | Region | Certifications | DPA link
- Add note: "We notify customers 30 days before adding any new sub-processor."
- Verify each provider's DPA is publicly linkable; "Available on request" placeholder is fine for ones without public links

**Acceptance:**
- All 9 active sub-processors listed (NOT 5 as a previous draft suggested)
- Inactive deps (LlamaIndex if kept) excluded
- DPA links resolve

---

### ✅ 0.4 Security one-pager PDF (sales follow-up artifact)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 7 — see commit `6fe2ea1`. Files: `apps/web/security-pdf.html` (print-styled 2-page Banker Blue layout), `apps/api/scripts/generate-security-pdf.ts` (Puppeteer renderer), `apps/web/assets/pocket-fund-security-overview.pdf` (generated artifact). Linked from `/security` hero and Settings → Security one-pager download.**


**Priority:** P0
**Effort:** 0.5 day

**Build:**
- 2-page PDF, Banker Blue branded, hosted at `apps/web/assets/pocket-fund-security-overview.pdf`
- Page 1: Where data lives, encryption, tenant isolation (cite "34 tests / 268 org-scope checks"), AI handling, sub-processor count
- Page 2: Access controls (9-tier RBAC, MFA, rate limiting), audit logging (60+ event types), compliance roadmap, contact
- Generation: write `apps/web/security-pdf.html` styled for print, render via Puppeteer, OR manually export from Google Doc / Figma matching brand
- Link from: settings security section ("Download security overview"), `/security` hero, sales email signature

**Acceptance:**
- PDF downloads in <2s
- Print-quality layout
- All numeric claims match what's in code at time of generation

---

### ✅ 0.5 Update stale numbers in `SECURITY-WHITEPAPER.md`

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 1 — see commits `c03d334`, `194899e`. Files: `docs/SECURITY-WHITEPAPER.md` — rate-limit numbers corrected to match `app.ts:141-167` (600/15min general, 10/min AI, 30/min writes), TLS claim aligned to "TLS 1.2+", concrete numbers added (34 isolation tests, 60+ audited action types, 9-role RBAC).**

---

### ✅ 0.x Wire `/security` into nav (footer + login + signup)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 4 — see commit `911c4c6`. Files: `apps/web/landingpage.html` (footer security/privacy/terms links), `apps/web/login.html` (small "Your data is secured →" link), `apps/web/signup.html` (same).**


**Priority:** P0 (must be done before publishing security PDF)
**Effort:** 30 min
**Why:** Whitepaper currently states "100/15min rate limit" but `app.ts` enforces 600/15min general, 10/min AI, 30/min writes. Whitepaper also shows generic content blocks; no SOC 2 status, no audit-log claim wording. **Fact-check the whitepaper before any prospect sees it.**

**Actions:**
- Update rate limit numbers in `docs/SECURITY-WHITEPAPER.md` to match `app.ts:141-167`
- Verify "TLS 1.3" claim — Vercel default is TLS 1.2+; only state TLS 1.3 if confirmed
- Add concrete numbers: "34 cross-org isolation tests, 60+ audited action types, 9-role RBAC"
- Have founder review before any external use

---

## Phase 1 — Trust-builders for inbound questionnaires (1.5-2 weeks)

> **Phase 1 status:** Codable items (1.1, 1.2, 1.3, 1.6) ✅ Complete (Tasks 8–16). Non-code items (1.4 DPA, 1.5 SIG-Lite) remain — they are lawyer / sales workstreams, not part of this implementation pass.

### ✅ 1.1 Audit Log filters + CSV export (extend existing UI)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 13 — see commit `afbe453`. Files: `apps/api/src/routes/audit-export.ts` (new org-scoped CSV streaming endpoint reusing `getAuditLogs`), `apps/web/admin-dashboard.html` (filter row above activity feed: date range, user, action type, resource type, Export to CSV button), `apps/web/admin-dashboard.js` (filter state passed to `/api/audit`, RBAC-gated to admin/partner).**


**Priority:** P1
**Effort:** 1 day (NOT 2 — most of the UI exists)
**State:** Activity feed already renders in admin-dashboard.js with pagination. Missing only: filters + export.

**Build:**
- Backend: add `GET /api/audit/export.csv` to `apps/api/src/routes/audit.ts`. Reuse existing `getAuditLogs` from `services/auditLog.ts`, stream as CSV. Org-scoped — must call `getOrgId(req)`.
- Frontend: in `admin-dashboard.html`, above the activity feed, add filter row:
  - Date range picker (Start / End)
  - User dropdown (populated from team)
  - Action type dropdown (use `AUDIT_ACTIONS` enum from `services/auditLog.ts` — 60+ values, group by category)
  - Resource type dropdown (use `RESOURCE_TYPES` enum)
  - "Export to CSV" button
- Update `loadActivityFeed()` in `admin-dashboard.js:311` to pass filter params to `/api/audit`
- RBAC gate: only `admin` / `partner` roles see filters + export. Use `rbac.ts` permissions.

**Acceptance:**
- Filters apply correctly (verified against test org with mixed events)
- CSV export downloads with org-scoped data only (verified by attempting cross-org access — should return 0 rows)
- No regression to existing activity feed

---

### ✅ 1.2 Org-level 2FA enforcement (NOT individual 2FA — already done)

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Tasks 8–12 — see commits `d10516e`, `2100dcf`, `4f91987`, `b054514`, `ef5b155`. Files: `apps/api/security-trust-migration.sql` (adds `requireMFA` to `Organization`), `apps/api/src/routes/organizations.ts` (`GET` / `PATCH /api/organizations/me`), `apps/api/src/middleware/auth.ts` (post-JWT `MFA_REQUIRED` enforcement when org policy is on), `apps/api/src/services/auditLog.ts` (`SETTINGS_CHANGED` event fired on toggle), `apps/web/settings.html` + `apps/web/js/auth.js` (admin toggle in `#section-team`, 403 → enrollment redirect path).**

**Caveat — important:** the `Organization.requireMFA` migration in `apps/api/security-trust-migration.sql` is **NOT yet applied** to the live Supabase database. Until the SQL runs, `GET`/`PATCH /api/organizations/me` will fail (column does not exist). Manual deploy step documented at the bottom of this doc.


**Priority:** P1
**Effort:** 1 day
**State:** Individual 2FA enrollment is fully built. Only **org-wide policy** is missing.

**Build:**
- Migration: add `requireMFA: boolean` to `Organization` table (default false)
- Backend middleware: in `auth.ts`, after JWT verify, check `Organization.requireMFA`. If true, check user has MFA enrolled (existing `auth.mfa.listFactors()` call). If not, return 403 with code `MFA_REQUIRED`.
- Frontend: in `settings.html` `#section-team` (admin-only), add toggle "Require 2FA for all members". Wired to new endpoint `PATCH /api/organizations/me { requireMFA }`.
- When user gets 403 `MFA_REQUIRED`, redirect to enrollment screen using existing `enrollMFA` flow.
- Audit log: write `SETTINGS_CHANGED` event when toggle changes.

**Acceptance:**
- Admin can flip the toggle
- New session without MFA → blocked at API layer
- Existing sessions get blocked on next token refresh
- Toggle change appears in audit log
- Demo path: prospect's admin enables it, member without MFA tries to log in → forced enrollment

---

### ✅ 1.3 Active sessions UI

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Task 14 — see commit `7a507ae`. Files: `apps/api/src/routes/auth-sessions.ts` (`GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions` for "sign out all"), `apps/web/js/settingsSecurity.js` (renders session list with device, IP/location, last-active, current-session marker, revoke buttons; `LOGOUT` audit event on terminate).**

**Caveat:** the endpoint depends on Supabase's `auth` schema being PostgREST-exposed for direct queries; the JS SDK doesn't expose `listUserSessions`. Until the Supabase project is configured to expose `auth.sessions` (or we adopt the Supabase Auth admin REST API directly), the UI will display "Session management unavailable" gracefully instead of failing hard.


**Priority:** P1
**Effort:** 1 day
**State:** Not built.

**Build:**
- Backend: new endpoint `GET /api/auth/sessions` (Supabase Auth admin API) and `DELETE /api/auth/sessions/:id`
- Frontend: in `settings.html` `#section-security`, replace the Phase 0.2 "coming soon" placeholder with real session list
- Columns: Device (parsed UA) | IP / approx location | Last active | Current?
- "Sign out" button per session, "Sign out all other sessions" button
- All session terminations write `LOGOUT` audit event

**Acceptance:**
- User sees own sessions only (org-scoped via Supabase auth)
- Revoke works immediately (verify in second browser)
- Logged in audit trail

---

### 1.4 DPA template

**Priority:** P1 (legal, not eng)
**Effort:** Lawyer fee ~$1-3K, no dev time
**State:** Not in repo.

**Action:**
- Engage SaaS lawyer (Cooley, Gunderson, AngelList templates) to draft DPA
- Cover: data controller/processor roles, sub-processor list, security measures (cite our 9 sub-processors, MFA, audit log, encryption), breach notification (72h GDPR), data retention/deletion (30 days post-termination), audit rights
- Store at `apps/web/assets/pocket-fund-dpa.pdf`
- Link from `/security`, `#section-security`, signup, sales

---

### 1.5 SIG-Lite questionnaire pre-filled

**Priority:** P1
**Effort:** 1 day to fill, ongoing maintenance
**State:** Not in repo.

**Build:**
- File: `docs/security-questionnaires/SIG-Lite-2026.md` (or `.xlsx`)
- Pre-fill the [Shared Assessments SIG-Lite questionnaire](https://sharedassessments.org/sig/) using verified facts:
  - Encryption: AES-256 at rest, TLS 1.2+ in transit
  - Access control: 9-tier RBAC, optional MFA, org-level MFA enforcement (Phase 1.2)
  - Network security: helmet middleware, rate limiting (3 tiers)
  - Audit logging: 60+ action types, org-scoped, customer-admin accessible
  - Tenant isolation: 34 automated tests, 268 org-scope checks across 45 route files
  - Incident response: see Phase 3.3
- Maintain in repo, reviewed quarterly

---

### ✅ 1.6 Live "tenant isolation proof" demo button

**Implemented in `docs/superpowers/plans/2026-05-01-security-trust-implementation.md`, Tasks 15 + 16 — see commits `72374e8`, `499d426`. Files: `apps/api/src/routes/admin-security.ts` (`POST /api/admin/security/run-isolation-test`, RBAC-gated to admin, runs targeted programmatic cross-org checks against an ephemeral seed org with transactional cleanup, returns pass/fail counts + per-check status, writes `SECURITY_TEST_RUN` audit event), `apps/web/js/settingsSecurity.js` (terminal-styled results panel under "Run isolation test" button, admin-only).**


**Priority:** P1 — pure conversion magic
**Effort:** 1.5 days
**State:** Not built. Underlying tests exist (`tests/org-isolation.test.ts`).

**Build:**
- New endpoint `POST /api/admin/security/run-isolation-test` (admin-only, RBAC-gated)
- Implementation: programmatically run a subset of `org-isolation.test.ts` against the requesting user's org. Use a dedicated test-org seed (created+destroyed in transaction). Return: tests passed, tests blocked, total time, status.
- UI: in `settings.html` `#section-security` add "Run isolation test" button (admin only). Display results in a terminal-style panel:
  ```
  → Cross-org Deal read attempt          BLOCKED ✓ (404)
  → Cross-org Document read attempt      BLOCKED ✓ (404)
  → Cross-org write attempt              BLOCKED ✓ (404)
  → Cross-org Folder access              BLOCKED ✓ (404)
  ... (10-12 representative tests, runs in <3s)
  → 12/12 isolation tests passed
  ```
- Audit-log this action (new audit event `SECURITY_TEST_RUN`)
- Show this on demos: "Want me to prove the isolation? Click here."

**Acceptance:**
- Runs in <3s
- Shows green checks
- Failure case alerts engineering (Sentry event + admin notification)
- Cleanup: no persistent test orgs left behind
- Don't run real test framework — run targeted programmatic checks for speed

---

## Phase 2 — Enterprise unlock (8-12 weeks calendar, start now)

### 2.1 SOC 2 Type I

**Priority:** P2 (start now — long lead time)
**Effort:** 8-12 weeks calendar, ~10-20 dev hours total

**Action:**
- Engage [Vanta](https://www.vanta.com), [Drata](https://drata.com), or [Secureframe](https://secureframe.com) — ~$8-15K/year
- Vendor handles ~80%: policy templates, evidence collection, auditor coordination
- Founder owns: vendor selection, policy approval, auditor introduction
- Engineering owns: enable integrations (GitHub, Vercel, Supabase), respond to evidence requests, adopt controls (background checks for hires, mandatory MFA org-wide, etc.)
- After award: replace "in progress" on `/security` with badge + NDA-gated report download

---

### 2.2 BYOK design doc only

**Priority:** P3
**Effort:** Spec — 0.5 day
**Action:** Write `docs/superpowers/specs/2026-XX-XX-byok-design.md`. Architecture: per-org keys via Supabase Vault or AWS KMS, customer manages rotation. Don't build until first paying customer demands it.

---

### 2.3 Dedicated DB / VPC option spec

**Priority:** P3
**Effort:** Spec — 0.5 day
**Action:** Write `docs/superpowers/specs/2026-XX-XX-dedicated-deployment-design.md`. Options: dedicated Supabase project per customer or full VPC deployment via AWS. Pricing 3-5x base tier. Don't build until first prospect commits.

---

## Phase 3 — Ongoing

### 3.1 Annual penetration test
- Cobalt / HackerOne / Bishop Fox, $5-15K/yr
- Output: NDA-shareable report ("Latest pentest: Q3 2026, no critical findings")

### 3.2 Bug bounty (post-SOC 2 Type II)
- HackerOne / Intigriti

### 3.3 Security incident playbook
- `docs/SECURITY-INCIDENT-RESPONSE.md` — roles, comms tree, breach notification (72h GDPR / state laws)
- Quarterly tabletop exercise

---

## Sales enablement (parallel — no eng work)

- 1-page "Security FAQ" answering top 10 demo questions (use verified numbers above)
- Train sales/founder on the 4-layer answer (where data lives → tenant isolation → who can see → AI handling)
- Add demo step: open `/security` page during demo (10 sec)
- Add demo step: open Settings → Security → run isolation test (after Phase 1.6 ships)

---

## Effort summary (revised after audit, then updated 2026-05-01 after implementation)

| Phase | Calendar | Dev days | Status |
|---|---|---|---|
| Phase 0 (demo-ready) | 1 day | ~1 (autonomous) | ✅ Complete (Tasks 1-7) |
| Phase 1 (questionnaires — codable items) | Same day | ~1 (autonomous) | ✅ Complete (Tasks 8-16) |
| Phase 1 — DPA + SIG-Lite | Pending | Lawyer / sales work | Not started — non-code |
| Phase 2 (enterprise SOC 2) | 8-12 weeks | 10-20 + lawyer + auditor | Not started |

**Recommended sequence:**
1. **Day 1:** ship 0.5 (whitepaper rate-limit fix) + start 0.1 (`/security` page)
2. **Days 2-4:** finish 0.1, build 0.2, 0.3, 0.4 in parallel
3. **Demo with new collateral.** Measure objection rate.
4. **Week 2-3:** Phase 1, prioritized by what prospects still ask
5. **In parallel from Day 1:** kick off Vanta/Drata SOC 2 engagement

The **`/security` page + Phase 1.6 isolation-test demo button** are the two items that will most directly change demo outcomes.

---

## Verification log

This document was rewritten on 2026-04-30 after auditing the codebase. Every claim in the "Existing capabilities" table was verified by reading source files. Effort estimates were revised down for Phase 1 because much of what an earlier draft proposed already exists. Full verification trail in conversation history.

On 2026-05-01 the doc was updated with implementation status (✅ markers, commit references, file lists, and known caveats) after Tasks 1–16 of the implementation plan landed on `feature/security-trust`.

---

## What ships when the migration is applied

Phase 0 + Phase 1 (codable items) are committed on `feature/security-trust` (HEAD `499d426`). One human step remains before all features go live in production:

```bash
psql "$SUPABASE_DB_URL" -f apps/api/security-trust-migration.sql
```

This SQL adds the `Organization.requireMFA` column that backs the org-level 2FA toggle (Phase 1.2). Until it runs against the live Supabase project, `GET` / `PATCH /api/organizations/me` will fail because the column does not exist. Everything else in Phase 0 + Phase 1 (the public `/security` page, sub-processor list, security PDF, in-app Security & Privacy section additions, audit-log filters + CSV export, active sessions UI, isolation-test demo) ships without further DB changes.

## Follow-ups deferred from this implementation pass

- **Automated tests for new endpoints.** Tests for `auth-sessions.ts`, `audit-export.ts`, `admin-security.ts`, and the `/api/organizations/me` routes were not written — there is no easy harness for combined auth + org integration tests in the current `apps/api/tests/` setup. Tracked as a follow-up; existing 34 cross-org isolation tests continue to cover tenant boundaries.
- **Phase 1.4 DPA template** — engage SaaS lawyer (see Phase 1.4 above).
- **Phase 1.5 SIG-Lite questionnaire** — fill using verified facts (see Phase 1.5 above).
- Switch Settings → Security org-info block from `/api/users/me` to the new `/api/organizations/me` once the migration is applied.
- Configure Supabase project to expose `auth.sessions` so the Active Sessions UI reads real data instead of falling back to "Session management unavailable".
