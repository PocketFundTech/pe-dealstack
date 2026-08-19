# Troubleshooting Guide

Common issues and their solutions for Avise.

---

## Local Development

### `npm run dev` fails to start

**Symptom:** Server crashes immediately on startup.

**Check:** The API requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`. If either is missing, the server exits with:

```
FATAL: Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY
```

**Fix:**
```bash
cp apps/api/.env.example apps/api/.env
# Edit the file with your actual Supabase credentials
```

### Frontend can't reach the API

**Symptom:** Network errors in browser console, API calls fail.

**Check:**
1. Verify the API is running on port 3001: `curl http://localhost:3001/health`
2. Check `apps/web/.env` has `VITE_API_URL=http://localhost:3001/api`
3. If you changed the port, restart the Vite dev server (env changes require restart)

### CORS errors in browser

**Symptom:** `Access-Control-Allow-Origin` errors in console.

**Cause:** The API only allows requests from whitelisted origins: `http://localhost:3000`, `http://localhost:5173`, and `https://pe-os.onrender.com`.

**Fix:** If you're running the frontend on a different port, add it to the CORS config in `apps/api/src/index.ts`.

### TypeScript build errors

**Symptom:** `npm run build` fails with type errors.

**Fix:**
```bash
cd apps/api
npx tsc --noEmit  # Check for errors without building
```

Common causes:
- Missing type definitions: `npm install`
- Stale build artifacts: `npm run clean && npm install`

---

## Authentication

### "Not authenticated" errors on every request

**Symptom:** All API calls return `401 Unauthorized`.

**Possible causes:**
1. **No auth token:** The frontend must send the Supabase session token as `Authorization: Bearer <token>`
2. **Expired token:** Supabase tokens expire. The frontend should auto-refresh via `supabase.auth.onAuthStateChange`
3. **Wrong anon key:** If the backend and frontend use different Supabase anon keys, token verification fails

**Fix:** Check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` match in both `apps/api/.env` and `apps/web/.env`.

### Users not appearing after signup

**Symptom:** User signs up successfully but doesn't appear in the user list.

**Cause:** The app auto-creates a User record in the database on first authenticated request. If the first request fails (e.g., due to auth issues), the record won't be created.

**Fix:** Have the user log out and log back in. The `findOrCreateUser` function in the users route will create their record.

### Invite link not working

**Symptom:** Invited user clicks the link but gets an error.

**Check:**
1. The invite token hasn't expired (invites expire after 7 days by default)
2. The `APP_URL` in the invite email matches the actual app URL
3. Supabase email auth is enabled in your project settings

---

## AI Features

### "AI features are not enabled"

**Symptom:** AI chat returns 503 or shows "AI not available" in the UI.

**Cause:** `OPENAI_API_KEY` is not set or is invalid.

**Fix:**
1. Add a valid OpenAI API key to `apps/api/.env`
2. Restart the server
3. Verify: `curl http://localhost:3001/health/ready` — check `openai.configured` is `true`

### AI responses are slow

**Symptom:** AI chat takes 10+ seconds to respond.

**Cause:** OpenAI API latency, especially with GPT-4.

**Notes:**
- The AI rate limit is 10 requests per minute per IP
- Large deal contexts (many documents) increase response time
- RAG queries (document search) add extra latency if Gemini is configured

### AI chat returns generic responses

**Symptom:** AI gives vague answers not specific to the deal.

**Cause:** No documents uploaded for the deal, so there's no context for RAG.

**Fix:** Upload relevant documents (CIM, financials) to the deal. The AI uses document content to provide specific analysis.

---

## Document Upload

### "Invalid file type" error

**Symptom:** Upload fails with MIME type error.

**Allowed types:** PDF, XLSX, XLS, CSV, DOC, DOCX, MSG, EML, JPG, PNG

**Common causes:**
- Browser sends wrong MIME type (especially for `.csv` files)
- File extension doesn't match content

### "File content does not match claimed type"

**Symptom:** Upload passes MIME check but fails magic bytes validation.

**Cause:** The file's actual content (magic bytes) doesn't match its extension. This is a security check to prevent disguised executables.

**Fix:** Ensure the file is genuinely the type it claims to be. Renamed files will be rejected.

### File size limit exceeded

**Size limits by type:**

| Type | Limit |
|------|-------|
| PDF | 100 MB |
| Excel (XLSX/XLS) | 50 MB |
| Word (DOC/DOCX) | 25 MB |
| Email (MSG/EML) | 10–25 MB |
| CSV | 20 MB |
| Images (JPG/PNG) | 10 MB |

---

## Deployment (Render)

### Build fails on Render

**Symptom:** Deploy fails during the build step.

**Check locally:**
```bash
npm ci --include=dev && npm run build:prod
```

**Common causes:**
- Missing dev dependencies (Render must use `npm ci --include=dev`, not `npm ci`)
- TypeScript errors that pass locally but fail in CI (check `strict` mode)
- Node version mismatch — Render uses Node 20 by default

### Service starts then crashes

**Symptom:** Build succeeds but the service restarts repeatedly.

**Check:**
1. All required environment variables are set in Render dashboard
2. Supabase credentials are correct and the project is active
3. Check Render logs for the specific error

### Health check fails

**Symptom:** Render shows the service as unhealthy.

**Cause:** The `/health` endpoint must respond within Render's timeout.

**Fix:** The `/health` endpoint is a fast check (no DB query). If it's failing, the server isn't starting at all — check the logs.

Use `/health/ready` for a deeper check that includes database connectivity.

### Free tier cold starts

**Symptom:** First request after ~15 minutes of inactivity takes 30+ seconds.

**Cause:** Render free tier spins down the service after inactivity.

**Options:**
1. Upgrade to Starter ($7/mo) for always-on
2. Use an external uptime monitor to ping `/health` every 10 minutes

---

## Rate Limiting

### Getting 429 errors

**Symptom:** API returns `429 Too Many Requests`.

**Current limits:**

| Tier | Scope | Limit |
|------|-------|-------|
| General | All `/api/` | 200 req / 15 min |
| AI | AI endpoints | 10 req / 1 min |
| Write | `/api/ingest` | 30 req / 1 min |

**Fix:** Wait for the rate limit window to reset. The `Retry-After` header indicates when you can retry.

---

## Database

### "relation does not exist" errors

**Symptom:** API returns 500 errors with PostgreSQL error code `42P01`.

**Cause:** The database table hasn't been created yet.

**Fix:** Run the database migrations in the Supabase SQL editor. Check `docs/DATABASE_MIGRATIONS.md` for the schema.

### Supabase connection pool exhausted

**Symptom:** Intermittent database errors under load.

**Cause:** Supabase free tier allows 60 concurrent connections.

**Fix:**
1. Check for connection leaks (unclosed queries)
2. Reduce concurrent request count
3. Upgrade to Supabase Pro for 200 connections

---

## Sentry

### Errors not appearing in Sentry

**Backend:**
- `SENTRY_DSN` must be set
- Sentry only initializes when `NODE_ENV=production`
- For local testing, temporarily set `NODE_ENV=production`

**Frontend:**
- `VITE_SENTRY_DSN` is baked at build time
- Rebuild after changing the DSN: `npm run build:web`
- Check browser console for Sentry initialization errors

---

**Last Updated:** February 13, 2026
