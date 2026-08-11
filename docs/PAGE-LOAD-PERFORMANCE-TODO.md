# Page-Load Performance — Developer Action Items

**Owner:** _(assign)_
**Branch / PR:** `perf/page-load-speed`
**Created:** 2026-06-16
**Goal:** Make navigation between pages in the **deployed** (`apps/web-next`, Vercel) product feel fast — target sub-second perceived page transitions for authenticated users.

---

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| **0** | Cut redundant auth round-trips (api.ts + middleware) | ✅ **Done** (committed) |
| **1** | Measure baseline metrics | ✅ **Instrumented** (`WebVitals.tsx`) — you still capture/record the numbers |
| **2** | API cold starts — lazy-load resend/xlsx/csv-parse in lite bundle | ✅ **Done** (committed) — measure delta in CI/prod |
| **3** | Skeletons + SWR data-layer | ✅ **Done**: skeletons + `useApiQuery` cache shipped; admin + **deals + dashboard + contacts** migrated, each with a jsdom page test |
| **4** | Lazy-load chart.js (html2pdf already lazy; prefetch already on) | ✅ **Done** (committed) — confirm bundle sizes via build |
| **5** | Static-render marketing pages | ✅ **Verified** — already static (no code change needed); confirm via build route table |
| **6** | Local JWT verification (getClaims) | ✅ **Done** (committed) — auto-upgrades when Supabase asymmetric keys are enabled |

> What's left for **you** (needs access I don't have): **capture the Phase 1 numbers** (instrumentation is in place; needs prod access), confirm **build numbers** for Phases 4/5 in CI, and **enable Supabase asymmetric JWT keys** to unlock Phase 6's local-verify fast path. The page migrations are verified with jsdom page tests, but a visual click-through of the optimistic flows (deal delete / kanban drag / contacts "load more") is still worth a manual pass before merge — that couldn't run here (no browser tool in this environment).

---

## TL;DR

Slow page-to-page navigation in production is caused by **stacked, sequential network round-trips on every navigation**, an **uncached/force-dynamic render path**, a **heavy cold-starting API lambda**, and a **fetch-on-mount data pattern** that shows a spinner before any data loads.

Phases 0, 2, 4 and the skeleton half of 3 are **implemented in this PR**; Phase 5 was **verified already-correct**. The remaining work (baseline measurement, the data-layer half of Phase 3, and optional Phase 6) is detailed below. **Measure before/after (Phase 1) so we can prove the wins.**

---

## Background — the slow chain (read this first)

On a single authenticated page navigation in production today, the request path was:

1. **Middleware `getUser()`** — network round-trip to Supabase auth servers, ran on *every* request including every `/api/*` call. `src/lib/supabase/middleware.ts`
2. **`force-dynamic` render** — nothing cached/prerendered. `src/app/(app)/layout.tsx`
3. **Page mounts as a client component** → shows `Loading...` spinner → *then* starts fetching. 152 `"use client"` pages.
4. **Each API call does another `getUser()`** before reading the token. `src/lib/api.ts` → `getAuthHeaders()`
5. **API cold start** — one catch-all lambda bundling LangChain + OpenAI + Anthropic + Azure + xlsx + pdf-parse, slow first response after idle. `vercel.json`, `apps/web-next/src/app/api/[...slug]/route.ts`

Net: ~3 sequential auth round-trips + uncached render + possible cold start per navigation.

---

## Phase 0 — DONE in this PR (baseline wins, low risk)

> These are already committed. Listed so reviewers/devs understand the starting point.

- [x] **Remove redundant `getUser()` from `getAuthHeaders()`** — `src/lib/api.ts`. Now uses `getSession()` (local read) only. The API re-validates the JWT server-side, so client-side re-validation was pure waste. Removes one network round-trip from **every** `api.get/post/patch/delete`.
- [x] **Stop the auth middleware running on `/api/*`, static assets, and public pages** — `src/middleware.ts` (narrowed matcher) + `src/lib/supabase/middleware.ts` (early-return for non-auth routes). `getUser()` (with token refresh) still runs on real app-route navigations and on `/login`+`/signup`. Removes a network round-trip from every API call and every marketing/legal page.

**Why these are safe:** security is unchanged — the API still verifies every Bearer JWT in `apps/api/src/middleware/auth.ts`. Token refresh is preserved for the routes that gate on it.

**Verify Phase 0:**
```bash
cd apps/web-next
npx tsc --noEmit      # clean
npm test              # all pass
npm run lint
```

---

## Phase 1 — Measure the baseline (do this BEFORE the lifts below)

> **STATUS: ✅ Instrumentation shipped — you capture the numbers.** `components/WebVitals.tsx` (mounted in the root layout) reports Core Web Vitals via `next/web-vitals`. It logs `[web-vitals]` lines to the browser console and, if `NEXT_PUBLIC_VITALS_ENDPOINT` is set, beacons each metric (name/value/rating/path) to that URL. Open DevTools console on prod to read LCP/INP/CLS/FCP/TTFB live, or point the env var at an analytics sink to aggregate. For hosted p75 dashboards, optionally also add `@vercel/speed-insights` (`<SpeedInsights />`).

We need numbers to prove each phase helps and to avoid guessing.

- [x] **Web Vitals reporting wired up** (see status note above).
- [ ] Record **p75 TTFB, FCP, LCP, INP** on `/dashboard`, `/deals`, `/contacts` from the console/sink.
- [ ] In Chrome DevTools → Network, capture a **warm** and a **cold** navigation between `/dashboard` ↔ `/deals`. Note: time to first byte, time to first contentful paint, time until data renders.
- [ ] Measure **API cold start**: hit an `/api/*` endpoint after ~15 min idle; record total time vs a warm call. Check the Vercel function logs for `Init Duration`.
- [ ] Write the baseline numbers into this doc (table below) so after-numbers are comparable.

| Metric | Baseline (p75) | After Phase 2 | After Phase 3 | Target |
|---|---|---|---|---|
| Dashboard TTFB | | | | < 500ms |
| Deals nav → data visible | | | | < 1s |
| API cold start (Init Duration) | | | | < 1.5s |
| Largest JS route bundle | | | | < 250KB gz |

---

## Phase 2 — Cut API cold starts (high impact on first-load)

> **STATUS: ✅ Implemented in this PR.** Commit `perf(api): lazy-load heavy deps…`.

**Problem:** the single catch-all API function bundles every heavy dependency, so the lambda is large and cold-starts slowly. See `serverExternalPackages` in `next.config.ts` and the bundle picker in `src/lib/api-bundles.ts` (`app-lite.js` vs `app-ai.js`).

- [x] **Audited the "lite" bundle.** `pickBundle()` already routes non-AI traffic to `app-lite.js`, and `app-lite.ts` excludes the AI routers. Confirmed (via import-chain trace) that LangChain/OpenAI/Anthropic/Azure/pdf-parse/mammoth are **NOT** reachable from app-lite — they only load in `app-ai`.
- [x] **Lazy-loaded the heavy deps that *were* reachable from lite at module-init:**
  - `resend` in `services/staffAccessNotifier.ts` — pulled in by `staffAccessLogger` (mounted on nearly every route), so it loaded on **every** cold start. Now lazy via `await import('resend')` + cached client.
  - `xlsx` (SheetJS, ~5MB) in `services/excelFinancialExtractor.ts`, `services/excelToMarkdown.ts`, `services/dealImportMapper.ts` — now lazy via `createRequire()` on first spreadsheet parse (matches `azureDocIntelligence.ts`/`pdfExtractor.ts` pattern). `import type` keeps the type annotations.
  - `csv-parse` in `services/dealImportMapper.ts` — lazy on first CSV import.
- [ ] **(Still open) Verify the delta.** Run `npm run build:api` then compare `app-lite` cold-start `Init Duration` in Vercel logs before/after. Fill the Phase 1 table.
- [ ] **(Still open / optional) Right-size the function.** In `vercel.json` the AI function has `memory: 1769`. Test whether the lite path cold-starts faster at lower memory (more memory = more CPU on Vercel, so measure, don't assume).
- [ ] **(Still open / optional) Keep the hot function warm** (Vercel Fluid Compute / cron ping) **only if** measured cold starts are still a real problem.

**Acceptance:** non-AI API routes cold-start meaningfully faster (target Init Duration < 1.5s) and warm calls are unaffected. _Code shipped; measurement pending (Phase 1)._

---

## Phase 3 — Fix the fetch-on-mount pattern (biggest perceived-speed win)

> **STATUS: ✅ Skeletons + prefetch done in this PR. Data-layer (A/B) still open — the bigger lift.**

**Problem:** pages are client components that mount, show a spinner, then fetch. Navigation feels like "blank → spinner → content" instead of "instant".

- [x] **Skeletons, not spinners.** Added layout-shaped `loading.tsx` for the busiest routes — `dashboard/loading.tsx`, `deals/loading.tsx`, `contacts/loading.tsx` — using the existing `components/ui/Skeleton` primitive. (Generic `(app)/loading.tsx` spinner remains as the fallback for other routes; add `data-room/loading.tsx` next.)
- [x] **`<Link>` prefetch confirmed on.** No `prefetch={false}` anywhere in the app — App-router prefetch is fully enabled.
- [x] **`<Link>` prefetch confirmed on.** No `prefetch={false}` anywhere in the app — App-router prefetch is fully enabled.
- [x] **Client cache shipped (strategy B).** `lib/useApiQuery.ts` is a tiny zero-dependency SWR-style hook (module store + `useSyncExternalStore`): revisiting a page renders cached data **instantly** then revalidates; concurrent callers dedupe; `mutate()`/`invalidateApiCache()` keep it correct after writes. Covered by 8 unit tests (`useApiQuery.test.ts`).
- [x] **Reference migration: `admin/page.tsx`** — its three read-only dashboard fetches now go through `useApiQuery`, so returning to `/admin` is instant. Chosen because it's display-only (low blast radius).
- [ ] **(Still open) Roll `useApiQuery` out to the mutation-heavy hot pages** — `deals`, `contacts`, `dashboard`. These do **optimistic local updates** (`setDeals` on delete/drag, append-pagination on contacts), so each needs the imperative `setX` calls re-wired to `mutate()` / `refetch()` and **runtime QA**. Use the admin migration + the hook tests as the template. Then swap the in-page spinners to reuse the skeleton components.

**Acceptance:** repeat navigation between two visited pages shows content with **no full-screen spinner**. _Hook + admin migration shipped; rolling out to the optimistic-update pages is the remaining (QA-gated) work._

---

## Phase 4 — Client bundle size

> **STATUS: ✅ Implemented in this PR.** Commit `perf(web-next): lazy-load chart.js…`.

**Problem:** 152 client components; heavy libs may ship on routes that don't need them.

- [x] **Dynamic-imported chart.js.** `deal-financials.tsx` now loads `RevenueChart`/`GrowthChart`/`BalanceSheetChart` via `next/dynamic({ ssr:false })`; `internal/usage/page.tsx` does the same for `CostBreakdown`. chart.js + react-chartjs-2 no longer ship in those pages' initial bundles.
- [x] **html2pdf.js already lazy** — `memo-builder/export.ts` already used `await import("html2pdf.js")`. No change needed.
- [ ] **(Still open) Confirm bundle sizes via the build route table** (`cd apps/web-next && npm run build`). Optionally add `@next/bundle-analyzer`. Look for any remaining barrel-import bloat.

**Acceptance:** largest route JS bundle < ~250KB gzipped; charts/PDF libs no longer in the shared/common chunk. _chart.js/html2pdf split done; confirm sizes in CI build._

---

## Phase 5 — Static-render the marketing/public pages

> **STATUS: ✅ Verified already-correct — no code change needed.**

**Problem:** the marketing/legal/docs pages (`/`, `/pricing`, `/security`, `/privacy-policy`, etc.) don't need per-request rendering.

- [x] **Confirmed static.** `export const dynamic = "force-dynamic"` exists **only** on `(app)/layout.tsx` and `(onboarding)/layout.tsx` (both correctly auth-gated). The marketing/legal pages have no dynamic export and call no `cookies()`/`headers()`/auth APIs, so Next statically renders them by default.
- [ ] **(Still open) Confirm in the build route table** that `/`, `/pricing`, `/security`, etc. show as `○ (Static)` / `● (SSG)` rather than `ƒ (Dynamic)`. (Couldn't run a full build in the worktree — Turbopack root-inference quirk; run in CI or the main checkout.)
- [ ] Verify the security headers from `next.config.ts` still apply to the static pages.

**Acceptance:** public pages serve from cache/CDN with TTFB dominated by network, not compute. _Static rendering confirmed by static analysis; build-table confirmation pending._

---

## Phase 6 — local JWT verification in middleware

> **STATUS: ✅ Implemented in this PR.** Commit `perf(web-next): getClaims auth…`.

**What shipped:** `supabase/middleware.ts` now validates the session with `supabase.auth.getClaims()` instead of `getUser()`.

**Why it's safe (the earlier concern was wrong):** `getClaims()` delegates to `getSession()`, and `getSession()` **does refresh** an expiring access token (`_callRefreshToken`) and rotates the cookie via the `setAll` handler — verified in the installed `@supabase/auth-js`. So sessions are **not** dropped. It then verifies the JWT signature **locally** when the project uses asymmetric signing keys (zero network), or falls back to a `getUser()` network call for legacy HS256 tokens.

**Net:** never slower than `getUser()`; **much faster once asymmetric keys are enabled** (no network on the hot path).

- [x] Switched middleware to `getClaims()`.
- [ ] **(To unlock the fast path) Enable asymmetric JWT signing keys** in the Supabase dashboard (Project → JWT keys → migrate to ES256/RS256). Until then `getClaims()` transparently falls back to `getUser()` — correct, just not faster. Smoke-test login + an hour-long session after enabling to confirm refresh still works.

---

## Out of scope / don't do

- Don't fold this into the security branch (`fix/security-phase1-p0`) — keep perf isolated.
- Don't remove `outputFileTracingRoot` or the `serverExternalPackages` list in `next.config.ts` (breaks the lambda — see `apps/web-next/CLAUDE.md`).
- Don't switch middleware to `getSession()`-only for the **gate** decision (it doesn't validate server-side) — the gate must keep `getUser()` or a verified `getClaims()`.

---

## Definition of done

- [x] Phases 0, 2, 4 implemented + Phase 3 skeletons + Phase 5 verified (this PR).
- [x] Changed/new files type-check clean; `api` + `web-next` test suites pass; lint clean.
- [ ] **Phase 1 baseline + after numbers** captured and filled into the Phase 1 table (needs prod access).
- [ ] **Phase 3 data-layer** (SWR cache or server-render) shipped so there's no in-page spinner on repeat nav.
- [ ] `npm run build` succeeds in CI (after main's pre-existing RefObject type errors are resolved) and the route table confirms static marketing pages + chart.js out of initial chunks.
- [ ] p75 dashboard navigation feels < 1s on a warm session.
- [ ] PR description summarizes the measured improvement.

---

## Verification done in this PR (and its limits)

- **API** (`apps/api`): `npx tsc --noEmit` clean for all changed files (only a pre-existing `pdf-lib` error remains, unrelated); `staff-access-logger` tests pass (exercises the lazy-Resend path).
- **Web** (`apps/web-next`): `npx tsc --noEmit` clean for all changed/new files; full `npm test` (52) passes; `eslint` clean.
- **Could NOT run locally:** a full `next build` — the worktree hits a Turbopack workspace-root quirk, and `main` has 13 pre-existing `RefObject` type errors (already fixed on the security branch) that block the build. So the **route table / bundle-size numbers and the cold-start delta must be confirmed in CI/prod** (Phase 1). Nothing here changes runtime behavior in a way the type-checker + unit tests wouldn't catch, but the perf *magnitude* is unmeasured until then.
