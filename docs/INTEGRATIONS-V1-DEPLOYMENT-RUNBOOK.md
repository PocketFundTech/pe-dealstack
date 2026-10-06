# Integrations Platform V1 — Deployment Runbook & Status

**Owner:** Ganesh (paused mid-deploy, handing off)
**Target:** Get Granola + Gmail + Google Calendar integrations live in production so users can connect their accounts and have meetings/emails/events auto-link to deals.
**Reference doc:** [docs/integrations-platform.md](integrations-platform.md) — full engineering reference (read §9 Deployment Runbook for the canonical setup steps).

This file is a live status tracker. Tick boxes as you complete steps. Don't merge it back when complete — keep it as a record of how V1 went live.

---

## Where the deployment stands

Done so far (2026-05-13 → 2026-05-15):

- [x] **1. DB migrations run on production Supabase.** Both `integrations-migration.sql` and `integration-activity-migration.sql` applied. Verified all 3 tables exist (`Integration`, `IntegrationEvent`, `IntegrationActivity`).
- [x] **2. Secrets generated locally.** `OAUTH_STATE_SECRET` (32-byte hex) and `CRON_SECRET` (32-byte hex) generated and stored. Not yet added to Vercel — see step 7.
- [x] **3. `DATA_ENCRYPTION_KEY` confirmed in Vercel Production.** Already present from the security-trust work; used by `tokenStore.ts` to encrypt OAuth tokens. No action needed.

Remaining (in order, do not skip ahead):

- [ ] **4. Enable Gmail API + Calendar API** in Google Cloud Console
- [ ] **5. Configure OAuth consent screen**
- [ ] **6. Create OAuth 2.0 Client ID + add redirect URIs**
- [ ] **7. Add 4 env vars to Vercel Production** (`OAUTH_STATE_SECRET`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- [ ] **8. Redeploy and verify** Settings → Integrations renders provider cards
- [ ] **9. Smoke test Granola** (paste-key flow — needs Business+ Granola plan)
- [ ] **10. Smoke test Gmail** (OAuth → manual sync → verify `IntegrationActivity` row)
- [ ] **11. Smoke test Google Calendar** (OAuth → manual sync → verify event rows)
- [ ] **12. Verify Vercel cron** logs show successful `/api/integrations/_cron/sync-all` at next 6h tick

---

## Step 4 — Enable Gmail API + Calendar API

**Where:** Google Cloud Console — https://console.cloud.google.com

**Pre-flight:** make sure a GCP project exists for Pocket Fund. If not:
1. Top-left "Select a project" dropdown → **New Project**
2. Name: `pocket-fund-prod`
3. **Create**, then select it from the dropdown

**Enable the two APIs:**
1. Open https://console.cloud.google.com/apis/library
2. Search **"Gmail API"** → click → **Enable**
3. Back to API Library, search **"Google Calendar API"** → click → **Enable**

**Verify:** https://console.cloud.google.com/apis/dashboard should list both under "Enabled APIs & services".

---

## Step 5 — Configure OAuth consent screen

**Where:** https://console.cloud.google.com/apis/credentials/consent

**Fill these fields:**

| Field | Value |
|---|---|
| User type | **External** (Pocket Fund users won't be in a Google Workspace org) |
| App name | `Pocket Fund` |
| User support email | `tech@pocketfund.org` (or whatever your support address is) |
| App logo | optional |
| Application home page | `https://app.pocketfund.org` (your prod domain) |
| Application privacy policy | `https://app.pocketfund.org/privacy` |
| Application terms of service | `https://app.pocketfund.org/terms` |
| Authorized domains | `pocketfund.org` |
| Developer contact | same as support email |

**Scopes (Add or Remove Scopes button):**
- `https://www.googleapis.com/auth/gmail.readonly` — read Gmail messages
- `https://www.googleapis.com/auth/calendar.readonly` — read calendar events
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

**Publishing status:**
- For **early testing** (before Google verification): leave in **Testing** mode and add yourself + a few teammates as Test Users (max 100 testers, OAuth screen will show a "this app isn't verified" warning).
- For **production** with public users: click **Publish App** and submit for verification (Google review takes 4-6 weeks for sensitive scopes like `gmail.readonly`). Until verified, expect the warning screen.

**Save and continue** through all sections.

---

## Step 6 — Create OAuth 2.0 Client ID

**Where:** https://console.cloud.google.com/apis/credentials

1. Click **+ Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `Pocket Fund Web`
4. **Authorized JavaScript origins:** `https://<your-vercel-domain>` (e.g., `https://app.pocketfund.org`)
5. **Authorized redirect URIs** — add BOTH of these (one for Gmail, one for Calendar):
   - `https://<your-vercel-domain>/api/integrations/oauth/gmail/callback`
   - `https://<your-vercel-domain>/api/integrations/oauth/google_calendar/callback`
6. Click **Create** → modal shows your **Client ID** and **Client Secret**.

**⚠️ Copy both values immediately.** You can re-retrieve the Client ID later but the Client Secret is shown only once.

Save them for step 7 as:
```
GOOGLE_CLIENT_ID=<the long .apps.googleusercontent.com id>
GOOGLE_CLIENT_SECRET=<the secret>
```

---

## Step 7 — Add 4 env vars to Vercel Production

**Where:** Vercel dashboard → `pe-dealstack` project → **Settings** → **Environment Variables**

Add these four, all scoped to **Production** (uncheck Preview and Development unless you want them everywhere):

| Variable | Value |
|---|---|
| `OAUTH_STATE_SECRET` | (from step 2 — get from Ganesh) |
| `CRON_SECRET` | (from step 2 — get from Ganesh) |
| `GOOGLE_CLIENT_ID` | (from step 6) |
| `GOOGLE_CLIENT_SECRET` | (from step 6) |

**After saving:** Vercel will prompt you to redeploy for changes to take effect. Trigger a redeploy of the latest Production deployment.

> The secrets generated in step 2 are stored locally with Ganesh. Reach out to him to retrieve them, or generate fresh ones with `openssl rand -hex 32` (no existing data depends on them — they're freshly introduced for this feature).

---

## Step 8 — Verify Settings page

**Where:** https://<your-vercel-domain>/settings → scroll to **Integrations** section

**Expect:**
- Five provider cards: Granola, Gmail, Google Calendar (and Fireflies + Otter as "coming soon")
- All three primary cards show a **Connect** button
- No console errors in browser devtools

**If cards don't appear:**
- Check Vercel deployment logs for app-lite startup errors
- Verify the 4 env vars are actually set in Production (Vercel → Settings → Environment Variables → search each)
- Check that the latest deploy is the one running (Deployments tab → latest should be marked "Current")

---

## Step 9 — Smoke test Granola

**Prerequisite:** A Granola **Business or Enterprise** plan. Free/Pro plans get a 403 from Granola's API; this is a Granola-side limitation, not ours.

1. From Granola desktop app: copy your `grn_…` API key (Settings → API Keys → Create)
2. In Pocket Fund: Settings → Integrations → Granola card → **Connect**
3. Paste-key modal opens — paste the `grn_…` key → **Save**
4. Card flips to **Connected ✓** with your Granola email
5. Click **Sync Now** on the Granola card
6. From Supabase SQL editor:
   ```sql
   SELECT source, type, title, "occurredAt", "dealIds", "contactIds", "aiExtraction" IS NOT NULL AS has_ai
   FROM "IntegrationActivity"
   WHERE provider = 'granola' AND "organizationId" = '<your org id>'
   ORDER BY "createdAt" DESC LIMIT 10;
   ```
   Expect: rows for any meetings whose attendees match existing deal contacts. AI extraction (`aiExtraction`) should be populated for those rows.

**If no rows appear:** meetings in Granola haven't matched any deal contacts. Add a meeting in Granola with an attendee email that matches a contact on an existing deal, then sync again.

---

## Step 10 — Smoke test Gmail

1. Settings → Integrations → Gmail card → **Connect**
2. Redirected to Google consent screen → approve permissions
3. Redirected back with `?integrations=connected&provider=gmail` → card shows **Connected ✓**
4. Click **Sync Now**
5. From Supabase SQL editor:
   ```sql
   SELECT type, title, "occurredAt", "dealIds", "contactIds"
   FROM "IntegrationActivity"
   WHERE provider = 'gmail' AND "organizationId" = '<your org id>'
   ORDER BY "createdAt" DESC LIMIT 20;
   ```
   Expect: rows for emails whose sender/recipient matches existing deal contacts (Gmail sync pre-filters by known contact emails to keep cost down).

**If no rows:** check Vercel Function logs for the `/api/integrations/{id}/sync` call; verify deal contacts exist with real Gmail addresses.

---

## Step 11 — Smoke test Google Calendar

1. Settings → Integrations → Google Calendar card → **Connect**
2. OAuth flow same as Gmail (separate scope grant)
3. Card → **Connected ✓**
4. Click **Sync Now**
5. From Supabase SQL editor:
   ```sql
   SELECT type, title, "occurredAt", "dealIds", "contactIds"
   FROM "IntegrationActivity"
   WHERE provider = 'google_calendar' AND "organizationId" = '<your org id>'
   ORDER BY "occurredAt" DESC LIMIT 20;
   ```
   Expect: rows for calendar events in a -30d/+30d window where attendees match deal contacts.

---

## Step 12 — Verify the cron is firing

**Where:** Vercel dashboard → `pe-dealstack` project → **Logs** (or **Cron Jobs** tab on newer Vercel UI)

**Wait up to 6 hours** after step 7 was completed for the first cron tick. Once it fires:

1. Find the request to `/api/integrations/_cron/sync-all`
2. Expected response: `200` with body like `{ok: true, ranFor: <n>, succeeded: <n>, failed: 0}`
3. If `failed > 0`, inspect the `Integration` table:
   ```sql
   SELECT id, provider, status, "lastSyncError", "consecutiveFailures"
   FROM "Integration"
   WHERE "consecutiveFailures" > 0;
   ```
   3 consecutive failures auto-flips status to `error` and creates a notification for the user.

**You can also force a cron run manually** to skip the 6h wait:
```bash
curl -X POST https://<your-vercel-domain>/api/integrations/_cron/sync-all \
  -H "Authorization: Bearer <CRON_SECRET from step 2>"
```

---

## Done = success criteria

V1 deployment is complete when:

1. ✅ All 12 steps above ticked
2. ✅ At least 1 row exists in `IntegrationActivity` for each of Granola, Gmail, Calendar
3. ✅ The Vercel cron has fired successfully at least once on its own schedule
4. ✅ Settings → Integrations on production shows three "Connected ✓" cards for the smoke-test account
5. ✅ Deal page Activities tab and Contact detail panel render the synced rows under "Synced from your tools"

Once all 5 are true, post in #eng-pocket-fund: "Integrations Platform V1 is live." Then start scoping the auto-deal-creation feature (see PR #52 for the spec).

---

## Rollback plan

If something breaks badly in production:

1. **Disconnect-all:** No bulk-disconnect endpoint exists yet. Manual SQL:
   ```sql
   UPDATE "Integration" SET status = 'revoked' WHERE provider IN ('granola','gmail','google_calendar');
   ```
   This prevents any further syncs without losing past data.
2. **Disable the cron:** Edit `vercel.json` to remove the `/api/integrations/_cron/sync-all` schedule, redeploy.
3. **Revoke OAuth tokens at Google:** affected users visit https://myaccount.google.com/permissions and revoke Pocket Fund access.

Past synced data in `IntegrationActivity` remains intact — disconnecting only stops new syncs.

---

## Pointers for the dev picking this up

- The canonical engineering reference is [docs/integrations-platform.md](integrations-platform.md). Read it once end-to-end.
- Settings UI lives in `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`. Provider cards are wired to `apps/api/src/routes/integrations.ts`.
- OAuth callbacks are public (no auth header) — they live in `apps/api/src/routes/integrations-public.ts`. Trust comes from the signed `state` param.
- The cron handler accepts BOTH `Authorization: Bearer <CRON_SECRET>` (Vercel default) and `x-cron-secret: <CRON_SECRET>` (manual triggers).
- Future scope (auto-create deals from email) is spec'd separately in **PR #52** — do NOT bundle it with deployment work.
