# AI Usage Tracking

> Per-user attribution of every AI call. Internal-only admin observability + kill-switch.
> Shipped: May 2026 (Session 64). Production deploy: lmmos.ai.

---

## Why it exists

Avise is in beta. Every user on the platform shares a single OpenAI/OpenRouter/Gemini/Anthropic API key. Before this system existed, there was zero per-user attribution of AI consumption. If a user — intentionally or not — triggered runaway token use (scripted abuse, a leaked auth token, a misbehaving agent loop), we had no way to know who caused it, no way to measure the impact, and no way to intervene before the invoice arrived.

Concretely: roughly 20 server files were making LLM calls with no idea who initiated them. The OpenAI/OpenRouter dashboard is a single unbucketed total. We could not answer "who consumed the most yesterday?" or "which operation drove the spike?" The system also needed to exist *now* — before any paid-tier work — so that when we introduce billing later, the attribution data is already there. Building it retroactively from API logs would be lossy and painful.

---

## What gets tracked

Every AI call that goes through the application is attributed to a specific User and Organization, with token counts, dollar cost (computed), operation label, model, provider, and duration:

- **LLM via LangChain factories** (`getChatModel`, `getFastModel`, `getExtractionModel`, `invokeStructured`) — covers all eight agents (Deal Chat, Financial, Memo, Firm Research, Contact Enrichment, Meeting Prep, Signal Monitor, Email Drafter).
- **LLM via raw OpenAI clients** (`trackedChatCompletion`, `trackedDirectChatCompletion`, `trackedDirectResponsesCreate` in `apps/api/src/openai.ts`) — covers the 11 remaining callsites that bypass LangChain.
- **Anthropic SDK direct** — the `crossVerifyNode` in the Financial Agent uses Claude Haiku for ensemble cross-verification; wrapped inline with `enforceUserGate` + `recordUsageEvent`.
- **Gemini embeddings** — `trackedEmbedDocuments` (RAG ingest) and `trackedEmbedQuery` (RAG retrieval) in `apps/api/src/rag.ts`. Operation labels: `gemini_embed_doc` / `gemini_embed_query`.
- **Apify Actor calls** — `searchViaApify` and `scrapeLinkedInProfile` in `apps/api/src/services/webSearch.ts`, wrapped via `trackedApifyCall`.
- **Azure Document Intelligence** — `extractTablesFromPdf` in `apps/api/src/services/azureDocIntelligence.ts`, wrapped via `trackedAzureDocIntelCall`.

Not yet tracked: streaming responses are handled on stream completion (aborted streams record `status='error'`). Background jobs that don't pass through an authenticated HTTP request need to call `runWithUsageContext()` explicitly; most agents are HTTP-initiated so this is largely covered.

---

## Architecture at a glance

```
HTTP request
    │
    ▼
authMiddleware          (sets req.user.id = Supabase Auth UUID)
    │
    ▼
orgMiddleware           (sets req.user.organizationId)
    │
    ▼
usageContextMiddleware  (async — resolves Auth UUID → internal User.id via
    │                    cached Map<authId, User.id>; binds {userId,
    │                    organizationId, requestId, source:'http'} into
    │                    AsyncLocalStorage for the request lifetime)
    │
    ▼
Route handler
    │
    ▼
Wrapped LLM / Apify / Azure call
    │  (LangChain: makeUsageHandler() passed at construction-time via
    │   callbacks array → handleLLMEnd fires after model returns)
    │  (Raw OpenAI: inline pre/post wrap)
    │  (Non-LLM: direct await before/after the actor/API call)
    │
    ▼
await recordUsageEvent(input)   ← MUST be awaited (Vercel kills void promises)
    │
    ├── getUsageContext()            reads AsyncLocalStorage
    ├── getModelPrice(model)         10-min TTL cache, single-flight load
    ├── getCreditsForOperation(op)   10-min TTL cache, single-flight load
    └── supabase.from('UsageEvent').insert(row)
            │
            ▼
    UsageEvent row persisted
```

The `usageContextMiddleware` is mounted on **every authenticated route** in all three API entry points: `app.ts`, `app-lite.ts`, and `app-ai.ts`. (Vercel routes requests to `app-lite.js` for most endpoints and `app-ai.js` for AI/memo/ingest/onboarding paths. `app.ts` is used only for local development. Wiring into only `app.ts` was Bug 1.)

---

## Database schema

All tables created by `apps/api/usage-tracking-migration.sql` (initial) and `apps/api/usage-tracking-addendum.sql` (granular ops + Anthropic haiku-4-5 price). Both are in production. Both are fully idempotent.

### UsageEvent — the truth ledger

One row per AI call.

```sql
CREATE TABLE public."UsageEvent" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"          uuid NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  "organizationId"  uuid NOT NULL REFERENCES public."Organization"(id) ON DELETE CASCADE,
  operation         text NOT NULL,
  model             text,                              -- null for non-LLM providers
  provider          text NOT NULL,                    -- see CHECK below
  "promptTokens"    integer DEFAULT 0,
  "completionTokens" integer DEFAULT 0,
  "totalTokens"     integer DEFAULT 0,
  units             integer DEFAULT 0,                -- non-LLM: searches, pages, chars
  "costUsd"         numeric(12,6) NOT NULL DEFAULT 0,
  credits           integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'success',  -- see CHECK below
  "durationMs"      integer,
  metadata          jsonb NOT NULL DEFAULT '{}',      -- requestId, dealId, documentId, etc.
  "createdAt"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_event_status_check
    CHECK (status IN ('success', 'error', 'rate_limited', 'blocked')),
  CONSTRAINT usage_event_provider_check
    CHECK (provider IN ('openai', 'openrouter', 'gemini', 'anthropic', 'apify', 'azure_doc_intelligence'))
);

-- Indexes
CREATE INDEX idx_usage_event_user_created ON public."UsageEvent" ("userId", "createdAt" DESC);
CREATE INDEX idx_usage_event_org_created  ON public."UsageEvent" ("organizationId", "createdAt" DESC);
CREATE INDEX idx_usage_event_operation    ON public."UsageEvent" (operation, "createdAt" DESC);
CREATE INDEX idx_usage_event_status       ON public."UsageEvent" (status) WHERE status <> 'success';
```

### ModelPrice — per-1M-token pricing reference

Seeded with 14+ models. Updated via PR when providers change prices.

```sql
CREATE TABLE public."ModelPrice" (
  model              text PRIMARY KEY,
  provider           text NOT NULL,
  "inputPricePer1M"  numeric(10,4) NOT NULL,
  "outputPricePer1M" numeric(10,4) NOT NULL,
  "updatedAt"        timestamptz NOT NULL DEFAULT now()
);
```

Seeded models include: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4-turbo` (OpenAI direct); `openai/gpt-4o`, `openai/gpt-4.1`, `anthropic/claude-sonnet-4.5`, `anthropic/claude-haiku-4.5`, `anthropic/claude-opus-4` (OpenRouter); `gemini-1.5-pro`, `gemini-1.5-flash` (Google); `claude-haiku-4-5-20251001` (Anthropic direct, added in addendum).

For non-LLM providers (Apify, Azure DocIntel, Gemini embeddings), unit pricing is stored in env vars (see [Env vars](#env-vars)) and passed as `unitCostUsd` to `recordUsageEvent`, bypassing the `ModelPrice` lookup.

### OperationCredits — operation → user-facing credits mapping

29 operations seeded (16 canonical from migration + 13 granular from addendum). Used for the user-facing "AI Usage" panel. Defaults to 1 credit + warn log if an operation is missing from the table.

```sql
CREATE TABLE public."OperationCredits" (
  operation   text PRIMARY KEY,
  credits     integer NOT NULL,
  description text
);
```

Selected seeds (see SQL files for the full list):

| operation | credits | description |
|---|---|---|
| `deal_chat` | 1 | One chat message in the deal chat agent |
| `financial_extraction` | 20 | Extract financial statements from a CIM or Excel |
| `firm_research` | 40 | Run firm research agent |
| `memo_generation` | 15 | Generate a memo or memo section |
| `web_search` | 1 | One Apify Google search call |
| `pdf_ocr` | 2 | One page of Azure Document Intelligence |
| `gemini_embed_doc` | 2 | Gemini embedding of a document's chunks |
| `gemini_embed_query` | 1 | Gemini embedding of a single RAG query |
| `emailDrafter.draft` | 5 | Email draft (subagent step) |
| `synthesize.firm` | 20 | Firm research synthesis |
| `deepResearch.queries` | 10 | Deep research query generation |

### UsageAlert — dormant dedup table

Originally built for a runaway-monitor email alert system that was removed per user feedback before shipping. Table kept in production (it costs nothing). Currently writes nothing. See [Limitations](#limitations--future-work).

```sql
CREATE TABLE public."UsageAlert" (
  "userId"    uuid NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  "alertDate" date NOT NULL,
  kind        text NOT NULL,   -- 'cost' | 'tokens'
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "alertDate", kind)
);
```

### User table additions

Three boolean flags added to the `User` table:

```sql
ALTER TABLE public."User"
  ADD COLUMN IF NOT EXISTS "isInternal"  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isThrottled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isBlocked"   boolean NOT NULL DEFAULT false;
```

- `isInternal` — Pocket Fund team flag. Grants access to `/api/internal/*` and the `/internal/usage` admin page. Seeded `true` for `dev@pocket-fund.com`, `ganeshjagtap006@gmail.com`, `hello@pocket-fund.com`.
- `isThrottled` — soft throttle: 1 request / 2 seconds per user. Set manually via admin Leaderboard action.
- `isBlocked` — hard kill-switch: all AI calls refuse with HTTP 403. Set manually via admin Leaderboard action.

Partial indexes on all three (`WHERE isInternal = true`, etc.) keep lookups fast without scanning the whole User table.

---

## Code map

### API (`apps/api/src/`)

| File | Purpose |
|---|---|
| `middleware/usageContext.ts` | AsyncLocalStorage context. Resolves Auth UUID → internal `User.id` (cached). Exports `getUsageContext()`, `runWithUsageContext()`, `usageContextMiddleware`. |
| `middleware/internalAdmin.ts` | `requireInternalAdmin` gate. Returns 404 (not 403) on denial to prevent route enumeration. |
| `services/usage/trackedLLM.ts` | `recordUsageEvent()` — the single ledger writer. Discriminated union input type: LLM mode (model + token counts) vs non-LLM mode (units + unitCostUsd). |
| `services/usage/modelPrices.ts` | `getModelPrice()` / `computeCostUsd()` — 10-min TTL in-memory cache with single-flight load from `ModelPrice` table. |
| `services/usage/operationCredits.ts` | `getCreditsForOperation()` — same TTL + single-flight pattern for `OperationCredits` table. |
| `services/usage/trackedApify.ts` | `trackedApifyCall()` — wraps Apify search + LinkedIn scrape with pre-call gate + post-call `recordUsageEvent`. |
| `services/usage/trackedAzureDocIntel.ts` | `trackedAzureDocIntelCall()` — wraps Azure DocIntel PDF extraction. Cost = pages × `AZURE_DOC_PRICE_PER_PAGE_USD`. |
| `services/usage/trackedEmbeddings.ts` | `trackedEmbedDocuments()` / `trackedEmbedQuery()` — wrap Gemini RAG embeddings. |
| `services/usage/userFlags.ts` | TTL cache for `isBlocked` / `isThrottled` flags (30s default). Keeps per-request DB lookups minimal. |
| `services/usage/throttle.ts` | In-process per-user 1 req / 2s sliding-window throttle. |
| `services/usage/enforcement.ts` | `enforceUserGate()` — checks blocked + throttled, throws `UserBlockedError` or applies delay. |
| `routes/internal-usage.ts` | Admin routes behind `requireInternalAdmin`: `GET /api/internal/usage/events`, `/leaderboard`, `/cost-breakdown`; `POST /api/internal/users/:userId/throttle`, `/block`. |
| `routes/usage.ts` | `GET /api/usage/me` — user-facing rollup (credits used this month + by-operation breakdown). |
| `openai.ts` | Exports `trackedChatCompletion`, `trackedDirectChatCompletion`, `trackedDirectResponsesCreate` alongside the original clients. Also re-exports `UserBlockedError`. |
| `services/llm.ts` | `makeUsageHandler(operation, modelName, provider)` — builds a LangChain callback handler. `trackModel(model, operation)` — attaches callbacks + gate to a compiled LangGraph runnable. `getChatModel` / `getFastModel` / `getExtractionModel` accept an `operation` label and pass `makeUsageHandler` at construction. `invokeStructured` wraps both primary + fallback through `trackModel`. |
| `utils/aiErrors.ts` | `classifyAIErrorObject()` — maps `UserBlockedError` → HTTP 403. |

### Frontend (`apps/web-next/src/`)

| File | Purpose |
|---|---|
| `app/(app)/internal/usage/page.tsx` | Top-level page. Checks `isInternal`, renders pill-group tabs (Live Feed / Leaderboard / Cost Breakdown). |
| `app/(app)/internal/usage/LiveFeed.tsx` | Paginated event table. Date presets (Today / 7d / 30d) with ISO timestamp fix. Status pills. Empty states. |
| `app/(app)/internal/usage/Leaderboard.tsx` | Per-user rollup table. Throttle / block action buttons. Deep-link to filtered Live Feed. |
| `app/(app)/internal/usage/CostBreakdown.tsx` | Stacked bar chart (react-chartjs-2, 30-day daily by operation) + reconciliation table + KPI strip. |
| `app/(app)/internal/usage/types.ts` | Shared types: `UsageEvent`, `LeaderboardEntry`, `CostBreakdownDay`. |
| `app/(app)/internal/usage/_ui.tsx` | Shared primitives: `PillGroup`, `StatusPill`, `EmptyState`, `Pill`, `ErrorPanel`. |
| `app/(app)/settings/AiUsageSection.tsx` | Passive settings panel. Shows credits used this month, progress bar (no cap line), by-operation breakdown. No $ amounts shown to users. |
| `app/(app)/settings/page.tsx` | Added "AI Usage" nav entry + section. |
| `types/index.ts` | Added `isInternal: boolean` to `AppUser`. |
| `providers/UserProvider.tsx` | Maps `isInternal` from `/api/users/me` response. Defaults to `false` in cached fallback. |

---

## How to extend

### Adding a new LLM provider

Example: adding Mistral.

1. Add `'mistral'` to the `UsageProvider` union in `services/usage/trackedLLM.ts`.
2. Add it to the `CONSTRAINT usage_event_provider_check` CHECK in Supabase (via a migration SQL `ALTER TABLE ... ADD CONSTRAINT` or by modifying and re-running the constraint). Alternatively, drop + re-add the constraint with the new value in the list.
3. Seed `ModelPrice` rows for the models you'll use:
   ```sql
   INSERT INTO public."ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M")
   VALUES ('mistral-large', 'mistral', 4.0000, 12.0000)
   ON CONFLICT (model) DO UPDATE SET ...;
   ```
4. If using a LangChain-compatible model class, pass `makeUsageHandler(operation, modelName, 'mistral')` in the constructor's `callbacks` array — exactly as `getChatModel()` does for OpenAI.
5. If using a raw SDK, wrap calls with `trackedChatCompletion`-style pre/post logic: `enforceUserGate()` before, `await recordUsageEvent({ model, promptTokens, completionTokens, provider: 'mistral', operation, status })` after.

The critical rule: **pass callbacks at construction time**, not after. Post-hoc mutation (`model.callbacks = [...]`) does not propagate through `bindTools()` or `withStructuredOutput()` in LangChain v1+. This was Bug 2.

### Adding a new agent

1. Build the agent following the pattern in `docs/architecture/ai-agents.md` (state.ts → nodes/ → graph.ts → index.ts).
2. Call `getChatModel(temp, maxTokens, 'your_operation_label')` / `getFastModel('your_operation_label')` — the operation label flows into `makeUsageHandler` automatically. Never call `new ChatOpenAI()` directly.
3. For `invokeStructured` calls inside the agent, pass a `label` option matching an `OperationCredits` operation key.
4. Seed an `OperationCredits` row for the operation (see addendum SQL pattern). If you skip this, the wrapper defaults to 1 credit and logs a warning — not a failure, but the user-facing panel will show generic credits.
5. No changes needed to `recordUsageEvent`, `usageContextMiddleware`, or any other tracking infrastructure.

### Adding a new operation type

1. Insert into `OperationCredits` via SQL (idempotent `ON CONFLICT DO UPDATE`):
   ```sql
   INSERT INTO public."OperationCredits" (operation, credits, description)
   VALUES ('my_new_operation', 10, 'Human-readable description shown in Settings')
   ON CONFLICT (operation) DO UPDATE SET credits = EXCLUDED.credits, description = EXCLUDED.description;
   ```
2. Pass `operation: 'my_new_operation'` in the `recordUsageEvent` call (or as the third argument to `getChatModel` / `getFastModel`).
3. The `getCreditsForOperation()` function will pick it up on the next cache TTL expiry (10 min) without a deploy.

---

## Operating runbook

### Daily checks

Visit `/internal/usage` as an internal admin user (`isInternal=true`). Check:
- **Leaderboard** — sort by "30d cost" to spot outliers. An anomaly flag appears when a user's daily cost exceeds 3× their 30-day average.
- **Cost Breakdown** — compare the daily stacked bar against prior days; an unusual spike in a single operation category is the first signal of a runaway loop.
- **Live Feed** — filter to "errors only" toggle to surface any `status='error'` events (LLM timeouts, refused calls, FK violations).

### Block or throttle a user

1. Go to `/internal/usage` → Leaderboard tab.
2. Find the user row. Click the **Throttle** or **Block** button in the actions column.
3. The API calls `POST /api/internal/users/:userId/throttle` or `.../block` which sets `User.isThrottled` / `User.isBlocked = true` in Supabase.
4. The `userFlags.ts` TTL cache expires in ~30 seconds. After that, the next AI call from that user hits the gate.

To unblock: click the same button again (it's a toggle). The admin API accepts `{ active: false }` in the body to clear the flag.

### Verify tracking is working

Run this in Supabase SQL editor:

```sql
-- Confirm events are landing
SELECT COUNT(*), MAX("createdAt") FROM public."UsageEvent";

-- Recent events with user attribution
SELECT
  u.email,
  ue.operation,
  ue.model,
  ue.provider,
  ue."totalTokens",
  ue."costUsd",
  ue."createdAt"
FROM public."UsageEvent" ue
JOIN public."User" u ON ue."userId" = u.id
ORDER BY ue."createdAt" DESC
LIMIT 20;

-- Events in last hour (sanity check after a deploy)
SELECT COUNT(*) FROM public."UsageEvent"
WHERE "createdAt" > NOW() - INTERVAL '1 hour';
```

To trace a specific request end-to-end, filter by `metadata->>'requestId'` using the `x-request-id` header value from the API response.

If events stopped landing: check Vercel function logs. Filter for `[usage]` (these logs exist as of PR #18; PR #22 proposes removing them — check if merged). The sequence `handleLLMEnd FIRED → recordUsageEvent ENTRY → inserting UsageEvent row → insert OK` confirms each layer. A gap in the sequence pinpoints the failure layer.

### Reconcile against OpenRouter / provider dashboard

1. Open Cost Breakdown tab → set date range to the last 7 days.
2. Note the total `$ cost` displayed.
3. Open the OpenRouter dashboard (or OpenAI / Anthropic as applicable) and pull the same 7-day window.
4. Expect match within ~2%. Divergence over 5% likely means: a model string is missing from `ModelPrice` (cost recorded as $0 — look for `priceLookupFailed=true` in `metadata`), or a new callsite bypasses the tracking wrappers.

To find untracked callsites:

```bash
# Find any direct 'new OpenAI()' or 'openai.chat.completions.create' not going through wrappers
grep -r "new OpenAI()" apps/api/src/ --include="*.ts" | grep -v openai.ts
grep -r "openai\.chat\.completions\.create" apps/api/src/ --include="*.ts" | grep -v openai.ts
grep -r "createModel\b" apps/api/src/ --include="*.ts" | grep -v llm.ts
```

---

## Known gotchas — the 5 bugs that took 5 PRs to fix

These took the full session to debug. Each was upstream of the next, hiding it until the prior fix landed.

### Bug 1 — Routes only mounted in `app.ts` (PR #16)

**What it looked like:** Admin routes returned 404. No `UsageEvent` rows appeared.

**Why it was subtle:** `app.ts` is the local-dev entry point. On Vercel, the API is served by `app-lite.js` (the default bundle for most routes) and `app-ai.js` (selected by `apps/web-next/src/lib/api-bundles.ts` for AI, memo, ingest, and onboarding paths). The new middleware and routes had only been wired into `app.ts`.

**Fix:** Mount `usageContextMiddleware` on every authenticated route in `app-lite.ts` (16 routes) and `app-ai.ts` (6 routes). Mount `internalRouter` and `usageRouter` in `app-lite.ts`. As a side cleanup: removed dead `pe-os.onrender.com` from CORS allowlists (Render is the legacy host, no longer used) and updated the OpenRouter `HTTP-Referer` header to `lmmos.ai`.

**Remember:** Any new middleware that needs to run on every API call in production must be added to all three entry points, not just `app.ts`.

### Bug 2 — LangChain post-construction callback mutation (PR #17)

**What it looked like:** Routes were live, middleware was firing, but `UsageEvent` count stayed at 0. LangChain agents showed no tracking.

**Why it was subtle:** The first implementation did `(model as any).callbacks = [myCallback]` after constructing the `ChatOpenAI` instance. In `@langchain/openai` v1+, when LangGraph's `createReactAgent` calls `model.bindTools(tools)`, the resulting bound runnable snapshots config at that moment — from the constructor, not from post-hoc mutation. Post-construction callback assignment is silently ignored.

**Fix:** Build `makeUsageHandler(operation, modelName, provider)` as a LangChain `BaseCallbackHandler` and pass it into the `ChatOpenAI` / `ChatGoogleGenerativeAI` constructor's `callbacks` array. Construction-time callbacks propagate correctly through `bindTools()` and `withStructuredOutput()`. Same fix applied to `invokeStructured`.

**Remember:** Never attach LangChain callbacks after construction. Always pass them via the constructor.

### Bug 3 — Vercel lambda freezes void promises (PR #19)

**What it looked like:** Diagnostic logs showed `handleLLMEnd FIRED` and `recordUsageEvent ENTRY` but no `inserting UsageEvent row` log, and no rows in Supabase.

**Why it was subtle:** The original code used `void recordUsageEvent(...)` — fire-and-forget. Once the LLM response was sent to the client, Vercel froze the lambda execution. The pending Supabase insert promise was abandoned mid-flight.

**Fix:** Replace all 17 `void recordUsageEvent(...)` calls across 6 files with `await recordUsageEvent(...)`. LangChain's `handleLLMEnd` and `handleLLMError` are now `async` — LangChain awaits these inside the agent loop, holding the response until the insert completes. Latency cost: ~50–100ms per AI call. This is acceptable for accurate tracking.

**Remember:** On Vercel (and any serverless platform with rapid lambda freeze), fire-and-forget async code after the response is sent will not run. Anything that must persist must be awaited before the response.

### Bug 4 — authId vs internal User.id FK violation (PR #21) — THE bug

**What it looked like:** `recordUsageEvent` now logged `inserting UsageEvent row`, but the insert failed with Postgres FK violation error 23503: `Key (userId)=(<uuid>) is not present in table "User"`.

**Why it was subtle:** `req.user.id` is the Supabase Auth UUID — the `authId` column on the `User` table, not the `id` column. `UsageEvent.userId` is a FK to `User.id` (the internal database UUID — a different value for every user). The middleware was passing the auth UUID; every single insert silently failed. The previous three bugs masked this one — each upstream fix was necessary before this error could even surface.

**Fix:** `usageContextMiddleware` is now async. It resolves `req.user.id` (auth UUID) to `User.id` (internal id) via `SELECT id FROM "User" WHERE "authId" = $1`. The result is cached in a process-level `Map<authId, User.id>` — the internal id never changes for a given auth user, so one DB query per process lifetime per user is sufficient.

**Remember:** Never assume `req.user.id` is the same as `User.id`. They are not. The canonical way to bridge them is `usageContextMiddleware`; don't replicate this resolution elsewhere.

### Bug 5 — Live Feed bare-date timestamptz mismatch + infinite render loop (PR #23, #24)

**What it looked like:** Tracking confirmed working (29 events, correct costs/tokens/models showing in Leaderboard and Cost Breakdown). But Live Feed tab showed "No matching events" for today's date.

**Why it was subtle:** The Live Feed sent bare `YYYY-MM-DD` strings as `from` / `to` query params. Supabase interprets a bare date against a `timestamptz` column as `00:00:00 UTC`. So `to=2026-05-06` excluded events created at `2026-05-06 16:06:54 UTC` because the range ended at midnight. In the same PR, a React `useEffect` dependency array had the date state included, causing the fetch to retrigger on every render (infinite loop).

**Fix:** `presetToFrom()` returns `startOfDayUtc` as a full ISO timestamp (e.g. `2026-05-06T00:00:00.000Z`); `presetToTo()` returns `new Date().toISOString()` (the current moment, not midnight). Custom date inputs convert via `customDateToIso(value, 'from' | 'to')`. The `useEffect` dependency array was corrected to exclude the date values themselves (use a stable fetch trigger instead).

---

## Limitations and future work

- **Streaming responses.** Token counts for streaming calls are captured on stream completion via `handleLLMEnd`. If a user aborts the stream mid-response, the callback may still fire with partial token counts (depending on LangChain internals), and `status='error'` is recorded. This is acceptable — the cost was already incurred.
- **Real-time Live Feed.** Currently the feed is a polled table query (on tab focus + manual refresh). No WebSocket push. For the current scale (internal admin team of 3), this is fine.
- **No quota enforcement.** Beta is free. The `isThrottled` / `isBlocked` flags are the only enforcement levers. Quota-based billing will require adding a `quota` column per org and a pre-call check in `enforceUserGate()`.
- **Email alerts removed.** The original design spec included a `runawayMonitor.ts` that emailed `INTERNAL_ALERT_EMAIL` when a user's daily $ or token total crossed a threshold. Removed before shipping — `email.ts` and `runawayMonitor.ts` were deleted. The `UsageAlert` table is kept dormant (the dedup logic is correct; it just needs a caller). Admin uses Leaderboard sort to detect abuse and acts manually.
- **`apps/api/src/gemini.ts` was deleted.** This file was a zero-importer leftover from the pre-LangChain era. Verified no imports before deletion.
- **PR #22** (removing diagnostic `[usage]` info-level logs added in PR #18) was open at end of session. If merged, the Vercel log filter `[usage]` approach described in the runbook may no longer work. Check current source.
- **Tracking regression suspicion** (end of Session 64): event count was stable at 29 at close of session. A fresh chat test did not appear to increment the count. This could be a non-LLM chat path (some chat interactions short-circuit before hitting the LLM) or a genuine regression. **Verify next session** by sending a deliberate new chat message and checking Supabase immediately.

---

## Env vars

Four environment variables control the per-unit pricing for non-LLM providers. Set in Vercel project settings (not committed to `.env` — these are prod-only tunable values).

| Variable | Default | Controls |
|---|---|---|
| `APIFY_PRICE_PER_SEARCH_USD` | `0.005` | Cost per `searchViaApify()` call |
| `APIFY_PRICE_PER_LINKEDIN_PROFILE_USD` | `0.02` | Cost per `scrapeLinkedInProfile()` call |
| `AZURE_DOC_PRICE_PER_PAGE_USD` | `0.0015` | Cost per page of Azure Document Intelligence extraction |
| `GEMINI_EMBED_PRICE_PER_1K_CHARS_USD` | `0.000025` | Cost per 1,000 characters embedded via Gemini |

These values are read at call time (no restart required to take effect). If a variable is absent, the code defaults to the values above — update these defaults in `trackedApify.ts` / `trackedAzureDocIntel.ts` / `trackedEmbeddings.ts` if the actual pricing changes.

---

## Migration history

| File | When | What it does |
|---|---|---|
| `apps/api/usage-tracking-migration.sql` | Session 64, May 6 2026 | Creates `UsageEvent`, `ModelPrice`, `OperationCredits`, `UsageAlert` tables. Adds `isInternal`, `isThrottled`, `isBlocked` columns to `User`. Seeds 14 model prices and 13 canonical operations. Seeds `isInternal=true` for Pocket Fund team emails. Run in a single transaction. |
| `apps/api/usage-tracking-addendum.sql` | Session 64, May 6 2026 (same day, after initial) | Inserts 16 additional `OperationCredits` rows: 3 canonical (`email_drafting`, `contact_enrichment`, `linkedin_scrape`) + 11 granular `invokeStructured` labels + 2 Gemini embedding ops. Adds `claude-haiku-4-5-20251001` to `ModelPrice` (Anthropic direct, used by `crossVerifyNode`). |

Both files are idempotent (`ON CONFLICT DO UPDATE`). Safe to re-run. Run addendum after migration.

**Verification queries** (run after applying):

```sql
SELECT COUNT(*) FROM public."ModelPrice";        -- expect >= 15
SELECT COUNT(*) FROM public."OperationCredits";  -- expect >= 29
SELECT email, "isInternal" FROM public."User" WHERE "isInternal" = true;
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'User' AND column_name IN ('isInternal','isThrottled','isBlocked');
```

---

## Where to look first if tracking breaks

1. **Supabase first:** `SELECT COUNT(*), MAX("createdAt") FROM public."UsageEvent";` — confirms whether any events are landing at all.
2. **Vercel function logs:** Filter for `[usage]`. The sequence `handleLLMEnd FIRED → recordUsageEvent ENTRY → inserting UsageEvent row → insert OK` tells you exactly which layer broke.
3. **Most likely future failure modes:**
   - New auth user whose `User` row hasn't been created yet — `usageContextMiddleware` lookup fails, logs a warn, no-ops. Tracking is best-effort in this case.
   - New LangGraph agent path that calls `new ChatOpenAI()` directly instead of `getChatModel()` — won't have callbacks. Search for `createModel` callsites outside `llm.ts`.
   - New third-party integration (e.g., an MCP tool) making AI calls without going through `recordUsageEvent` — silent gap. Regular Supabase vs provider cost reconciliation (see runbook) catches these.
