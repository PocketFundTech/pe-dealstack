# Technical Audit — Deployed `main` (pe-dealstack.vercel.app)

**Date:** 2026-07-04
**Method:** Isolated worktree of `origin/main` (commit `fc79b6f`), 5 parallel deep-dive agents (frontend perf, backend API, data layer, tenant-isolation, infra/deploy) + live production latency & region probing.
**Top complaint driving this audit:** slow page loads.

---

## TL;DR — the three things that matter most

1. **Geographic split (P0, ~1-line fix).** DB in **Tokyo** (`ap-northeast-1`, verified by live IP geolocation), API functions in **US-East** (`iad1`, Vercel default — no region pinned), users in **India** (`bom1` edge). Every request goes India → US → Tokyo → US → India, and each ~150–170ms US↔Tokyo hop is paid **per query**, 3–4 sequential queries per request. **Fix:** pin Vercel functions to Tokyo (`"regions": ["hnd1"]`) to co-locate compute with the DB — collapses 500–700ms of per-request DB latency to ~10–40ms.

2. **Every API request pays a 3–4× sequential round-trip tax that isn't cached** (P0). `auth.getUser()` (remote), user lookup, org/MFA lookup — all serial, all uncached, on every call. **Fix:** local JWT verification + a per-lambda TTL cache of `authId → {userId, orgId, role, requireMFA}`. Cuts the tax to ~1 query. Combined with #1, warm API calls drop from ~600ms to sub-50ms.

3. **The frontend re-fetches everything on every navigation with no cache** (P0). 13 of 14 app pages fetch-on-mount in `useEffect`, and `key={pathname}` in the layout force-remounts the page subtree on every nav, so every visit and every back-button shows a spinner + full API round-trip. **Fix:** adopt the existing `useApiQuery` SWR cache (already proven on the admin page) + remove the remount key.

Plus a set of **exploitable multi-tenant security holes** (below) that are unrelated to speed but must be fixed before selling on a security/trust story.

---

## SECURITY — cross-tenant isolation holes (fix before client rollout)

Isolation is 100% app-code (service-role key bypasses RLS), so a missing `where organizationId` = a live data leak. The dominant pattern is correct; these are the deviations.

### P0 — no ownership check at all
- **Org takeover by name.** `services/userService.ts:40` / `middleware/orgScope.ts:69` — a new user is attached to an existing `Organization` matched by **name** from attacker-controlled `user_metadata.firm_name`. Sign up with a customer's firm name → join their org → full access to their deals/documents. **Fix:** never join an existing org by name; create a new org or require invitation.
- **`POST /api/documents/:id/link`** (`documents-sharing.ts:16`) — source doc and target deal fetched by raw id, no org check. Read a victim org's `fileUrl`/`extractedText`/`aiAnalysis`/financials into your own deal, **or** inject a document into their deal. **Fix:** `verifyDocumentAccess` + `verifyDealAccess` before copy.
- **`GET` / `DELETE /api/activities/:id`** (`activities.ts:171,196`) — no org filter. Any user can read or delete any org's activity by UUID. **Fix:** load `dealId` → `verifyDealAccess`.
- **`GET /api/activities/recent`** (`activities.ts:215`) — no org filter (would return a global cross-org feed); currently shadowed by `/:id` route ordering, so latent. **Fix:** add org scope + move above `/:id`.

### P1 — cross-tenant via user-supplied id (needs a guessed/leaked UUID)
- `GET /api/users/:id/deals` (`users.ts:272`) and `GET /api/users/:id/notifications` (`users.ts:308`) — `:id` never verified to be in caller's org. Leaks deal assignments / notifications.
- `POST /memos/:id/sections/:sectionId/generate` (`memos-chat.ts:58`), `PATCH` & `DELETE /memos/:id/sections/:sectionId` (`memos-sections.ts:128,160`) — parent memo is org-verified but child section fetched/mutated by `id` without `.eq('memoId', id)`. Cross-tenant read + overwrite/delete of memo sections.

### P2 — same "parent verified, child by raw id" gap, lower-value rows
- `memos-sections.ts:184` reorder, `templates-sections.ts:109/141/165` PATCH/DELETE/reorder, `contacts-connections.ts:273` DELETE connection.

### P3 — minor info leak
- `memos-mutate.ts:42` (leaks another org's deal name to prefill), `templates.ts:324` (bump another org's template usage counter).

---

## PERFORMANCE — why pages are slow

### P0
- **Region split** — see TL;DR #1. `vercel.json` has no `regions` key.
- **Per-request middleware tax** — `middleware/auth.ts:68` (`getUser` remote), `orgScope.ts:30` (user lookup), `auth.ts:204` (org/MFA lookup) — 3–4 sequential, uncached, every request. `usageContext.ts:19` already proves this lookup is cacheable. Each hop is a Pacific crossing until #1 is fixed.
- **"Lite" bundle isn't lite** — `app-lite.ts` (serves deals/contacts/notifications CRUD) statically imports the full AI/parse stack: `@langchain/{core,langgraph,anthropic,openai,google-genai}`, `openai`, `@anthropic-ai/sdk`, `xlsx`, `mammoth`, `pdf-lib`, `pdf-parse`, `apify-client`. Cold start of hot CRUD paths pays module-init of all of it (~1.5–4s). Offending chains: `deals.ts:25→deals-chat-ai`, `documents.ts:8-14→{pdfWatermark,pdfExtractor,excel*,rag}`, `deals-analysis.ts:5`, `invitations.ts:9→onboarding→firmResearchAgent`. **Fix:** dynamic `import()` at call sites (codebase already does this correctly in `contacts.ts:326`).
- **Both bundles ship in one lambda** — `api-bundles.ts:24` dynamic imports lack `webpackIgnore`, so Vercel traces *both* app-lite and app-ai node_modules into the single function. **Fix:** split AI routes into their own `app/api/ai/[...slug]/route.ts` so Vercel builds two functions with separate traces.
- **13 pages fetch-on-mount, no cache** — see TL;DR #3. `client-layout.tsx:55` `key={pathname}` forces remount; only `admin/page.tsx` uses `useApiQuery`.

### P1
- **Deals hot path over-fetches.** `GET /api/deals` (`deals-list.ts:72`) — unpaginated, `select('*')` + full `Company` + AI fields on every dashboard load. `GET /deals/:id` eager-loads all activities + all documents incl. `aiAnalysis` JSONB. `/stats/summary` runs 4 sequential queries. **Fix:** pagination + column projections + `Promise.all`.
- **Document/company lists ship `extractedText` + `aiAnalysis`.** `documents.ts:95`, `companies.ts:19/42` use `select('*')` on wide tables — a folder listing can transfer MBs. **Fix:** explicit projections.
- **Auth waterfall on first load.** `AuthProvider.tsx:38` does a blocking `getUser()` (network) before setting session; `UserProvider.tsx:91` then waits to fetch `/users/me`. Everything gated on `user` waits for this chain. **Fix:** trust the already-validated `getClaims()`, set session immediately, validate in background.
- **Render-blocking Google Fonts** (`app/layout.tsx:43`) — Material Symbols variable font (~300KB) loaded via third-party stylesheet with no preconnect; icons flash as raw text (`drag_indicator`) on every page. **Fix:** self-host a subset via `next/font/local`.
- **Sentry Session Replay** shipped eagerly in every page's JS (`sentry.client.config.ts:20`) even at 0 sample rate (~50–90KB gz). **Fix:** `lazyLoadIntegration`.
- **chart.js leaks into the deals/[id] bundle** via `deal-chat-chart-artifact.tsx:37` (~90KB gz), defeating the June dynamic split. **Fix:** `next/dynamic` the chart artifact.
- **Full-reload navigations** — `window.location.href` between internal pages in `deal-panels.tsx:68/86/97`, `IngestDealForm.tsx:299/444/466`, `IngestDealModalProvider.tsx:48`. **Fix:** `router.push()`.
- **Fire-and-forget writes lost on serverless** — `setImmediate`/unawaited audit writes (`staffAccessLogger.ts:63`, `deals-list.ts:193`, doc audit) can be dropped when the lambda freezes → silent gaps in the audit trail you market. **Fix:** `waitUntil()`.
- **Contacts import** — `contacts.ts:461` does up to 500 sequential single-row inserts. **Fix:** chunked bulk insert.
- **No caching on hot reads** — zero `Cache-Control`/ETag on `/deals`, `/stats/summary`, `/users/me`, `/notifications`.

### Infra/build hygiene (P1)
- `vercel.json` `installCommand` does `rm -f package-lock.json && npm install` every deploy → non-reproducible builds, no npm cache. **Fix:** `npm ci`.
- Puppeteer (~170MB Chromium) downloaded on every install/CI run; used only by one offline script. **Fix:** `.npmrc` `puppeteer_skip_download=true`.
- Two conflicting `vercel.json` files (root vs `apps/web-next/`) — the inactive one's settings silently don't apply (this is how the earlier "functions weren't deployed" incident happened). **Fix:** single source of truth.
- API built twice per deploy (root buildCommand + web-next build script both build `@ai-crm/api`); turbo installed but never invoked (no build cache). **Fix:** dedupe + `turbo run build`.
- Unused root dep `cyndra-agent`; OAuth redirect `localhost` fallbacks without `NODE_ENV` guard; `render.yaml` legacy leftover.

---

## Data layer

- **Connection handling** and index coverage: see agent detail (schema indexes on `organizationId` composite + `createdAt` sorts recommended; migrations are 30+ hand-run `.sql` files with drift risk — no migration tooling).
- The dominant `verify*Access` pattern (124 uses) is sound; failures are the localized deviations listed under Security above.

---

## Recommended sequencing

**Phase 0 — this week (cheap, huge):**
1. Pin Vercel `regions: ["hnd1"]` (Tokyo, co-locate with DB). *(Longer term: move both DB + compute to Mumbai `ap-south-1`/`bom1` since users are in India — but that's a DB migration; Tokyo co-location is the immediate win.)*
2. Cache the middleware auth/user/org lookups + local JWT verify.
3. Fix the P0 security holes (org-by-name, documents-sharing link, activities routes).

**Phase 1 — next:**
4. Adopt `useApiQuery` on the 13 pages + remove `key={pathname}` remount.
5. Dynamic-import the AI/parse stack out of app-lite; split AI into its own Vercel function.
6. Paginate + project the deals/documents/companies hot queries.

**Phase 2 — polish:**
7. Self-host fonts, lazy Sentry replay, dynamic chart artifact, `router.push` navigations.
8. Build/infra hygiene (npm ci, skip Chromium, single vercel.json, turbo cache).
9. Fix remaining P1/P2 tenant-scoping gaps (users sub-routes, memo/template sections).
</content>
</invoke>
