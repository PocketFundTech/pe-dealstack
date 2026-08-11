# Integrations Platform — Engineering Reference

> **Audience:** A developer joining this feature cold. Or someone preparing a client demo. Read top to bottom and you should be able to deploy it, debug it, extend it, or pitch it.

---

## 1. Why this exists

PE / M&A / search-fund users at Pocket Fund repeat a few painful manual chores all day:

- After every founder/banker call they re-type meeting notes into the deal record by hand.
- They keep losing track of which deal contacts they last emailed, and what was said.
- They walk into meetings blind because the calendar and the CRM don't talk.
- They copy-paste numbers from email threads into deal financials.

**The Integrations Platform automates the read side of this.** The conversations, meetings, and emails that *already happen* in the user's existing tools (Granola, Gmail, Google Calendar) flow into the CRM, get matched to the right deals/contacts, and have AI extraction run on top — so users walk in prepared and walk out with everything captured.

This is one of the highest-leverage features for this product because:

1. **It maps directly onto user time.** Every minute saved here is a minute they'd otherwise spend on data entry.
2. **It compounds with everything else we've already built.** The financial agent, the deal chat, the memo builder — they all get richer when meeting transcripts and email threads are automatically linked to deals.
3. **It's a demo magnet.** Showing a client "you connect Granola, then five minutes later your last meeting is on the deal page with action items already extracted" is a wow moment.

---

## 2. Where we are right now

| Phase | Provider | Auth | Sync | AI | State |
|---|---|---|---|---|---|
| 0 | platform foundations | — | — | — | ✅ shipped |
| 1 | Granola (meeting transcripts) | paste API key (Granola has no third-party OAuth) | poll every 6 h + on-demand | dedicated meeting transcript agent on every transcript | ✅ shipped |
| 2 | Gmail | Google OAuth (gmail.readonly) | poll every 6 h, q-prefiltered to known contacts | none in V1 (the q-filter is the relevance signal) | ✅ shipped |
| 3 | Google Calendar | Google OAuth (calendar.readonly) | poll every 6 h, ±30 d window | none in V1 | ✅ shipped |
| 4 | Outbound (send-from-CRM) | — | — | — | 🚧 deferred — separate session, write-scope blast radius |

**Branch:** `feature/integrations-platform` → PR [#8](https://github.com/ganeshjagtap7/pe-dealstack/pull/8)
**Commit count:** ~40, all pushed.
**Test status:** 57/57 passing across 18 vitest files (`tests/integrations/` + `tests/agents/`).
**TypeScript:** `tsc --noEmit` clean.
**Database migrations:** applied to production Supabase.

---

## 3. What's done vs. what's left

### ✅ Done
- DB tables: `Integration`, `IntegrationEvent`, `IntegrationActivity` with all FKs, CHECK constraints, GIN indexes.
- Shared platform layer (`apps/api/src/integrations/_platform/`): provider interface, encrypted token store, OAuth state signing, sync engine with timeout + bounded concurrency, webhook router with raw-body capture + dedupe, contact/deal email matcher.
- Three concrete providers (`apps/api/src/integrations/{granola,gmail,googleCalendar}/`).
- Dedicated meeting-transcript agent (`apps/api/src/services/agents/meetingTranscriptAgent/`).
- REST routes (`apps/api/src/routes/integrations.ts`, `integrations-public.ts`): connect / disconnect / sync / list activities / API-key paste / OAuth callback / webhook receiver / 6 h cron.
- Settings → Integrations UI (`apps/web/settings.html` + `apps/web/js/integrations.js`) with paste-key modal.
- Vercel cron entry hitting `/api/integrations/_cron/sync-all` every 6 h.
- All required env-var documentation in `.env.example`.

### ❌ Not done — needed before user-visible launch
1. **Deal page Activities tab does not consume `/api/integrations/activities`.** Synced data lives in the DB but no deal page renders it. **This is the single biggest gap.**
2. **Contact page does not show per-contact meeting/email history.** Same gap on the contact surface.
3. **Settings → Integrations "sync activity" panel is a placeholder.** Should call `GET /api/integrations/{id}/events`.

### 🚧 Deferred (intentional, captured for future phases)
- **Phase 4 — Outbound** (send email / schedule meeting *from* the CRM). Highest blast radius, requires write scopes (`gmail.send`, `calendar.events`), needs mandatory confirmation flows + audit logging. Separate session.
- **Pre-meeting brief LLM generation** — Calendar event 1 h pre-fire trigger that assembles a brief panel from deal context + last emails + prior transcripts.
- **Push notifications** — Gmail Pub/Sub + Calendar `channels.watch`. Polling every 6 h is fine for V1.
- **Re-sync caching** — skip the LLM call if a Granola transcript hasn't changed since last sync. Cost optimization; current impact is small while user counts are low.
- **Stale-thread alerts** — daily cron that flags deals where the user is "owed a reply" >7 days.
- **Replace `alert()` / `confirm()` in `apps/web/js/integrations.js`** with the toast/dialog system used elsewhere.

---

## 4. Mental model — read this before opening any code

```
                                   ┌─────────────────────────┐
                                   │   Vercel cron (6 h)    │
                                   │  /api/integrations/    │
                                   │  _cron/sync-all         │
                                   └──────────┬──────────────┘
                                              │
                                              ▼
┌────────────────────────────┐    ┌─────────────────────────────┐
│  IntegrationProvider       │◀───│  syncEngine.syncAll         │
│  (interface)               │    │  • per-integration timeout  │
│  ─ initiateAuth            │    │  • bounded concurrency (5)  │
│  ─ handleCallback          │    │  • 3-strikes failure        │
│  ─ connectWithApiKey?      │    └──────────┬──────────────────┘
│  ─ sync                    │               │
│  ─ handleWebhook           │               │
│  ─ disconnect              │               ▼
└──────────┬─────────────────┘    ┌─────────────────────────────┐
           │ implemented by       │  registry.ts  (in-process)  │
           │                      │  ─ granolaProvider          │
           ├─ granolaProvider     │  ─ gmailProvider            │
           ├─ gmailProvider       │  ─ googleCalendarProvider   │
           └─ googleCalendarProv. │  ─ _mock (tests only)       │
                                  └──────────┬──────────────────┘
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       ▼                     ▼                     ▼
              ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐
              │  Granola API   │   │  Gmail API     │   │  Calendar API    │
              │  /v1/notes     │   │  /messages     │   │  /events         │
              └───────┬────────┘   └───────┬────────┘   └────────┬─────────┘
                      │                    │                     │
                      ▼                    ▼                     ▼
                  raw note            raw message            raw event
                      │                    │                     │
                      ▼                    ▼                     ▼
              ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐
              │ matcher        │◀──┴────────────────┴──▶│ matcher          │
              │ attendee email │                        │ attendee email   │
              │ → Contact/Deal │                        │ → Contact/Deal   │
              └───────┬────────┘                        └────────┬─────────┘
                      │ + transcript text                        │
                      ▼                                          │
              ┌──────────────────────┐                          │
              │ meetingTranscriptAgent│                         │
              │ GPT-4.1-mini          │                         │
              │ structured JSON       │                         │
              └───────┬───────────────┘                         │
                      │  aiExtraction                            │
                      ▼                                          ▼
                  ┌──────────────────────────────────────────────────┐
                  │  IntegrationActivity table                       │
                  │  one row per (integration, source, externalId)   │
                  │  ─ dealIds[]                                     │
                  │  ─ contactIds[]                                  │
                  │  ─ aiExtraction JSONB                            │
                  │  ─ rawTranscript                                 │
                  │  ─ metadata (attendees, threadId, location, …)   │
                  └──────────────────────────────────────────────────┘
                                          │
                                          ▼
                           GET /api/integrations/activities
                              ?dealId=…  | ?contactId=…
                                          │
                                          ▼
                         (deal page Activities tab — TO BUILD)
                         (contact page history — TO BUILD)
```

The two table schemas to hold in your head:

**`Integration`** — one row per (user, provider). Holds encrypted access/refresh tokens, scopes, lastSyncAt, status (`connected | token_expired | revoked | error`).

**`IntegrationActivity`** — one row per (integration, source, externalId). Holds the meeting/email/calendar event itself, with `dealIds[]` and `contactIds[]` arrays so a single Granola meeting that touches three deals appears on all three deal pages.

---

## 5. File map

```
apps/api/
├── integrations-migration.sql                           DDL: Integration + IntegrationEvent + Notification CHECK
├── integration-activity-migration.sql                   DDL: IntegrationActivity
└── src/
    ├── integrations/
    │   ├── _platform/                                   reused by every provider
    │   │   ├── types.ts                                 IntegrationProvider interface, InitiateAuthResult, etc.
    │   │   ├── tokenStore.ts                            AES-256-GCM encrypt/decrypt for tokens
    │   │   ├── oauth.ts                                 HMAC-SHA256 signed state with 10 m TTL
    │   │   ├── registry.ts                              in-process Map<ProviderId, IntegrationProvider>
    │   │   ├── syncEngine.ts                            syncAll(): timeout + concurrency + 3-strikes
    │   │   ├── webhookRouter.ts                         dispatch + dedupe via UNIQUE (integrationId, externalId)
    │   │   └── matcher.ts                               email[] → Contact[] → Deal[] (org-scoped)
    │   ├── _mock/                                       test-only provider; never registered in prod
    │   ├── granola/
    │   │   ├── types.ts, client.ts, mapper.ts, index.ts
    │   ├── gmail/
    │   │   ├── types.ts, client.ts, mapper.ts, index.ts
    │   └── googleCalendar/
    │       ├── types.ts, client.ts, mapper.ts, index.ts
    ├── services/agents/meetingTranscriptAgent/
    │   ├── prompt.ts                                    system + user prompts
    │   ├── schema.ts                                    Zod schema for MeetingInsight
    │   └── index.ts                                     runTranscriptAnalysis()
    └── routes/
        ├── integrations.ts                              auth + org-scoped: list, connect, disconnect, sync, events, activities, api-key
        └── integrations-public.ts                       no-auth, signature-verified per provider: webhooks, OAuth callbacks, cron

apps/web/
├── settings.html                                        +Integrations section
└── js/integrations.js                                   provider cards + paste-key modal

vercel.json                                              +crons: /api/integrations/_cron/sync-all every 6 h

apps/api/tests/integrations/                             vitest suite — 53 tests
└── (oauth, tokenStore, webhookRouter, syncEngine, matcher, routes,
    rawBody, smoke, granola/{client,mapper,sync},
    gmail/{client,mapper,sync}, googleCalendar/{client,mapper,sync})

apps/api/tests/agents/meetingTranscriptAgent.test.ts     vitest suite — 4 tests
```

---

## 6. The `IntegrationProvider` contract

Every provider implements this single interface. Adding a fourth provider is roughly a day of work because the platform handles 70% of the wiring.

```ts
interface IntegrationProvider {
  id: ProviderId;
  displayName: string;
  scopes: string[];

  // OAuth-style: returns mode='oauth' + authUrl. User redirects to provider.
  // API-key-style: returns mode='api_key' + paste-modal instructions.
  initiateAuth(userId, organizationId): Promise<InitiateAuthResult>;

  // Provider redirected back with code+state. Verify state, exchange, store. (OAuth only)
  handleCallback({ code, state }): Promise<Integration>;

  // User pasted a long-lived bearer token directly. Validate, store. (paste-key only)
  connectWithApiKey?({ userId, organizationId, apiKey }): Promise<Integration>;

  // Cron / on-demand. Fetch new items since lastSyncAt, run matcher, upsert IntegrationActivity.
  sync(integration, options): Promise<SyncResult>;

  // Public webhook receiver. Verify signature using rawBody, then process.
  handleWebhook(headers, body, rawBody?): Promise<void>;

  // User disconnected. Revoke at provider if possible. Route layer flips status='revoked'.
  disconnect(integration): Promise<void>;
}
```

---

## 7. Provider deep-dives

### 7.1 Granola

| | |
|---|---|
| **Auth** | Personal API key (paste `grn_…` from Granola desktop app). NO third-party OAuth program exists. |
| **Plan gating** | Business or Enterprise plan only. Free/Pro users get 403 on validation, surfaced as "Plan not supported — Granola API requires Business or Enterprise" in the paste-key modal. |
| **Sync model** | Polling — every 6 h via cron + on-demand button. NO webhooks (Granola says "on the roadmap"). |
| **Endpoints** | `GET /v1/notes?created_after=…&cursor=…`, `GET /v1/notes/{id}?include=transcript`, `GET /v1/me` |
| **Rate limits** | 25-request burst, 5/sec sustained → 429 (we retry once with `Retry-After`) |
| **AI extraction** | YES — every transcript runs through `meetingTranscriptAgent` (GPT-4.1-mini, ~$0.001–0.005 per call) |

**End-to-end flow when a meeting ends:**

1. (No webhook — skipped.)
2. Vercel cron fires within ≤6 h, hits `/api/integrations/_cron/sync-all`.
3. `syncEngine.syncAll()` finds all `connected` Granola integrations, runs `granolaProvider.sync` for each (concurrency 5, 60 s per-integration cap).
4. Provider decrypts the API key, calls `listNotesSince(apiKey, lastSyncAt)` paginated.
5. For each note: matches attendees against the org's `Contact` table → `ContactDeal`. If 0 matches, skip.
6. If matched: fetches `getNoteWithTranscript(noteId)`, hands to mapper.
7. Mapper builds `IntegrationActivityRow`, inline calls `runTranscriptAnalysis` (GPT-4.1-mini, 15 s timeout) for the AI extraction.
8. Upserts row with `onConflict: 'integrationId,source,externalId'` → idempotent re-runs.

### 7.2 Gmail

| | |
|---|---|
| **Auth** | Google OAuth — `gmail.readonly`, `userinfo.email`, `userinfo.profile` |
| **Sync model** | Polling — every 6 h. NO Pub/Sub push in V1 (deferred). |
| **Cost optimization** | Pre-filter at the Gmail API level using `q=after:<unix> (from:contact1 OR to:contact1 OR cc:contact1 OR …)` — only emails involving known contacts are returned. |
| **AI extraction** | NONE in V1. The pre-filter is the relevance signal. |
| **Endpoints** | `/users/me/messages?q=…`, `/users/me/messages/{id}?format=metadata` |

The `q` pre-filter is the key trick. Without it we'd either pull every email (bandwidth) or run an LLM relevance classifier on every email (cost). With it, the only emails Gmail returns are ones involving known deal contacts — basically free.

### 7.3 Google Calendar

| | |
|---|---|
| **Auth** | Google OAuth — `calendar.readonly` + same userinfo scopes as Gmail |
| **OAuth client** | SAME `GOOGLE_CLIENT_ID/SECRET` as Gmail. Each user can connect Gmail and Calendar independently though — separate Integration rows. |
| **Sync window** | -30 d to +30 d each tick. Re-upserts handle reschedules / attendee additions correctly. |
| **AI extraction** | NONE in V1. Pre-meeting brief LLM is a future feature. |
| **Endpoints** | `/calendars/primary/events?timeMin=…&timeMax=…&singleEvents=true&orderBy=startTime` |

---

## 8. The meeting transcript agent

A separate file from the financial agent. Different job, different prompt, different model.

| | |
|---|---|
| **Model** | `MODEL_FAST` → `openai/gpt-4.1-mini` (per `apps/api/src/utils/aiModels.ts`) |
| **Cost** | ~$0.001–0.005 per transcript |
| **Output schema** | `{summary, keyTopics[], actionItems[], decisions[], openQuestions[], mentionedNumbers[], nextSteps[], sentiment}` |
| **Resilience** | Returns `null` on every failure mode — empty input, missing client, schema mismatch, network error, 15 s timeout. The mapper still writes the IntegrationActivity row with `aiExtraction: null` and the user can re-extract later. |
| **Truncation** | Inputs over 60 k chars are sliced to fit context. |

Why not the financial agent? The financial agent's contract (`runFinancialAgent` → extracted statements + validation + self-correction loop) is for structured financial documents (CIMs, financial statements). Meeting transcripts need summarization + entity extraction + sentiment, which is a fundamentally different prompt and would have either required a major refactor or stuffed unrelated semantics into existing fields.

---

## 9. Deployment runbook

### 9.1 Database — already applied to production
Two SQL migrations, both idempotent (`IF NOT EXISTS` everywhere):

1. `apps/api/integrations-migration.sql` — Integration + IntegrationEvent + Notification CHECK extension
2. `apps/api/integration-activity-migration.sql` — IntegrationActivity

If you ever rebuild from scratch, run them in that order.

### 9.2 Vercel environment variables
Add to Vercel → Project → Settings → Environment Variables (Production):

```
OAUTH_STATE_SECRET          # 32+ chars, generate: openssl rand -hex 32
CRON_SECRET                 # generate: openssl rand -hex 32
GOOGLE_CLIENT_ID            # from Google Cloud Console
GOOGLE_CLIENT_SECRET        # from Google Cloud Console
GRANOLA_API_BASE            # https://public-api.granola.ai (default; override only for testing)
DATA_ENCRYPTION_KEY         # 64-char hex, ALREADY required by the rest of the codebase
```

### 9.3 Google Cloud Console setup
At https://console.cloud.google.com:
1. APIs & Services → Library: enable **Gmail API** and **Google Calendar API**.
2. APIs & Services → OAuth consent screen: ensure the consent screen is published (or test users include the demo accounts).
3. APIs & Services → Credentials → Create OAuth 2.0 Client ID (type: Web application).
4. Add Authorized redirect URIs:
   - `https://${VERCEL_DOMAIN}/api/integrations/oauth/gmail/callback`
   - `https://${VERCEL_DOMAIN}/api/integrations/oauth/google_calendar/callback`
5. Copy Client ID + Secret into Vercel env vars.

### 9.4 Smoke test on staging / first deploy
Once the env vars are live, deploy the branch and:

1. Hit `https://${VERCEL_DOMAIN}/settings.html#section-integrations` — five provider cards should render.
2. Click **Connect Granola** → modal opens with paste field. Paste a real `grn_…` key from a Business+ Granola account → success toast → card flips to "Connected".
3. Click **Connect Gmail** → redirected to Google consent → approve → redirected back with `?integrations=connected&provider=gmail` → card shows "Connected".
4. Click **Connect Google Calendar** → same flow.
5. From a Postgres client (or Supabase SQL editor), run:
   ```sql
   SELECT provider, status, "externalAccountEmail", "lastSyncAt"
   FROM "Integration"
   WHERE "organizationId" = '<your org id>'
   ORDER BY "createdAt" DESC;
   ```
   You should see three rows.
6. Trigger a manual sync (Postgres or curl):
   ```sql
   SELECT id FROM "Integration" WHERE provider = 'granola' AND "organizationId" = '<your org>';
   ```
   Then `POST /api/integrations/{id}/sync` from the app (or curl with the user's auth cookie). Check:
   ```sql
   SELECT source, type, title, "occurredAt", "dealIds", "contactIds", "aiExtraction" IS NOT NULL AS has_ai
   FROM "IntegrationActivity"
   WHERE "organizationId" = '<your org>'
   ORDER BY "createdAt" DESC LIMIT 20;
   ```

### 9.5 Cron verification
Once live, watch the Vercel cron logs at the top of every 6 h. Should see:
- `POST /api/integrations/_cron/sync-all` 200
- Body: `{ok: true, ranFor: <n>, succeeded: <n>, failed: 0}`

If `failed > 0`, check `Integration.lastSyncError` for the integrations in `error` status.

---

## 10. Demo script (for client calls)

This is what to click and what to say. Practice it so the client sees a wow-flow, not a setup sequence.

**Setup before the call** (do this 10 min before):
- Connect Granola for the demo user using a real Business+ Granola account.
- Connect Gmail.
- Connect Calendar.
- Run a manual sync for each (or wait for the cron) so there's already data.

**The demo (4–5 min):**

1. Open the deal page for a real deal that has known contacts. Say: *"I just had a call with the founder of Acme. Here's their deal record."*
2. Open Settings → Integrations briefly to show the three "Connected ✓" cards. *"Pocket connects to my meeting tool, my email, and my calendar — all in 60 seconds."*
3. Back to the deal Activities tab. Show the auto-populated meeting card. *(Once the frontend rendering ships — see §3 ❌.)* *"This was on my Granola, never touched the CRM. Pocket pulled it in, matched it to Acme because the founder's email is on the deal, and ran AI on the transcript."*
4. Expand the AI summary. Show the action items and mentioned numbers. *"I don't have to remember they said 30% YoY growth or that I owe them an updated cap table by Tuesday — Pocket extracted both."*
5. Show an email thread from the same contact. *"Same thing for email — every conversation with anyone on the deal is here."*
6. Show the calendar widget with upcoming meetings. *"And next time I have a meeting with them, I'll get a brief one hour before."* (caveat that the brief is a Phase 3.5 follow-up if asked).

**Closing line:** *"This is not a copy-paste tool. It's a data layer. Every other thing Pocket does — financials, the AI chat, the IC memo builder — gets richer the moment you connect these. The integrations are the multiplier."*

---

## 11. Where to pick up next

If you're the dev taking this to production / shipping the next milestone, in order:

1. **Wire the deal page Activities tab to `/api/integrations/activities`.** [`apps/web/deal.js:269`](apps/web/deal.js#L269) is where the existing `renderActivityFeed` is called. Extend it to also fetch the integration activities and merge them into the rendered list. New card types: `MEETING` (with expand-to-transcript), `EMAIL`, `CALENDAR_EVENT`. ~1 day.
2. **Wire the contact page meeting/email history.** Similar pattern; query `?contactId=…`. ~half a day.
3. **Wire the Integrations sync activity panel.** `apps/web/js/integrations.js` currently has a placeholder div. Call `GET /api/integrations/{id}/events` for each connected integration on settings load and render the latest 50 events. ~half a day.
4. **Pre-meeting brief generator** — Calendar event 1 h pre-fire trigger that assembles deal context + last emails + prior transcripts and renders a brief panel. Reuse `meetingTranscriptAgent` style infra but with a new prompt. ~2 days.
5. **Phase 4 Outbound** — separate session. Brainstorm + spec + plan first; this one needs care.

---

## 12. Architectural decisions worth knowing

**Why a separate `IntegrationActivity` table instead of extending `Activity`?**
The existing `Activity` table is the human-action audit log (deal stage changes, document uploads, manual notes). Provider-sourced events have a different shape (`source`, `externalId`, `dealIds[]`, `contactIds[]`, `aiExtraction`, `rawTranscript`) and a different lifecycle (idempotent re-syncs vs. immutable history). Mixing them would have either bloated the audit log or required a discriminator column with half the fields nullable. Separate table = clean boundaries.

**Why arrays of dealIds/contactIds instead of a join table?**
A single Granola meeting can touch three deals (multiple attendees from different deals). A row-per-(meeting, deal) denormalization would have tripled storage and made dedupe harder. With `dealIds UUID[]` + a GIN index, `WHERE dealIds @> ARRAY[deal_id]` is O(log n) and one row per provider event stays canonical.

**Why poll instead of push?**
Granola has no webhooks (period). Gmail's push requires Cloud Pub/Sub topics + topic-specific Vercel routing — non-trivial setup. Calendar push (`channels.watch`) renews every 7 days and adds a ton of moving parts. For V1 with ≤500 users, a 6 h cron + on-demand button is fine. If we need real-time we add Pub/Sub later — the webhook code path already exists and is tested.

**Why GPT-4.1-mini for the transcript agent instead of GPT-4o?**
Per-transcript cost: ~$0.001–0.005 on mini vs. ~$0.05+ on 4o. The task is summarization + entity extraction, which mini handles well; we don't need 4o-class reasoning here. At scale (100 meetings/firm/month), this is the difference between $0.50 and $5 per firm per month — meaningful when we open the gates.

**Why no LLM relevance classifier on Gmail?**
The Gmail API's `q=` parameter accepts complex filters. We pass `after:<unix> (from:contact1 OR to:contact1 OR cc:contact1 OR …)` — every email Gmail returns is already from/to/cc a known deal contact. The relevance signal is at the API layer, free. Adding an LLM on top would be paying to re-derive what we already constrained.

**Why per-user OAuth (not per-org service account)?**
Inboxes and calendars are personal. Per-org service accounts would either require domain-wide delegation (only for Google Workspace orgs) or read everyone's data through one admin's tokens (massive privacy concern). Per-user auth is correct, and the existing `userId`/`organizationId` columns on `Integration` give us org isolation for free.

---

## 13. Testing

### What's covered
57 vitest tests, all passing:
- Token storage round-trip + null handling
- OAuth state signing, tampering rejection, expiry
- Webhook router dedupe + dispatch
- Sync engine timeout + concurrency + 3-strikes
- Email matcher (case-insensitive, contact + deal lookup)
- Routes (auth-protected list, public webhook, api-key, activities query)
- Meeting transcript agent (happy path, empty/missing-client/schema-fail null returns)
- Per-provider: client (HTTP, pagination, retry, error codes), mapper (row shape, null fallbacks, agent-throws-still-writes), sync (matcher → upsert)
- Phase 0 smoke (mock provider end-to-end)

Run: `cd apps/api && npx vitest run tests/integrations/ tests/agents/`

### What's not covered
- Real-provider integration tests (would need sandbox accounts; stubbed at the HTTP layer instead).
- E2E browser tests of the Settings UI.
- Load tests on the cron (concurrency tested at unit level only).

These are acceptable gaps for V1 because the unit tests bound the contract per-component and the smoke test stitches them.

### Manual acceptance criteria
After deploy + first sync:
1. ✅ All three providers reach status='connected' from the UI.
2. ✅ At least one IntegrationActivity row per provider lands in the DB after a sync.
3. ✅ Granola rows have non-null `aiExtraction` with the expected schema.
4. ✅ Disconnecting a provider flips status='revoked' without deleting prior IntegrationActivity rows (kept for audit).
5. ✅ A second sync of the same data is a no-op (no duplicates).

---

## 14. Files most worth reading

If you have 10 minutes:
- [`apps/api/src/integrations/_platform/types.ts`](apps/api/src/integrations/_platform/types.ts) — the contract
- [`apps/api/src/integrations/_platform/syncEngine.ts`](apps/api/src/integrations/_platform/syncEngine.ts) — how cron + per-provider sync interact
- [`apps/api/src/integrations/granola/index.ts`](apps/api/src/integrations/granola/index.ts) — the simplest provider (no OAuth)
- [`apps/api/src/services/agents/meetingTranscriptAgent/index.ts`](apps/api/src/services/agents/meetingTranscriptAgent/index.ts) — the AI piece
- [`apps/api/src/routes/integrations.ts`](apps/api/src/routes/integrations.ts) — the public API surface

If you have 30 minutes:
- The Phase 0 spec: [`docs/superpowers/specs/2026-04-30-integrations-platform-design.md`](docs/superpowers/specs/2026-04-30-integrations-platform-design.md)
- The Phase 1 plan (with the reality-check pivot): [`docs/superpowers/plans/2026-04-30-integrations-platform-phase-1-granola.md`](docs/superpowers/plans/2026-04-30-integrations-platform-phase-1-granola.md)

---

## 15. Quick start for a new dev

```bash
# 1. Get the branch
git fetch origin
git checkout feature/integrations-platform

# 2. Confirm everything builds
cd apps/api
npm install
npx tsc --noEmit                      # → no errors
npm run test                          # → 57 integrations + agents pass

# 3. To run locally:
#    - Set OAUTH_STATE_SECRET, CRON_SECRET, DATA_ENCRYPTION_KEY in apps/api/.env
#    - GOOGLE_CLIENT_ID/SECRET only if you want to test the OAuth flow locally
#    - GRANOLA_API_BASE only if you want to use a stub
npm run dev                           # API at :3001
cd ../web && npm run dev              # web at :3000

# 4. Visit http://localhost:3000/settings.html#section-integrations
```

If anything's unclear, the answer is probably in this doc or in the linked spec. If it's not, ping whoever last touched the file (`git log --follow`).
