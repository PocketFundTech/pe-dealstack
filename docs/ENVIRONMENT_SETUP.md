# Environment Variables Reference

This document lists every environment variable used by Avise.

---

## Backend (`apps/api/.env`)

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon/public key | `eyJhbGc...` |

The server will exit on startup if these are missing.

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3001` |
| `NODE_ENV` | `development` or `production` | `development` |

### AI Services (optional)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4 chat, thesis generation, and memo AI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `GEMINI_API_KEY` | Google Gemini API key for RAG document search | [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey) |
| `ANTHROPIC_API_KEY` | Anthropic API key — preferred tier-1 provider (deal chat, memos, extraction reasoning, financial cross-verification via `@langchain/anthropic`) | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| `ANTHROPIC_OAUTH_TOKEN` | **Alternative** to `ANTHROPIC_API_KEY` — use only when you have a Claude subscription OAuth access token instead of a standard API key. See below. | `claude setup-token` (Claude Code CLI) |

AI features gracefully degrade when keys are missing — the app works without them, but AI chat and document analysis will be disabled.

#### `ANTHROPIC_OAUTH_TOKEN` — alternative Claude auth

Every Claude-gated call site in this codebase (`services/anthropic.ts`, `utils/aiModels.ts`, `services/claudeFinancialClassifier.ts`, `services/financialCrossVerify.ts`, `services/ai/client.ts`, `services/llm.ts`, the financial-agent cross-verify node) accepts **either** `ANTHROPIC_API_KEY` **or** `ANTHROPIC_OAUTH_TOKEN` — you do not need both. Priority when both happen to be set: `ANTHROPIC_API_KEY` always wins, since it's the existing, unambiguous mechanism and every other caller already assumes it — `ANTHROPIC_OAUTH_TOKEN` is a fallback for setups that don't have (or don't want to use) a standard API key.

- **Format:** `sk-ant-oat01-...` — a Claude subscription OAuth access token, distinct from a standard API key (`sk-ant-api03-...`). Minted with `claude setup-token` (the Claude Code CLI) or the equivalent Claude Agent SDK OAuth login flow. Requires a Claude Pro, Max, Team, or Enterprise plan on the account you authenticate with.
- **How it authenticates (different from a standard key):** an API key is sent as the `x-api-key` header; an OAuth token is *not*. It's sent as `Authorization: Bearer <token>`, and the Messages API additionally requires the `anthropic-beta: oauth-2025-04-20` header on that auth path. Sending both an API key and an OAuth token in the same request is rejected — this codebase's auth resolution (`resolveAnthropicAuth()` in `services/anthropic.ts`) only ever sends one.
- **Expiry — known limitation, no auto-refresh:** `claude setup-token` tokens are valid for **about one year** and have no refresh-token counterpart — Anthropic's own docs describe minting a fresh one interactively when it lapses, not a background refresh call. Nothing in this codebase renews `ANTHROPIC_OAUTH_TOKEN` automatically, so when it expires every Claude call using it will start failing with 401s until someone manually generates a new token (`claude setup-token`) and updates the env var. If this matters for your deployment, prefer `ANTHROPIC_API_KEY` instead, or set a calendar reminder to rotate the token well before its ~1-year expiry.

### Outreach contact enrichment (optional — Cicero Capital board only)

Powers the "Enrich" action on the Outreach pipeline board (`POST /api/outreach/contacts/:id/enrich`, gated to the Cicero Capital org — see `requireCiceroCapital` in `middleware/orgScope.ts`). Each provider is independently optional; the route no-ops with a `200 { enriched: false, reason: 'No enrichment providers configured yet' }` when none are set, and activates automatically (no code changes) the moment a key is added.

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `APOLLO_API_KEY` | Apollo.io People Match/Enrich API key | [app.apollo.io/#/settings/integrations/api](https://app.apollo.io/#/settings/integrations/api) |
| `ANYMAIL_FINDER_API_KEY` | Anymail Finder "find a person's email" API key | [anymailfinder.com/dashboard/api](https://anymailfinder.com/dashboard/api) |
| `CLAY_API_KEY` | Clay workspace API key — sent as `Authorization: Bearer` on our webhook POST | Clay workspace settings |
| `CLAY_WEBHOOK_URL` | Per-table webhook URL generated inside Clay's UI (Sources → Webhook) | Created per-workspace inside Clay, not a fixed host |

Clay is architecturally different from the other two: it has no synchronous "enrich and get data back" REST API, only a per-table webhook you POST a contact to, which Clay enriches asynchronously (minutes, not milliseconds) via columns configured in its UI. `CLAY_API_KEY` alone does nothing — `CLAY_WEBHOOK_URL` must also be set, and the integration only *submits* contacts today (see `services/outreachEnrichment.ts` for the full explanation and sourcing). Apollo and Anymail Finder are true synchronous request/response APIs and need only their one key each.

### Reply.io send + reply tracking (optional — Cicero Capital board only)

Powers the "Send" action on the Outreach pipeline board (`GET /api/outreach/campaigns` to list Reply.io campaigns, `POST /api/outreach/contacts/:id/send` to enroll a contact) and inbound reply tracking (`POST /api/webhooks/reply-io/:secret`, mounted unauthenticated in `app.ts`/`app-lite.ts`). See `services/replyIoService.ts` for the researched API version and webhook-signing details (checked against docs.reply.io, including its full OpenAPI spec, Aug 2026).

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `REPLY_IO_API_KEY` | Reply.io v3 API key, sent as `Authorization: Bearer <key>` against `api.reply.io/v3` | Reply.io → Settings → API Key |
| `REPLY_IO_WEBHOOK_SECRET` | A long random value **we** define (e.g. `openssl rand -hex 32`) — Reply.io issues nothing equivalent | Generate it yourself |

`REPLY_IO_API_KEY` unset → `GET /campaigns` and `POST /contacts/:id/send` both return a "not configured" response (200) instead of erroring, same soft-fail pattern as the enrichment providers above.

Reply.io does not sign or authenticate its outbound webhook calls in any way — no signature header, no HMAC, no shared-secret mechanism exists on their side (confirmed by searching their entire bundled OpenAPI spec for "signature"/"hmac"/"secret": zero matches). `REPLY_IO_WEBHOOK_SECRET` is therefore our own scheme: set it here, then give Reply.io the **exact same value** as a URL path segment when registering the webhook subscription on their side — `https://<your-api-domain>/api/webhooks/reply-io/<that value>` — either via their dashboard (Settings → Integrations → Webhooks → Add webhook, event = "Contact replied"/"Email replied") or via `POST /v3/webhooks` on their API (both are supported; the dashboard is not the only option). Leaving `REPLY_IO_WEBHOOK_SECRET` unset means the webhook route rejects every inbound request with 401 — fail closed, not silently-open.

### Clay inbound sourcing webhook (optional — Cicero Capital board only)

Powers `POST /api/webhooks/clay-import/:secret` — the reverse direction from the Clay enrichment integration above (Clay calling **us**, not us calling Clay). Clay has no query/search API to call outward, so sourcing works by a human filtering/synthesizing a company list inside Clay's own UI (industry, location, employee size), then Clay pushes the resulting rows out via an outbound "Send Webhook" action a human configures inside Clay's table. See `services/outreachClayImport.ts` for the full expected payload shape and de-dupe logic.

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `CLAY_IMPORT_WEBHOOK_SECRET` | A long random value **we** define (e.g. `openssl rand -hex 32`) — same "our own shared secret in the URL" scheme as `REPLY_IO_WEBHOOK_SECRET`, since Clay can't sign or authenticate this call for us either | Generate it yourself |

Operator setup:
1. Generate a secret and set it here.
2. Inside Clay's table, add a "Send Webhook" (or equivalent HTTP output) action pointed at `https://<your-api-domain>/api/webhooks/clay-import/<that same value>`.
3. Map Clay's column output to the payload shape documented at the top of `services/outreachClayImport.ts` — `companyName` is required; `contactName`, `email`, `phone`, `title`, `linkedinUrl`, `location`, `employeeSize`, `industry`, `sourceUrl`, and `cin` (Corporate Identification Number, the most reliable de-dupe key when available) are all optional. The payload can be a bare array of rows, `{ "rows": [...] }`, or a single un-wrapped row object, depending on how Clay's action is configured to fire.

De-duplication is deliberately conservative: an exact CIN, email, or normalized-company-name match updates the existing contact; anything less certain (fuzzy/partial name similarity, no email or CIN to confirm) creates a **new** contact flagged `needsMatchReview: true` for a human to resolve rather than silently merging. Leaving `CLAY_IMPORT_WEBHOOK_SECRET` unset means the webhook route rejects every inbound request with 401 — fail closed, same as Reply.io's webhook.

### AI Usage Tracking (optional — pricing tuning)

These four variables control the per-unit cost recorded for non-LLM AI providers. Defaults are hardcoded in source; set in Vercel project settings to override without a deploy.

| Variable | Default | Controls |
|----------|---------|---------|
| `APIFY_PRICE_PER_SEARCH_USD` | `0.005` | Cost per Apify Google search call |
| `APIFY_PRICE_PER_LINKEDIN_PROFILE_USD` | `0.02` | Cost per Apify LinkedIn scrape |
| `AZURE_DOC_PRICE_PER_PAGE_USD` | `0.0015` | Cost per Azure Document Intelligence page |
| `GEMINI_EMBED_PRICE_PER_1K_CHARS_USD` | `0.000025` | Cost per 1K chars embedded via Gemini |

See [`docs/AI-USAGE-TRACKING.md`](AI-USAGE-TRACKING.md) for the full tracking architecture.

### Monitoring (optional)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `SENTRY_DSN` | Sentry DSN for backend error tracking | [sentry.io](https://sentry.io) → Project Settings → Client Keys |

Sentry is only initialized when `NODE_ENV=production` and `SENTRY_DSN` is set.

### Full `.env.example`

```bash
# Supabase Configuration (REQUIRED)
# Get these from https://supabase.com/dashboard/project/_/settings/api
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_ANON_KEY="your-supabase-anon-key"

# Server Configuration
PORT=3001
NODE_ENV=development

# Anthropic Configuration (preferred tier-1 provider)
# Get your API key from https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-your-anthropic-api-key
# Alternative to ANTHROPIC_API_KEY — a Claude subscription OAuth access
# token (sk-ant-oat01-...) minted via `claude setup-token`. Do not set
# both; ANTHROPIC_API_KEY always wins when present. See "AI Services"
# above for the expiry caveat.
ANTHROPIC_OAUTH_TOKEN=

# OpenAI Configuration (for AI features)
# Get your API key from https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your-openai-api-key

# Gemini API Configuration (for RAG)
# Get your API key from https://makersuite.google.com/app/apikey
GEMINI_API_KEY=your-gemini-api-key

# Sentry Error Tracking (optional)
# Get your DSN from https://sentry.io/settings/projects/
SENTRY_DSN=
```

---

## Frontend (`apps/web/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL (same as backend) | `https://xxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (same as backend) | `eyJhbGc...` |
| `VITE_API_URL` | Backend API base URL | `http://localhost:3001/api` |
| `VITE_SENTRY_DSN` | Sentry DSN for frontend error tracking (optional) | `https://xxx@sentry.io/xxx` |

All `VITE_` variables are injected at build time by Vite and baked into the static bundle. Changing them requires a rebuild.

In production, `VITE_API_URL` is not needed — the frontend is served by the same Express server as the API, so API calls use relative paths.

### Full `.env.example`

```bash
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key
VITE_API_URL=http://localhost:3001/api

# Sentry Error Tracking (optional)
VITE_SENTRY_DSN=
```

---

## Render (Production)

Only the **backend** environment variables need to be set in Render. The frontend variables are baked in at build time.

### Variables to set in Render Dashboard

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | Your Supabase URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `OPENAI_API_KEY` | Your OpenAI key |
| `GEMINI_API_KEY` | Your Gemini key |
| `SENTRY_DSN` | Your backend Sentry DSN |

`PORT` is automatically set by Render — do not set it manually.

---

## How Variables Are Used

### Authentication Flow

1. Frontend uses `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to authenticate users via Supabase Auth
2. Frontend sends the Supabase JWT as a `Bearer` token in API requests
3. Backend uses `SUPABASE_URL` + `SUPABASE_ANON_KEY` to verify the token via `supabase.auth.getUser(token)`

### AI Feature Detection

The `/health/ready` endpoint reports which AI services are configured:

```json
{
  "services": {
    "openai": { "ok": true, "configured": true },
    "gemini": { "ok": false, "configured": false }
  }
}
```

The frontend checks `/api/ai/status` to determine whether to show AI features.

### Sentry

- **Backend**: Sentry is initialized in `src/index.ts` with `Sentry.init()` and captures unhandled errors via `Sentry.setupExpressErrorHandler(app)`
- **Frontend**: Sentry CDN bundle is injected by Vite's HTML transform plugin. It reads `VITE_SENTRY_DSN` from `window.__ENV` at page load

---

**Last Updated:** August 24, 2026
