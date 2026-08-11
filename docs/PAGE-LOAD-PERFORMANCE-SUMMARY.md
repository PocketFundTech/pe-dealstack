# Page-Load Performance — Work Summary

**Date:** 2026-06-18 (IST)
**Branches / PRs:**
- **PR #58** — `perf/page-load-speed` (the performance work, 9 commits)
- **PR #60** — `fix/local-deps-pdf-lib-react19` (a small dependency-hygiene fix found along the way)

**Goal:** Make page-to-page navigation in the deployed product (`apps/web-next`, Vercel) feel fast.

---

## TL;DR

Navigation was slow because of **stacked sequential auth round-trips on every navigation**, a **heavy cold-starting API lambda**, and a **fetch-on-mount spinner** pattern. We worked through a 6-phase plan ([`PAGE-LOAD-PERFORMANCE-TODO.md`](PAGE-LOAD-PERFORMANCE-TODO.md)). Every phase now has shipped, verified code. A few items still need access only the owner has (prod metrics, a Supabase toggle, a CI build).

---

## What changed, by phase

### Phase 0 — Cut redundant auth round-trips  ·  commit `ce40cb1`
- `lib/api.ts`: `getAuthHeaders()` dropped the per-request `getUser()` (a network call to Supabase auth) — now uses `getSession()` (local). The API re-validates the JWT server-side anyway.
- `middleware.ts` + `lib/supabase/middleware.ts`: narrowed the matcher to skip `/api/*`, `_next/*`, and static assets, and early-return on public routes — so the middleware auth call only runs on real app-route navigations.
- **Effect:** a typical authenticated navigation went from ~3 sequential auth round-trips to 1; every API call the page fires dropped from 2 to 0.

### Phase 1 — Measurement instrumentation  ·  commit `55d6824`
- Added `components/WebVitals.tsx` (uses `next/web-vitals`, zero new dependency). Reports Core Web Vitals (LCP/INP/CLS/FCP/TTFB) to the browser console and, if `NEXT_PUBLIC_VITALS_ENDPOINT` is set, beacons each metric to that sink. Mounted once in the root layout.

### Phase 2 — API cold starts  ·  commit `27f0d57`
- Lazy-loaded the heavy deps that the **lite** serverless bundle was loading at module-init:
  - `resend` (in `staffAccessNotifier.ts`) — was pulled in by `staffAccessLogger` on nearly every route, so it loaded on every cold start.
  - `xlsx` / SheetJS (~5MB) — `excelFinancialExtractor.ts`, `excelToMarkdown.ts`, `dealImportMapper.ts`.
  - `csv-parse` — `dealImportMapper.ts`.
- Confirmed (by import-chain trace) that OpenAI / LangChain / Anthropic / Azure / pdf-parse / mammoth are **not** reachable from the lite bundle — they only load in the AI bundle.

### Phase 3 — Skeletons + SWR data-layer  ·  commits `f7481b4`, `190efff`, `72a3f3f`
- **Skeletons:** layout-shaped `loading.tsx` for `dashboard`, `deals`, `contacts` using the existing `Skeleton` primitive.
- **`lib/useApiQuery.ts`** — a tiny, zero-dependency stale-while-revalidate cache (module store + `useSyncExternalStore`). Revisiting a page renders cached data instantly then revalidates; concurrent callers dedupe; `mutate()` (value **or** updater fn) + `invalidateApiCache()` keep it correct after writes. **8 unit tests.**
- **Migrated pages** to the cache, each with a **jsdom page test**:
  - `admin/page.tsx` (read-only, the reference migration)
  - `deals/page.tsx` (filters as the key; delete / bulk-delete / remove-sample / kanban-drag optimistic via `mutate()`)
  - `dashboard/page.tsx` (deals + tasks; task toggle optimistic via `mutate()`)
  - `contacts/page.tsx` (page 1 + scores cached; "Load more" pages kept in key-scoped local state because append-pagination doesn't fit a single cache entry)

### Phase 4 — Client bundle  ·  commit `f7481b4`
- chart.js loaded via `next/dynamic({ ssr:false })` in `deal-financials.tsx` and `internal/usage`. (html2pdf.js was already lazy; no `prefetch={false}` anywhere, so Link prefetch is fully on.)

### Phase 5 — Static marketing pages  ·  verified, no code change
- `force-dynamic` is only on the auth-gated `(app)`/`(onboarding)` layouts; the marketing/legal pages have no dynamic export and call no `cookies()`/`headers()`/auth, so Next renders them static by default.

### Phase 6 — Local JWT verification  ·  commit `55d6824`
- `lib/supabase/middleware.ts` now validates the session with `getClaims()` instead of `getUser()`. Verifies the JWT signature **locally** when the project uses asymmetric signing keys (no network on the hot path); falls back to `getUser()` for legacy HS256 — never slower.

---

## Key decisions & findings (the non-obvious bits)

- **`getClaims()` is safe** even though it doesn't "refresh" by itself: it delegates to `getSession()`, which calls `_callRefreshToken()` on an expiring access token and rotates the cookie (verified in the installed `@supabase/auth-js`). So sessions are **not** dropped. This is why Phase 6 — originally deferred over a refresh-regression fear — turned out to be safe.
- **Contacts pagination** intentionally does **not** go fully through the cache. Append-pagination ("Load more") accumulates pages; only page 1 is cached, with later pages held in key-scoped local state so a filter change discards them without a reset effect.
- **The "13 type errors" were a stale local `node_modules`, not a code bug.** `packages/ui` pinned React 18 types, which npm hoists to the repo root and shadows web-next's nested v19 — only visible when type-checking from a git worktree. CI/Vercel does a clean install and is unaffected. Fixed in **PR #60**.
- **The API failing to boot locally (`Cannot find package 'pdf-lib'`)** was also stale `node_modules` — `pdf-lib` is correctly declared on `main` and used by `pdfWatermark.ts`. A plain `npm install` fixes it. No code change.

---

## Verification done (and its limits)

- **Tests:** `apps/web-next` suite — **66 passing** (9 files), including 8 `useApiQuery` tests + 6 jsdom page tests (deals/dashboard/contacts).
- **Types/lint:** `tsc` clean on all changed files; eslint clean on changed files.
- **Could NOT run here:** a full `next build` (worktree Turbopack root quirk + the stale-types issue) and any **interactive browser QA** — there is no browser-automation tool in this environment, and the API couldn't boot locally (stale deps). The jsdom page tests verify the data-loading + cache contract programmatically, but the perf **magnitude** and the **visual click-through** of optimistic flows are unverified here.

---

## What's left (needs owner access)

1. **Capture Phase 1 numbers** — read the `[web-vitals]` console lines (or wire `NEXT_PUBLIC_VITALS_ENDPOINT`) on prod for `/dashboard`, `/deals`, `/contacts`; fill the table in the TODO doc.
2. **Confirm build numbers in CI** — route table (static marketing pages, chart.js out of initial chunks) and bundle sizes, plus the lite-lambda cold-start delta from Vercel logs.
3. **Enable Supabase asymmetric JWT keys** to activate Phase 6's zero-network fast path (works correctly without it, just not faster).
4. **Manual click-through** of the optimistic flows before merging PR #58: deal delete / kanban drag, dashboard task toggle, contacts "Load more".
5. **Merge PR #60** (`@ai-crm/ui` React 19 types) and run `npm install` to refresh the local install.
