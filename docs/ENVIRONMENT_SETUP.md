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

AI features gracefully degrade when keys are missing — the app works without them, but AI chat and document analysis will be disabled.

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

**Last Updated:** February 13, 2026
