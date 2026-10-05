# External dependencies — what each problem needs (5 Oct 2026)

What Avise depends on outside the code, mapped to the open problems from the **5 Oct testing round** (Pushkar) and the
**1 Oct QA report** (Dev). For each dependency: who owns it, how to set it up, how to check it works, and what the
code already does while it's missing.

**Code fixes** for the same rounds are in PRs [#174](https://github.com/PocketFundTech/pe-dealstack/pull/174),
[#178](https://github.com/PocketFundTech/pe-dealstack/pull/178) and the 5 Oct batch PR. **Production still runs the old code
until they're merged**, so testers keep hitting bugs that are already fixed.

---

## 1. Which problem needs which dependency

| 5 Oct item | Problem | Blocked on | Section |
|---|---|---|---|
| 1, 2, 3, 4, 15, 16, 17, 18 | Extract financials, Score deal, Model / Analysis, Chat, Data-room extraction & insights, "AI not working" | **AI provider credit / keys** | [§2](#2-ai-providers-anthropic--openai) |
| 9 | "API has enough tokens but it still says not enough credits" | **AI keys** — likely OpenAI or the wrong Anthropic key | [§2](#2-ai-providers-anthropic--openai) |
| 5 | Google integration not working | **Google OAuth app** | [§3](#3-google-gmail--google-calendar-drive-docs) |
| 6 | Gmail integration not working | **Google OAuth app** (+ Google verification for real customers) | [§3](#3-google-gmail--google-calendar-drive-docs) |
| 7 | Granola integration not working | **Granola plan** + `DATA_ENCRYPTION_KEY` | [§5](#5-granola) |
| 11 | Document-request email lands in spam | **Resend domain + DNS** (plus a code fix in the 5 Oct PR) | [§7](#7-email-resend--supabase-auth) |
| 12 | Password-reset email never arrives | **Supabase custom SMTP** | [§7](#7-email-resend--supabase-auth) |
| 20 | Confirm the 30 Sep financials fixes | **AI credit**, then re-extract SRM | [§2](#2-ai-providers-anthropic--openai) |
| 8, 10, 13, 14, 19 | Duplicate deals, download activity / "AI analysed", layout, refresh, Clear chat | **Code only** — no dependency | 5 Oct PR |

From the 1 Oct report: #6 → §3/§5, #7 #14 #15 #17 #24 → §2, Outlook (unverified) → §4, NDA e-signature → §6.

---

## 2. AI providers (Anthropic + OpenAI)

**Owner:** founder. **Blocks:** every AI feature.

Most features use **Anthropic** (Claude). Some still call **OpenAI** — the legacy extractor and classifiers (`aiExtractor`,
`financialClassifier`, `chatHelpers`, `followUpQuestions` …). Topping up only one provider leaves the other path failing,
and the app reports it as "out of credit". **This is the most likely cause of item 9.**

| Check | How |
|---|---|
| Which provider is rejecting | `vercel logs --environment production --since 2h --query "credit balance"` (Anthropic) and `--query "insufficient_quota"` (OpenAI). After #174: `--query "ai_quota_exhausted"` — logged once per instance, names the provider. |
| Right Anthropic key | The key in Vercel `ANTHROPIC_API_KEY` must belong to the **same Anthropic organization / workspace** that was topped up, and that workspace must not have hit a **spend limit** (Console → Settings → Limits). Delete the misspelled leftover `Antropic_api_avise` (OPS-9). |
| OpenAI | `OPENAI_API_KEY` must have credit (platform.openai.com → Billing), or the remaining OpenAI call sites move to Claude (code work, not scheduled). |
| Credit alert | After #174: Vercel → Logs → create an alert on `ai_quota_exhausted`. Optional: `ANTHROPIC_ADMIN_KEY` (OPS-10) for daily cost reconciliation. |

**Verify:** Deal → Score deal works; Extract financials on a test deal finishes. Then re-extract SRM (item 20) and re-run the
30 Sep checks in `docs/FINANCIALS-MANUAL-TEST-PLAN.md`.

**While missing:** after #174 users see a plain "AI is out of credit / temporarily unavailable" message, never raw JSON.

---

## 3. Google (Gmail + Google: Calendar, Drive, Docs)

**Owner:** founder (Google Cloud admin). **Blocks:** items 5, 6; Inbox Deal Finder, Drive ingest, Google Docs NDA import,
Gmail contact suggestions, Calendar meeting prep.

1. Google Cloud Console → **APIs & Services → Library**: enable Gmail API, Google Calendar API, Google Drive API, Google Docs API.
2. **OAuth consent screen** (External): app name, support email, authorised domain `avise.io`; add the scopes the code requests:
   `gmail.readonly`, `gmail.send`, `calendar.readonly`, `drive.file`, `documents`, `userinfo.email`, `userinfo.profile`.
3. **Credentials → Create OAuth client ID** (Web application). Authorised redirect URIs (use the real `APP_URL`; add the
   `deals.avise.io` pair too if users log in there):
   - `https://app.avise.io/api/integrations/oauth/gmail/callback`
   - `https://app.avise.io/api/integrations/oauth/google_calendar/callback`
4. Vercel production env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus the shared OAuth vars in [§9](#9-vercel-environment--shared-settings). Redeploy.

**Google verification (plan for it now).** `gmail.readonly` is a *restricted* scope under Google's policy: before real customers
can connect Gmail, Google requires app verification and a third-party security assessment (weeks, paid). Confirm against
Google's current policy. Until then keep the app in **Testing** and add the team and demo accounts as **test users** (max 100);
in Testing, Google expires connections after 7 days, so testers reconnect weekly.

**Verify:** Settings → Integrations → Connect Gmail → Google consent → back with "Gmail connected"; same for Google.
```sql
select provider, status, "externalAccountEmail", "lastSyncAt" from "Integration" order by "updatedAt" desc limit 5;
```

**While missing:** after #174 the card says "Google sign-in isn't set up on this server yet" instead of "unexpected error".

---

## 4. Microsoft (Outlook + Microsoft 365)

**Owner:** founder (Azure admin). **Blocks:** Outlook email sync, Microsoft 365 calendar. Both are built but **untested**.

1. Azure Portal → Microsoft Entra ID → **App registrations → New registration**; supported accounts: any organisational
   directory + personal Microsoft accounts (matches `MS_TENANT=common`).
2. Redirect URIs (Web): `https://app.avise.io/api/integrations/oauth/outlook/callback` and `…/oauth/microsoft365/callback`.
3. **Certificates & secrets → New client secret** — copy the value.
4. **API permissions → Microsoft Graph (delegated):** `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `User.Read`, `offline_access`.
5. Vercel: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT=common`. Redeploy.

**Verify:** Connect Outlook, then Microsoft 365 — first end-to-end test for both. **While missing:** after #178 the cards say
"Microsoft sign-in isn't set up on this server yet". Note: the Microsoft 365 card is calendar-only; OneDrive file import isn't built.

---

## 5. Granola

**Owner:** the person connecting + founder (env). **Blocks:** item 7 (meeting transcripts).

- Granola's API needs a **Business or Enterprise** plan — the key comes from Granola → Settings → API.
- Vercel: `DATA_ENCRYPTION_KEY` (64 hex chars, `openssl rand -hex 32`) — the key is stored encrypted. **Never rotate it casually:**
  every stored token becomes unreadable.

**While missing:** after #174 the modal shows Granola's real reason (invalid key / plan not supported / Granola's HTTP error).

---

## 6. Dropbox Sign (NDA e-signature)

**Owner:** founder. Vercel: `DROPBOX_SIGN_API_KEY` (+ `DROPBOX_SIGN_TEST_MODE=true` while testing). Signed-status detection uses
polling until push is re-enabled on the verified custom domain — steps in `docs/nda-signature-detection-setup.md`.

---

## 7. Email (Resend + Supabase Auth)

**Owner:** founder (DNS + Supabase + Resend).

**App email via Resend** (document requests, invites, share alerts — item 11):
1. Resend → **Domains → Add** `avise.io` (or a sending subdomain like `mail.avise.io`) and add the **SPF, DKIM (and return-path)**
   records it shows at the DNS provider; wait for "Verified".
2. Add a **DMARC** record: `_dmarc.avise.io  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@avise.io"` (tighten to `quarantine` later).
3. Vercel: `RESEND_FROM_EMAIL` on that verified domain (e.g. `requests@mail.avise.io`) and `RESEND_API_KEY`. **If
   `RESEND_FROM_EMAIL` is unset the code falls back to `onboarding@resend.dev`, which is a shared test sender.**
4. A new domain still needs a few days of light, real sending to build reputation (the "warm-up" in the doc comments).

The 5 Oct PR also fixes the code side: a sender name ("{Firm} via Avise"), Reply-To set to the requester, and a plain-text part.

**Auth email via Supabase** (password reset, sign-up confirmation — item 12):
Supabase's built-in mailer is heavily rate-limited (a few emails per hour) and meant for development, so reset emails get dropped.
Supabase → **Authentication → SMTP Settings → Enable custom SMTP** with Resend's SMTP (`smtp.resend.com`, port 465, user
`resend`, password = a Resend API key, sender = an address on the verified domain). Then raise the auth email rate limit
(Authentication → Rate Limits). Check that `https://app.avise.io/reset-password` is in Authentication → URL Configuration →
Redirect URLs.

**Verify:** Forgot password → email arrives within a minute, not in spam; send a document request to a Gmail address → Inbox.

---

## 8. Kondo (LinkedIn Deal Finder, 1 Oct #23)

**Owner:** founder (account) → dev (build, 2–3 days). Needs Kondo API access (docs + a test key). Not started. Testable only
once Gmail (§3) works, to match the existing Inbox Deal Finder flow.

---

## 9. Vercel environment — shared settings

Check what's set: `npm i -g vercel && vercel login && vercel link` (pick `pocket-funds-projects/pe-dealstack`), then
`vercel env ls production`. Every OAuth integration needs:

| Variable | Value | Used by |
|---|---|---|
| `APP_URL` | the domain users log in on, e.g. `https://app.avise.io` | every OAuth redirect URI |
| `OAUTH_STATE_SECRET` | `openssl rand -hex 32` (32+ chars) | Google + Microsoft sign-in |
| `CRON_SECRET` | `openssl rand -hex 32` | 6-hourly integration sync, reminders |
| `DATA_ENCRYPTION_KEY` | 64 hex chars | stored integration tokens, HubSpot token |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | provider keys with credit | §2 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | §3 | Gmail, Google |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | §4 | Outlook, Microsoft 365 |
| `DROPBOX_SIGN_API_KEY` | §6 | NDA e-signature |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | §7 | all app email |
| `EXTRACTION_CONCURRENCY` (optional) | default 4 | Extract all speed vs Anthropic rate limits |

Redeploy after changing env vars (Vercel → Deployments → Redeploy).

---

## 10. Already working — no dependency action

HubSpot import (each org pastes its own HubSpot private-app token), API keys + webhooks (n8n / Zapier / Make), CSV / Excel
import (deals, contacts), Supabase database (all migrations run as of 5 Oct).
