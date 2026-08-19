# Avise Deployment Runbook

**Platform:** Render.com
**Production URL:** https://pe-os.onrender.com

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      Render.com                          │
│                                                          │
│   ┌──────────────────────────────────────────────────┐  │
│   │          Avise Web Service (Free tier)            │  │
│   │          Node.js — Express API + Static Frontend  │  │
│   │                                                    │  │
│   │  Build: npm ci --include=dev && npm run build:prod│  │
│   │  Start: NODE_ENV=production node dist/index.js    │  │
│   │  Health: /health                                  │  │
│   └──────────────────────────────────────────────────┘  │
│                          │                               │
└──────────────────────────│───────────────────────────────┘
                           │
         ┌─────────────────┼──────────────────┐
         │                 │                  │
         ▼                 ▼                  ▼
┌─────────────────┐ ┌──────────────┐ ┌───────────────┐
│    Supabase     │ │   OpenAI     │ │    Sentry     │
│  PostgreSQL     │ │   GPT-4     │ │  Error        │
│  Auth + Storage │ │   Analysis   │ │  Tracking     │
└─────────────────┘ └──────────────┘ └───────────────┘
                    ┌──────────────┐
                    │   Gemini     │
                    │   RAG        │
                    └──────────────┘
```

---

## Environment Variables

See [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) for the full reference.

### Required for Render

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `OPENAI_API_KEY` | OpenAI API key (for AI features) |

### Recommended

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key (for RAG) |
| `SENTRY_DSN` | Sentry DSN for **backend** error tracking |

Note: The frontend Sentry DSN (`VITE_SENTRY_DSN`) is baked into the build at compile time via Vite — it does not need to be set in Render.

---

## Initial Setup

### 1. Create Render Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name:** `pe-os`
   - **Region:** Oregon (US West)
   - **Branch:** `main`
   - **Root Directory:** (leave empty)
   - **Runtime:** Node
   - **Build Command:** `npm ci --include=dev && npm run build:prod`
   - **Start Command:** `npm run start:prod`
   - **Instance Type:** Free (or Starter for production)
5. Add environment variables (see table above)
6. Set **Health Check Path** to `/health`

### 2. Using render.yaml (Blueprint)

Alternatively, deploy with the included `render.yaml`:

```yaml
services:
  - type: web
    name: pe-os
    runtime: node
    region: oregon
    plan: free
    buildCommand: npm ci --include=dev && npm run build:prod
    startCommand: npm run start:prod
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: GEMINI_API_KEY
        sync: false
```

---

## Deployment Process

### Automatic Deploys

Pushes to the `main` branch trigger automatic deployments.

### Manual Deploy

1. Render Dashboard → pe-os service
2. Click **Manual Deploy** → **Deploy latest commit**

### Verify Deployment

```bash
# Fast health check (used by Render)
curl https://pe-os.onrender.com/health

# Comprehensive readiness check
curl https://pe-os.onrender.com/health/ready
```

**`/health` response:**
```json
{ "status": "ok", "timestamp": "2026-02-13T00:00:00.000Z" }
```

**`/health/ready` response:**
```json
{
  "timestamp": "2026-02-13T00:00:00.000Z",
  "status": "healthy",
  "services": {
    "database": { "ok": true, "latencyMs": 45 },
    "openai": { "ok": true, "configured": true },
    "gemini": { "ok": true, "configured": true },
    "sentry": { "ok": true, "configured": true }
  }
}
```

Returns `200` if all services are healthy, `503` if degraded or unhealthy.

---

## Rate Limiting

The API uses tiered rate limiting:

| Tier | Scope | Limit |
|------|-------|-------|
| General | All `/api/` routes | 200 requests / 15 min |
| AI | `/api/ai`, `/api/memos/*/chat`, `/api/memos/*/sections/*/generate` | 10 requests / 1 min |
| Write | `/api/ingest` | 30 requests / 1 min |

Exceeding limits returns `429 Too Many Requests`.

---

## Monitoring

### Sentry Error Tracking

- **Backend:** Errors are sent to Sentry automatically when `SENTRY_DSN` is set
- **Frontend:** Errors are captured via the Sentry CDN bundle (DSN baked at build time)
- Dashboard: https://pocketfund.sentry.io

### Render Logs

View logs in Render Dashboard → pe-os → **Logs**

### Key Metrics to Watch

- Health check response time
- 5xx error rate
- Database latency (visible via `/health/ready`)
- Rate limit hits (429 responses)

---

## Rollback Procedure

### Quick Rollback

1. Render Dashboard → pe-os → **Events**
2. Find the last successful deploy
3. Click **Rollback to this deploy**

### Git Rollback

```bash
git revert HEAD
git push origin main
# Render auto-deploys the revert
```

---

## AI Usage Tracking — Migration Steps

If deploying to a fresh Supabase project or a project that doesn't yet have the usage tracking tables, run these two SQL files in order via the Supabase SQL Editor:

1. `apps/api/usage-tracking-migration.sql` — creates all four tables (`UsageEvent`, `ModelPrice`, `OperationCredits`, `UsageAlert`), adds User flag columns, seeds model prices and canonical operations.
2. `apps/api/usage-tracking-addendum.sql` — adds granular operation labels and Anthropic haiku pricing.

Both are idempotent. Run addendum after migration. Verify with:

```sql
SELECT COUNT(*) FROM public."ModelPrice";        -- expect >= 15
SELECT COUNT(*) FROM public."OperationCredits";  -- expect >= 29
```

See [`docs/AI-USAGE-TRACKING.md`](AI-USAGE-TRACKING.md) for the full migration reference.

---

## Pre-Deployment Checklist

- [ ] All tests passing (`cd apps/api && npm test`)
- [ ] Build succeeds locally (`npm run build:prod`)
- [ ] Environment variables set in Render
- [ ] Database migrations applied (if any — including `usage-tracking-migration.sql` + `usage-tracking-addendum.sql` on new environments)
- [ ] No secrets in committed code

## Post-Deployment Checklist

- [ ] `/health` returns `ok`
- [ ] `/health/ready` returns `healthy`
- [ ] Login flow works
- [ ] Create deal flow works
- [ ] Document upload works
- [ ] AI chat responds
- [ ] No new errors in Sentry

---

## Scaling

| Render Plan | RAM | CPU | Notes |
|-------------|-----|-----|-------|
| Free | 512MB | Shared | Sleeps after 15 min inactivity |
| Starter ($7/mo) | 512MB | Shared | Always on |
| Standard ($25/mo) | 2GB | Dedicated | Recommended for production |

### Database (Supabase)

| Plan | Connections | Storage | Backups |
|------|------------|---------|---------|
| Free | 60 | 500MB | Daily, 7-day retention |
| Pro ($25/mo) | 200 | 8GB | Daily, 30-day retention + PITR |

---

## Emergency Procedures

### Service Down

1. Check [Render Status](https://status.render.com)
2. Check [Supabase Status](https://status.supabase.com)
3. Check logs for errors
4. Rollback if a recent deploy caused the issue

### API Key Compromised

1. Regenerate the key in the respective dashboard
2. Update the Render environment variable
3. Trigger a new deploy
4. Review access logs for unauthorized use

---

**Last Updated:** February 13, 2026
