# Codebase Audit — 2026-10-11

**Audited:** `origin/main` @ `5371eeaa` (PR #212). Read-only. Line numbers refer to that commit.
**Method:** six parallel area audits (security, backend architecture, AI layer, frontend, data/perf, CI/ops) plus four security sweeps. Every **P0/P1** item below was re-read in the code before inclusion; items still depending on live prod state are marked **(needs prod check)**.
**Prior baseline:** `.planning/codebase/ARCHITECT_REVIEW.md` (2026-05-18, scored 2.9/5).

---

## Verdict

**~3.3 / 5 (up from 2.9).** The foundations improved a lot since May: API CI exists, the May P0s (`/documents/:id/link`, document alerts, org auto-create race, MFA prefix bypass) are fixed, logging is structured (pino, ~1,400 `log.*` vs 14 `console.*`), API keys and webhook delivery are done properly, AI cost discipline (caching, on-click rule, error classification) is mostly in place, and test volume is real (~290 API + ~70 web test files).

What keeps it from reading as senior-architect code is **structure, not talent**: routes contain the business logic and the DB calls (663 `.from(` in routes vs 322 in services), tenant isolation is 296 hand-written `.eq('organizationId')` calls with no structural guard, there are 3 hand-synced app entrypoints, ~7 LLM client wrappers, 83 un-ordered SQL files, and dead engine branches still shipping. Each of those is a class of bug that will keep recurring until it is fixed structurally.

---

## 1. Security

Security findings are tracked in the **private** advisory [GHSA-hhrx-h5xv-g4rc](https://github.com/PocketFundTech/pe-dealstack/security/advisories/GHSA-hhrx-h5xv-g4rc). It lists 17 items (S1–S17) with its own to-do list. Only repo admins and invited collaborators can see it. Keep the specifics out of public issues, PRs and commit messages until the fixes have shipped.

---

## 2. Fix soon — things that are broken or costing money

| # | Issue | Where | Fix |
|---|---|---|---|
| B1 | **7 of 8 Vercel crons never run.** Vercel Cron sends GET; these routes only accept POST → no integration sync, doc-request reminders, digests, reactivation, share-expiry warnings, re-engagement. **PR #143 already fixes this and has been open since ~#140** (needs rebase). | `routes/cron-*.ts`, `integrations-public.ts:54` | Rebase + merge #143. Also confirm which `vercel.json` prod reads (Root Directory = `apps/web-next` would ignore root `crons`/`regions`) — check `x-vercel-id` ends `::hnd1`. |
| B2 | **Fable runs on PDFs** — violates the founder cost rule. `claudeEngine` uses `role:'extraction'` (→ `claude-fable-5`) for the PDF branch too; every manual extract/re-extract of a PDF bills Fable. Commit `34e59963` only removed the automatic pass. | `services/extraction/claudeEngine.ts:254-293`, `services/ai/models.ts:33` | Add an `extraction.pdf` role → Sonnet; Fable only for the spreadsheet path. |
| B3 | **Out-of-credit still shows as "password-protected PDF" (422).** `claudeDealReader` catches every error → `null`; ingest-upload turns that into 422. This is the exact symptom from 2026-09-28 / 10-01. | `services/extraction/claudeDealReader.ts:227-233`, `routes/ingest-upload.ts:313-324` | Rethrow `toProviderUnavailable(err)` like `claudeEngine.ts:178`. |
| B4 | **No alert when AI credit runs out** — classified in `utils/aiErrors.ts` but only used to word the user message; found by hand both times. | `utils/aiErrors.ts:62-103` | `Sentry.captureMessage(level:'fatal')` on quota class + daily balance probe in the usage-reconciliation cron. |
| B6 | **Uploads > 4.5 MB fail** on deal-page document upload, public doc-request upload, NDA upload — they post multipart through the function despite signed-URL support existing. | `deal-page-handlers.ts:189`, `deal-tabs.tsx:185`, `upload-view.tsx:82`, `UploadExistingFlow.tsx:142` | Use `uploadViaSignedUrl`. |
| B7 | **Soft-deleted deals leak into reads** — 74 files query `Deal`, 9 filter `deletedAt`. Stats count them, portfolio AI sees them, signal scan bills AI on them; nothing purges after 30 days. | `deals-list.ts:31-51`, `ai-portfolio.ts:25,121,217`, `cron-signal-scan.ts:20` | `LiveDeal` view (or repo helper) + purge cron. |
| B8 | **Kanban drag returns every document's full extracted text.** `PATCH /deals/:id` selects `documents:Document(*)` (incl. `extractedText`, `aiAnalysis`); deal list is unbounded `*` and the dashboard fetches it 3×. | `deals-mutate.ts:216-221`, `deals-list.ts:117-121`, `use-dashboard-data.ts:61`, `calendar.tsx:25`, `team-performance.tsx:33`, `deal-funnel.tsx:27` | Explicit lean columns; honour `limit`; one shared dashboard query. |
| B9 | **Work after `res.send` is dropped on serverless** (`void fn()`): Dropbox Sign signature events, extraction follow-ups, audit log writes. Helpers exist but 4 files use them. | `dropbox-sign-webhook.ts:64`, `financials-extraction.ts:488,491,656`, `onboarding.ts:436,450`, `organization-criteria.ts:93`, `deals-list.ts:200` | `runInBackground` / `runAfterResponse`. |
| B10 | **Builds aren't reproducible** — prod deletes the lockfile and re-resolves `^` ranges every deploy; CI uses `npm install`. | `vercel.json:5`, `.github/workflows/pr.yml` | `npm ci` everywhere; fix the native-binary issue via `optionalDependencies`. |
| B11 | **The 40-case org-isolation test suite never runs** in CI (gated on `RUN_INTEGRATION_TESTS`). | `apps/api/tests/org-isolation.test.ts:38` | Run against local `supabase start` / a branch DB, seeded with two orgs. |
| B12 | **Frontend states that mislead users** (breaks the "explain every empty state" rule): portal 5xx shows external recipients "Link not found"; failed criteria load shows a blank form that Save can overwrite; HubSpot status failure looks like "disconnected"; 37 bare `"—"` fallbacks incl. the client-facing portal financials. | `portal/[token]/page.tsx:42-49`, `settings/CriteriaSection.tsx:43`, `settings/IntegrationsSection.tsx:340`, `portal/portal-view.tsx:137-140` | Shared `<ErrorState reason retry>`; disable Save on load failure. |
| B13 | Smaller: missing `getTodayIso()` in ~10 live prompts (meeting-transcript next steps, CIM claims TTM, signal monitor, email classifier…); timeouts that race but never `abort` (scorecard, NDA review keep billing); unvalidated `JSON.parse` of model output in memo/scorecard/NDA; `ImportJob` start race (no partial unique index); Reply.io webhook not idempotent; `AuditLog`/`UsageEvent` retention functions never called. | see AI/data sections of the agent notes | — |

---

## 3. Make it read like a senior architect wrote it — the refactor roadmap

These are ordered by leverage; each is a separable PR series. Do them **after** sections 1–2.

1. **One route registry + `createApp(bundle)` factory.**
   - **Today:** `app.ts` (562 lines), `app-lite.ts` (462) and `app-ai.ts` (293) re-declare helmet, CORS, limiters, Sentry and `/health`. They mount the auth chain by hand 56, 49 and 14 times. `pickBundle` in web-next hard-codes regexes that must agree with them, and the parity test only checks imports. This is the "404 only in prod" bug class.
   - **Target:** `http/registry.ts` holds `{path, router, bundle, auth, permission, limiter}` entries. Each entrypoint becomes `createApp(bundle)`, and `pickBundle` is generated from or tested against the registry. The `permission` field makes every route declare who may call it.
2. **Validated config + flags, then delete the dead engines.**
   - **Today:** 83 env vars are read raw in 84 files. Engine flags default to *legacy* in code while prod runs Claude, so losing an env var silently reverts traffic, which nearly happened in the Vercel move. `.env.example` is missing 30 vars, including `SUPABASE_SERVICE_ROLE_KEY` and `AI_BACKGROUND_JOBS`.
   - **Target:** `config/env.ts` (zod, fail fast at boot) plus `config/flags.ts` with prod-correct defaults, and generate `.env.example` from it.
   - **Then delete:** legacy deal chat (`deals-chat-ai.ts:334`, `langchainAdapter.ts`, the parity test), the legacy OpenAI/LangGraph financial graph (`financialClassifier`, `claudeFinancialClassifier`, `financialCrossVerify`, `visionExtractor`, `selfCorrect`/`crossVerify` nodes), Gemini chat, `runIngestDeepPass` and `generateTeasersForDeal` (no callers), `@google/generative-ai` and `@llamaindex/cloud` (0 refs).
3. **Org-scoped repository layer.**
   - **Today:** 99 of 118 route files talk to Supabase directly with a service-role client.
   - **Target:** `domain/<entity>/<entity>.repository.ts` takes a `RequestContext {orgId, userId}` and *always* applies the scope. An ESLint `no-restricted-imports` rule bans `supabase` outside repositories. Start with Deal, Document, Folder, Memo and FinancialStatement. This makes org scoping impossible to forget.
4. **Thin routes + services + one error path.**
   - **Handlers today:** `ingest-upload.ts:138` is a 662-line handler, and `documents-upload.ts:67` is 597 lines. 55 functions are over 150 lines.
   - **Errors today:** 259 hand-rolled `res.status(500)`, while `AppError` is thrown in only 2 files.
   - **Target:** routes become zod parse → `service.method(ctx, input)` → respond. Add an `asyncHandler`, have services throw typed errors, and let one error middleware own the response shape and the Sentry capture.
   - **Dependency direction:** fix the inverted imports (services importing `routes/` at `invitationAccept`, `dealReactivation`, `gmail/autoCreateDeal`; routes importing routes ×20) with `import/no-restricted-paths`.
5. **Merge the 5 create-deal-from-document pipelines** into one `DealIngestService.ingest({source, ...})`. Today `ingest-upload`, `ingest-url`, `ingest-text`, `ai-ingest` and `documents-upload` each extract and insert on their own, so dedup, notification and engine fixes drift between them.
6. **One AI gateway + model registry.**
   - **Today:** 7 client wrappers across 4 providers, 3 model registries (`services/ai/models.ts`, `utils/aiModels.ts`, `llm.ts:309`) and 10+ hardcoded model IDs.
   - **Target:** a single `ai/gateway.ts`, mandatory for every call. It owns the user gate, circuit breaker, timeout + abort, retries, usage metering with `trigger: click|background` (enforcing the on-click rule itself) and `structured<T>()` (zod + one repair pass).
   - **Model roles:** keyed by use, e.g. `extraction.spreadsheet` (the only route to Fable), `extraction.pdf`, `chat`, `classify` and `memo`.
   - **Prompts:** builder functions in `prompts/*.ts` that require `{today}` by type, which makes the getTodayIso rule unbreakable.
7. **Shared contract types.**
   - **Today:** `Deal` is declared about 7 times across api, web-next and shared, and 12 call sites guess the response shape (`Array.isArray(x) ? x : x.deals`).
   - **Target:** zod DTOs live in `packages/shared`, types are inferred from them, and both sides use them. Generate DB row types with `supabase gen types`. Ratchet the 502 `any`s down with an ESLint baseline.
8. **Real migrations.**
   - **Today:** 83 loose `apps/api/*.sql` files mix DDL with tenant data fixes (`cicero-capital-*`), and 20 have no `IF NOT EXISTS`. `docs/PENDING-MIGRATIONS.md` is a hand-kept ledger, and `.gitignore:75` ignores `supabase/`.
   - **Steps:**
     1. `supabase db dump` a baseline.
     2. Move to `supabase/migrations/<timestamp>_*.sql`.
     3. Seed `schema_migrations` from the ledger.
     4. Move data fixes to `ops/data-fixes/`.
   - **Workflow:** the founder still applies them, but with `supabase db push` from a recorded list. Two drifts to resolve: the RPCs `increment_template_usage` and `search_document_chunks` are used in code but defined in no `.sql`.
9. **Jobs instead of in-request work.** Extraction races a 240s timeout inside a 300s function, and locks and quotas are per-instance memory. Use a `Job` table + chunked `/continue` polling (the HubSpot import already does this), and Postgres advisory locks or unique partial indexes for concurrency.

### Proposed `apps/api/src` shape
```
config/        env.ts (zod), flags.ts
http/          createApp.ts, registry.ts, middleware/ (auth, orgScope, rbac, errors, asyncHandler), routes/<domain>/
domain/<deals|documents|financials|memos|legal|contacts|outreach>/   *.service.ts, *.repository.ts
ai/            gateway.ts, models.ts, prompts/, agents/
integrations/  (keep — _platform registry is already good)
jobs/          cron handlers (gate on aiOnDemand)
shared/        logger, errors, utils
entry/         app-lite.ts, app-ai.ts, dev.ts  →  createApp(bundle)
```

---

## 4. Frontend (apps/web-next) cleanups

1. **One API client.**
   - **Today:** `authFetchRaw` is exported from a *page* file (`app/(app)/deal-intake/components.tsx:100`) and imported by 13 modules, and 4 more places call `fetch` raw with their own token handling.
   - **Fix:** add `api.upload` / `api.download` to `lib/api.ts`.
2. **Use the existing `useApiQuery` hook.** 67 of 73 fetching files use `useEffect` + `useState` instead, which takes 40 `eslint-disable` comments to keep lint quiet.
3. **One modal and one token system.**
   - **Modals:** 58 hand-rolled `fixed inset-0` overlays plus 2 native `window.confirm` calls. Replace them with one `ui/Modal` (focus trap, Esc, aria-modal).
   - **Colours:** `#003366` is hardcoded 467 times, with 1,325 hex literals overall. Two token systems coexist (`globals.css --color-*` and `dash.css --dash-*`). Codemod the literals to `primary` and merge the token sets.
4. **Theme rule violations to remove:** `bg-slate-900` in `dashboard/widgets/scan-terminal.tsx:132`, `bg-[#0b1120]` in `SecuritySection.isolationTest.tsx:97`, `bg-[#1e293b]` in `api-reference/page.tsx:68` and `sections.tsx:378`, and `font-serif` in `nda/Editor.tsx:402`.
5. **Structure and dependencies:**
   - **Inverted imports:** 12 imports go from `lib/` or `components/` into `app/`. For example, `IngestDealForm` imports 4 page modules.
   - **Error boundaries:** there's no root `not-found.tsx` or `global-error.tsx`, so the portal, upload and auth pages have no boundary.
   - **Bundle size:** the 1,390-line `lib/dealchat-skills/index.ts` prompt text ships in the client bundle; lazy-load it or serve it from the API.
   - **Chart libraries:** two ship. Drop recharts, which only 1 file uses.
6. **Delete dead code:** `apps/web/` (one orphaned file that a merge brought back), `packages/ui` (0 importers, built for React 18 and Tailwind 3), `components/layout/NotificationsDropdown.tsx`, `(app)/coming-soon` and `render.yaml` (it calls a script that doesn't exist).
7. **Accessibility:** clickable `div` rows with no keyboard handling (`contacts/list-items.tsx:77,150`, `companies/page.tsx:214`) and 6 icon-only buttons without `aria-label`.

---

## 5. Repo / DevEx hygiene

- **Lint:** ESLint covers only web-next. The API, shared and ui packages have no config, so their `lint` scripts can't run. Add a shared flat config and lint every workspace in CI.
- **CI:** Turbo is declared but CI and Vercel don't use it. Run CI through `turbo` with caching. CI also never runs on `main` after a merge, and there's no Dependabot or Renovate.
- **Node:** pin it. Today `engines` is `>=22`, CI runs Node 24 and `@types/node` is ^20. Add `.nvmrc`.
- **Tracked files that shouldn't be:** `compact.md` (11.7k lines) and `Prompt.md` are tracked even though gitignored. `PROGRESS.md` is 14.5k lines; consider rotating it monthly into `docs/progress/`.
- **Root clutter:** AGENTS, CONDUCTOR, JOURNAL, GTM-STRATEGY, BUILD and ARCHITECTURE docs sit at the repo root. `docs/` is 10 MB across 260 files (PDFs, 40 images, 66 plan files). Move the binaries out and archive old plans.
- **Over-broad gitignore rules:**
  - `.gitignore:66` ignores every `scripts/` directory, which is how the #164 backfill was lost. Narrow it to `/scripts/`.
  - `.env*` also matches `.env.example`. Add `!.env.example`.
- **Stale test:** `describe.skip` in `tests/db-optimizations.test.ts:32` targets Prisma, which this repo doesn't use. Delete it.
- **Duplicate libraries:** 6 LLM SDKs, `xlsx` alongside `exceljs`, chart.js alongside recharts, and `@langchain/anthropic` in the root `package.json`.

---

## 6. What's already good (keep it)

- **Prior issues fixed:** the May P0s on documents link, document alerts and org auto-create race; the MFA prefix bypass; all 24 items in `UNGUARDED_SELECTS_AUDIT.md`; API CI.
- **API keys:** 32-byte random, stored hashed, revocation and expiry enforced, scope enforced, no key minting.
- **Outbound webhooks:** DNS-pinned SSRF guard, per-subscription HMAC.
- **Token-gated links:** share, doc-request and invitation tokens are 256-bit, with revoke and expiry. The portal download is bound to the shared deal, and its payload is whitelisted.
- **Uploads:** the signed-upload path check is strict (`staging/<orgId>/<uuid>/…`, segment and `..` checks), and magic bytes are validated on document upload.
- **AI layer:** prompt caching on every repeated-prefix call site, the AI-on-click rule honoured at every traced entry point, and solid error classification in `aiErrors.ts`. The deal-chat agent has a recursion limit, a timeout and input caps.
- **Frontend:** `dangerouslySetInnerHTML` is always sanitized (DOMPurify, plus an escaping markdown renderer). Middleware public prefixes are correct and tested. There's 1 `any` in web-next non-test code.
- **Database:** indexes are mostly right (org, dealId, usage composites), and the dedupe unique keys on integrations are in place.

---

## 7. Suggested PR sequence

| Order | PR | Size |
|---|---|---|
| 1–3 | Security PRs A–G, in the order the private advisory gives. Do these first. | S–M each |
| 4 | Rebase + merge **#143** (crons) | XS |
| 5 | `fix(ai): PDF extraction off Fable; rethrow provider errors in claudeDealReader; credit alert` (B2–B4) | S |
| 8 | `fix(perf): lean deal payloads, signed uploads everywhere, deletedAt view, runInBackground` (B6–B9) | M |
| 9 | `ci: npm ci, run org-isolation suite, lint all workspaces, turbo` (B10, B11) | S |
| 10+ | Roadmap §3 items 1→9, one per PR series | L |
