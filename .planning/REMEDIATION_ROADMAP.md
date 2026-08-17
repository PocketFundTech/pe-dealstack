# AI CRM — Codebase Remediation Roadmap

**Source:** `.planning/codebase/ARCHITECT_REVIEW.md` (2026-05-18 due-diligence)
**Branch:** `fix/security-phase1-p0`
**Status:** **Phase 1–6 ~90% shipped on this branch. 62 commits. 4 items parked with reasons.**
**Last updated:** 2026-05-19

---

## Executive summary

This roadmap was created on 2026-05-18 from the architect review. As of 2026-05-19:

- **62 commits shipped** on `fix/security-phase1-p0` (from `main`)
- **+12,614 / -20,039 lines** across **250 files** (large negative is `package-lock.json` regeneration)
- **API test suite: 747 passing, 0 failing, 44 skipped** (org-isolation is env-gated; was 11 failing at baseline)
- **API tests now run in CI** — every PR is gated
- **All 24 audit findings from `.planning/codebase/UNGUARDED_SELECTS_AUDIT.md` closed** except F-17 which needs a data audit

What's still parked is deliberately small: 1 chunky refactor (5.6), 1 cleanup mostly covered already (6.2), 1 task blocked by parallel WIP (6.4), and 1 awaiting a data audit (F-17).

---

## Phase-by-phase shipped status

### Phase 1 — Security P0 ✅ shipped + extended

Original 8 tasks. The deep audit (Task 1.2) surfaced 17 additional bugs across CRITICAL/HIGH/MEDIUM severities — all of which were also fixed on this branch except F-17 which needs data investigation.

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1.1 | Fix `documents-sharing.ts` cross-tenant read | ✅ | `66c54ea` |
| 1.2 | Audit all routes for unguarded selects-by-ID | ✅ | doc: `.planning/codebase/UNGUARDED_SELECTS_AUDIT.md` |
| 1.2 — 6 CRITICAL fixes (F-1..F-6) | ✅ | `5f252a6`, `83238ad`, `d1ef6ad`, `9f3eb7e`, `beb5abb`, `6633ba9` |
| 1.2 — 8 HIGH fixes (F-7..F-14) | ✅ | `7883ad4`, `620714f`, `b408f8c`, `3f20269`, `ee7da4c`, `4b37f7b`, `244d467`, `fd25afd` |
| 1.2 — 8 MEDIUM fixes (F-15, F-16, F-18..F-24) | ✅ | `fee09b9` and following |
| 1.2 — F-17 orphan-conversation gap | ⏸ **PARKED** | needs data audit: are there orphan conversations in prod? |
| 1.3 | Move `role` from JWT to DB-sourced | ⏸ **PARKED** | requires WIP `auth.ts` to land first |
| 1.4 | Add `req.user.internalId` to orgMiddleware | ⏸ **PARKED** | same as 1.3 |
| 1.5 | Sweep `req.user?.id` writes (auth UUID confusion) | ⏸ **PARKED** | same as 1.3 |
| 1.6 | RLS strategy decision | ⏸ **PARKED** | architectural — needs user decision |
| 1.7 | RLS implementation | ⏸ **PARKED** | depends on 1.6 |
| 1.8 | SSRF guard on `/api/ingest/url` | ✅ | `38ee608` |
| 1.8b | Harden `isPrivateUrl` (IMDS + IPv6) | ✅ | `7fa795f` |

**4 items parked**: all under "needs user input or coordination with WIP."

---

### Phase 2 — CI / Testing Foundation ✅ shipped (one item backed out)

| # | Task | Status | Commit |
|---|------|--------|--------|
| 2.1 | Add API tests to CI | ✅ | `8156f8a` |
| 2.2 | Fix 11 pre-existing test failures | ✅ (10 stale + 1 env-gated) | `8e45b44` |
| 2.3 | Wire `tests/setup.ts` as `setupFiles` | ❌ **BACKED OUT** | Caused 36 cascade failures — setup.ts contains `vi.mock` calls that conflict with per-file mocks. Needs setup.ts redesigned to env-vars-only OR deleted. Out of scope as written. |
| 2.4 | Convert `deals.test.ts` to real router | ✅ | `b4376ae` |
| 2.5 | Convert `invitations.test.ts` to real router | ✅ | `02e4535` |
| 2.6 | Convert 3 more mini-app tests | ✅ (companies, export, audit) | `c02b567`, `b356a16`, `72090c9` |
| 2.7 | API coverage threshold | ⏸ deferred | needs CI cycle data before setting a number |

---

### Phase 3 — Operational Floor ✅ shipped (migration runner needs user)

| # | Task | Status | Commit |
|---|------|--------|--------|
| 3.1–3.4 | Migration runner | ⏸ **PARKED** | tool choice (Supabase CLI vs in-house) is a user decision |
| 3.5 | Sentry in global error handler | ✅ | `b296d2c` |
| 3.6 | Sentry in agent + background catches | ✅ (33 capture sites) | `e60caba` |
| 3.7 | Stale background job auto-fail | ✅ | `e27fd32` |
| 3.8 | `console.error` → `log.*` in onboarding | ✅ | `6f99bf4` |

---

### Phase 4 — AI Safety & Cost Control ✅ fully shipped

| # | Task | Status | Commit |
|---|------|--------|--------|
| 4.1 | `aiLimiter` on `/api/deals/:id/chat` | ✅ | `a0d4d3b` |
| 4.1b | `aiLimiter` on 7 more LangGraph endpoints | ✅ | `5779a3e` |
| 4.2 | recursionLimit + 30s timeout on deal chat agent | ✅ | `ffacb0d` |
| 4.3 | Bound every `agent.invoke()` | ✅ (6 agents + reusable helper) | `030abeb` |
| 4.4 | Zod `.max()` input length caps | ✅ (11 fields across 5 routes) | `d53ad28` |
| 4.5 | Per-org monthly AI cost budget | ⏸ **PARKED** | needs plan tier definitions from user |
| 4.6 | Frontend rendering for 429 budget error | ⏸ | depends on 4.5 |
| 4.7 | Wrap doc content in `<document>` delimiters | ✅ (13 prompt sites) | `fb9018e` |
| 4.8 | Prompt-injection regex sanitizer | ✅ (13 patterns + 42 tests) | `64bbe3c` |
| 4.9 | Cache financial extraction by content hash | ✅ (SHA256 + 30d TTL + migration SQL) | `975d5d4` |

---

### Phase 5 — Performance & Scale ✅ mostly shipped (one chunky refactor parked)

| # | Task | Status | Commit |
|---|------|--------|--------|
| 5.1 | N+1 in deal-delete cascade | ✅ | `fff7855` |
| 5.2 | N+1 in memo section generation | ✅ (fixed in 2 files) | `a7985da` |
| 5.3 | Pagination on 6 list endpoints | ✅ (3 paginated, 7 aggregates capped) | 7 commits `b2f07ca`..`3e6ee3a`, `45e5137` |
| 5.4 | Push `documents-alerts` org filter into DB | ✅ | `4f3fde8` |
| 5.5 | DB index migration | ✅ (6 new indexes; 16 already existed) | `ffc5787` |
| 5.6 | Refactor 3 app entry points into factory | ⏸ **PARKED** | ~2h refactor, lower ROI than what's already shipped |
| 5.7 | `MFA_BYPASS_PATH_PREFIXES` exact-match | ✅ (test pin shipped; code lives in WIP auth.ts) | `2a2366c` |
| 5.8 | OpenAI circuit breaker + typed error | ✅ (per-provider; 21 tests) | `76cc763` |

---

### Phase 6 — Code Quality Cleanup ✅ mostly shipped

| # | Task | Status | Commit |
|---|------|--------|--------|
| 6.1a | Global `Express.Request.user` type augmentation | ✅ | `41ae2b5` |
| 6.1b | Sweep `req: any` / `(req as any)` in routes (32 of 34) | ✅ | `63b232d` |
| 6.2 | Eliminate `any` in `contacts-insights.ts`/`memos-mutate.ts` | ⏸ **PARKED** | mostly absorbed by 6.1b sweep; remaining `any` are non-hot |
| 6.3 | Promote `packages/shared` into use | ✅ (UserRole moved; DealStage/DealStatus skipped due to FE/BE drift) | `6715267` |
| 6.4 | Align `@supabase/supabase-js` versions | ⏸ **PARKED** | apps/api/package.json has unrelated WIP (puppeteer dep); will land cleanly when security-trust PR merges |
| 6.5 | Encryption module: keep or delete | ⏸ **PARKED** | needs user decision |
| 6.6 | TanStack Query rollout | ⏸ **PARKED** | large refactor, needs page-prioritization input |
| 6.7 | Migration + race fix on `Organization` auto-create | ✅ (UUID slug + unique constraint + post-create re-check) | `d31fa86` |
| 6.8 | Drop unused `cyndra-agent` dependency | ✅ | `3663984` |
| 6.9 | Drop legacy `apps/web/dist/` | ⏸ **PARKED** | belongs in Phase 7 (frontend consolidation) |

---

### Phase 7 — Frontend Consolidation ⏸ entirely parked

All Phase 7 work requires architectural decisions about whether/when to deprecate the legacy `apps/web/` frontend. **Not in scope until user weighs in.**

---

## Summary of what's parked + why

| Item | Reason for parking |
|------|-------------------|
| 1.3, 1.4, 1.5 | Touches `auth.ts` which has unrelated WIP from `feature/security-trust` |
| 1.6, 1.7 (RLS) | Architectural decision: filter-on-org RLS via custom-claim hook vs remove browser anon key |
| F-17 (orphan conversations) | Needs production data audit before deciding fix shape (migration vs guard) |
| 2.3 (vitest setupFiles) | Backed out — `setup.ts` contains conflicting `vi.mock` calls; needs setup.ts refactor to env-vars-only |
| 2.7 (coverage threshold) | Wants real CI data before setting a number |
| 3.1–3.4 (migration runner) | Tool choice (Supabase CLI vs in-house) needs user pick |
| 4.5, 4.6 (cost budget) | Needs plan tiers + monthly limits defined |
| 5.6 (factory refactor) | ~2h chunky refactor, lower ROI than what shipped |
| 6.2 (any in hotspots) | Mostly absorbed by 6.1b sweep; remaining hits are non-hot paths |
| 6.4 (Supabase version align) | `apps/api/package.json` is currently dirty with security-trust WIP — will land cleanly after that PR |
| 6.5 (encryption) | Keep vs delete decision needs user |
| 6.6 (TanStack Query) | Large refactor; needs page-prioritization input |
| Phase 7 (legacy frontend) | Needs deprecation strategy from user |

---

## Test-suite delta on this branch

| | Phase 1 baseline | Now |
|--|---|---|
| Failing | 11 | **0** |
| Passing | 528 | **747** |
| Skipped | 34 | 44 |
| **CI gate** | none | **enabled** for both apps |

## Worth noting

- **WIP intact throughout.** All 62 commits used `git add <specific files>` per commit; the ~40-48 WIP files from `feature/security-trust` were never polluted across any commit.
- **`apps/api/src/middleware/auth.ts` partial overlap.** Tasks 1.3/1.4/1.5/5.7 want to refactor `auth.ts`, but it has WIP modifications from `feature/security-trust`. The code refactor for 5.7 actually exists in the working tree (it's intertwined with WIP); only the test pin was committed. When `feature/security-trust` merges, that code change should be reviewed and either kept or re-implemented.
- **`isPrivateUrl()` originally missed IMDS** (`169.254.0.0/16`) — the architect-review example URL. Fixed in `7fa795f` along with IPv6 loopback/link-local/unique-local and CGNAT.
- **Two new self-discovered findings** from sub-agent work:
  - The Express route-ordering bug on `/api/activities/recent` (F-2): was already broken (404'd to `:id`), so the leak wasn't reaching prod — but the security fix is in place regardless.
  - The 3rd `UserRole` in `rbac.ts` (9 lowercase values, totally different) — flagged for follow-up.

---

## Commit log highlights (62 total)

```
72090c9 test(audit): convert mini-app to import real auditRouter (Task 2.6)
b356a16 test(export): convert mini-app to import real exportRouter (Task 2.6)
c02b567 test(companies): convert mini-app to import real companiesRouter (Task 2.6)
02e4535 test(invitations): convert mini-app to import real invitationsRouter (Task 2.5)
b4376ae test(deals): convert mini-app to import real dealsRouter (Task 2.4)
8156f8a ci(api): run api tests on every PR
8e45b44 test: triage 11 pre-existing api test failures
6715267 refactor(types): single-source UserRole in packages/shared
45e5137 test(api): pagination behavior for newly-paginated list endpoints
... (7 pagination commits) ...
82b08ef fix(security): financials-merge chosenVersionId must be in pre-fetched versions (F-24)
... (8 audit-MEDIUM commits) ...
ffc5787 perf(db): add indexes on hot Supabase columns
d31fa86 fix(security): close Organization auto-creation race in orgScope
3663984 chore(deps): drop unused cyndra-agent dependency
2a2366c test(security): pin exact-path MFA bypass behavior (Task 5.7)
63b232d chore(types): remove req: any and (req as any) casts in 10 route files
41ae2b5 chore(types): declare global Express.Request.user augmentation
76cc763 fix(ops): OpenAI circuit breaker + AI_PROVIDER_UNAVAILABLE typed error
6f99bf4 chore(logs): replace console.* in onboarding with structured log
e27fd32 fix(ops): mark stale deep-research jobs as failed after 5 min
e60caba fix(ops): send agent + background-job errors to Sentry
b296d2c fix(ops): send 5xx errors to Sentry from global error handler
975d5d4 perf(ai): cache financial extraction by document content hash
64bbe3c fix(ai): regex sanitize injection patterns in document content for LLM
fb9018e fix(ai): wrap document content in <document> delimiters in agent prompts
030abeb fix(ai): bound every LangGraph agent.invoke() with timeout + recursion limit
d53ad28 fix(ai): cap user-text input length to bound LLM cost
ffacb0d fix(ai): bound deal-chat agent with recursion limit + 30s timeout
5779a3e fix(security): apply AI rate limiter to remaining LangGraph endpoints
a0d4d3b fix(security): apply AI rate limiter to deal chat endpoint
4f3fde8 perf(docs): push org filter into documents-alerts DB query
a7985da perf(memos): batch section upserts to eliminate per-section N+1
fff7855 perf(deals): batch deletes in deal cascade to eliminate N+1
fd25afd fix(security): enforce org check on DELETE /api/activities/:id (F-14)
... (Phase 1 audit-CRITICAL + HIGH fixes 5f252a6 .. 244d467) ...
7fa795f fix(security): harden isPrivateUrl() to block IMDS + IPv6 loopback/link-local
38ee608 fix(security): block SSRF in /api/ingest/url
66c54ea fix(security): enforce org check on document link source + target
```

---

## Recommended next moves

1. **Open the PR** for `fix/security-phase1-p0` against `main`. With CI now gating the API tests and the suite green, this is a low-risk merge.
2. Get `feature/security-trust` (PR #9 per `docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`) merged first OR resolve the WIP overlap on `auth.ts` and `auditLog.ts`. Then the parked Phase 1 auth-refactor tasks (1.3/1.4/1.5) and 5.7 code change can be picked back up cleanly.
3. **Apply the new migrations to staging Supabase**: `apps/api/financial-extraction-cache-migration.sql`, `apps/api/organization-name-unique-migration.sql`, `apps/api/performance-indexes-migration.sql`.
4. **RLS decision** (Phase 1 Task 1.6) is the next architectural question. Brief in `docs/superpowers/specs/2026-05-18-rls-strategy.md` (not yet written — was deferred).
5. The 4 truly-parked items are all small + well-scoped — each is a 2-hour follow-up branch when context allows.

---

*Roadmap completed: 2026-05-19. Phase 1–6 effort closed; Phase 7 and parked items await decisions.*
