# Gmail → Auto Deal Creation & Update — V1 Spec (LOCKED)

**Status:** 🔒 **LOCKED for V1 — ready for developer pickup**
**Date locked:** 2026-05-13
**Owner (product):** Ganesh
**Owner (eng):** _assign on pickup_
**Depends on:** Integrations Platform V1 (PR #8, deployed). Gmail OAuth + the 6h cron sync must already be live before Phase A can start.

> All 8 open product decisions in §6 have been resolved to the default proposals. Scope is fixed. Effort is ~6 weeks for one focused dev. If a phase needs to slip or be cut, talk to the product owner before changing this doc.

---

## ⚡ Developer quick-start

**Where to start:** Phase A (§5). It is the smallest shippable unit and unlocks every later phase. Do not start Phase B until Phase A has run in production for ≥2 weeks with real users.

**Files to read first (in this order):**

1. [docs/integrations-platform.md](../../integrations-platform.md) — the V1 engineering reference. Mental model + file map.
2. [apps/api/src/integrations/gmail/index.ts](../../../apps/api/src/integrations/gmail/index.ts) — Gmail sync provider you'll plug the classifier into.
3. [apps/api/src/integrations/gmail/mapper.ts](../../../apps/api/src/integrations/gmail/mapper.ts) — where the new classifier call slots in.
4. [apps/api/src/integrations/_platform/matcher.ts](../../../apps/api/src/integrations/_platform/matcher.ts) — existing email → Contact → Deal matcher (you'll extend the contact side in Phase D).
5. [apps/api/src/services/agents/meetingTranscriptAgent/](../../../apps/api/src/services/agents/meetingTranscriptAgent/) — pattern to copy for `dealEmailClassifier`. Same shape: `prompt.ts` + `schema.ts` + `index.ts`.
6. [apps/api/src/services/agents/financialAgent/](../../../apps/api/src/services/agents/financialAgent/) — LangGraph pattern if you want a more elaborate multi-node agent (probably overkill for V1; single LLM call is fine).
7. [apps/api/integration-activity-migration.sql](../../../apps/api/integration-activity-migration.sql) — pattern to copy for new migrations.

**Patterns to reuse, not reinvent:**

| Need | Existing thing to copy |
|---|---|
| New AI agent | Mirror `meetingTranscriptAgent/` structure |
| New DB migration | Mirror `integration-activity-migration.sql` (idempotent, quoted camelCase) |
| Org-scoped REST route | Mirror `apps/api/src/routes/integrations.ts` |
| Frontend settings panel | Mirror `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx` |
| AI inference audit log | Already exists — wire your calls to it (see security-trust work) |
| AI usage cost attribution | Already exists per session 64 — use `authId` not `User.id` FK |
| Feature flag | GrowthBook (per existing wiring) |

**Definition of done per phase:**

| Phase | Done when… |
|---|---|
| A | Gmail sync runs classifier on each new email; suggestions render in queue UI; user can accept/dismiss; consent flow works; precision dashboard shows >0.8 on golden set. |
| B | Above-threshold suggestions auto-create Deal/Company/Contacts; in-app + digest notifications fire; bulk-delete safety valve works. |
| C | New email on linked thread proposes field updates; sensitive fields queue, non-sensitive auto-apply; per-field audit log shows source email + confidence. |
| D | Signatures parsed; new Contacts created with title/company/phone; dedupe queue surfaces obvious merge candidates. |
| E | Settings panel ships with all 6 controls; user can configure, save, see "why was this surfaced?" for each suggestion. |
| F | Backfill on enable scans up to 5000 past emails, surfaces single review queue, idempotent on re-run. |
| G | Pub/Sub push verified for 2 weeks; 6h cron retired. |

**When you ship a phase, do this:**

1. Update PROGRESS.md (Sessions convention in this repo)
2. Open a PR titled `feat(gmail-auto-deal): Phase X — <name>`
3. Update this spec doc's §3 status column to ✅ shipped
4. Add a one-paragraph entry to MEMORY.md key architecture section

---

---

## 0. User flow (plain English — read this first)

This is what the user will see and click. Everything else in this doc supports it.

### Setup (one time, ~2 minutes)

1. User opens **Settings → Integrations**. Their Gmail is already connected (V1).
2. Under the Gmail card, a new section appears: **"Auto-deal detection"** with a **Set up** button.
3. Click → **privacy consent screen**: *"Pocket Fund will use AI to read your email subjects, bodies, and sender info to find deal opportunities. We only store email content if it's deal-related. You can turn this off any time."* User clicks **Enable**.
4. **Configuration screen** appears with sensible defaults:
   - **Confidence slider** — default 85%, *"only auto-create when AI is very confident"*
   - **Always trust these senders** — chip input (`@keystonepartners.com`, `@blackstone.com`)
   - **Always ignore** — pre-filled with LinkedIn, Indeed, Calendly, internal company domain
   - **Sectors I focus on** — pre-filled from firm profile
   - **Minimum deal size** — optional ($1M or blank)
5. **Save & scan last 90 days** → progress bar: *"Scanning 12,432 emails… 38%"*.
6. 5–15 min later, notification: *"Found 47 potential deals in your past email. [Review]"*

### Daily passive use

1. Every 6 hours, Pocket Fund pulls new Gmail messages + runs AI classifier per email.
2. **High confidence (>85%)** → auto-creates Deal + Company + Contacts.
3. **Medium confidence (60-85%)** → goes to **Review Queue** for approval.
4. **Low confidence** → ignored (email still on activity feed, no deal action).
5. Next morning user sees:
   - Dashboard banner: *"AI created 3 new deals from your email overnight. [Review]"*
   - New deals carry an **"AI" badge** in the CRM list
   - Deal detail page header: *"Created from email thread with founder@acme.com on Tuesday. [View source email]"*

### Thread continuity

1. User keeps emailing on the same thread for weeks.
2. AI recognizes a new message on a **known thread** = update, not a new deal.
3. If banker writes *"$8M valuation"*, AI proposes: *"Update deal size blank → $8M? [Approve] [Reject] [Edit]"*.
4. **Sensitive fields** (size, stage, owner) always require approval; **non-sensitive** (notes, contact list) auto-apply.

### Contact auto-creation

1. Every From/To/CC participant → candidate Contact.
2. Email signature parsed: *"John Smith, MD, Keystone Partners, +1-555-1234"*.
3. New Contact auto-created, linked to Deal, tagged *"Auto from email signature"*.
4. If duplicate detected, AI proposes a **merge** — one-click Yes/No.

### Stay in control

- Per-record **"Delete & teach AI this isn't a deal"** trains the classifier away from similar emails.
- Settings → **"Bulk delete all AI-created records from past 24h"** safety valve.
- Every AI action in an **audit log** on the deal: *"Size updated by AI 2026-05-15, source: email X, confidence 92%"*.

### Turn it off

Settings → toggle Auto-Deal Detection OFF. Past records remain (user choice to keep/delete). No new AI actions.

---

## 1. Goal in one sentence

When a user connects Gmail, Pocket Fund should **identify which email threads are deal-related**, **auto-create a Deal + Company + Contacts** from each one with AI-extracted data, and **keep that Deal updated** as the thread grows — all with user-configurable thresholds and review gates so the AI never silently makes up deals.

## 2. What V1 already does vs. what's new

| Capability | V1 (shipped) | This feature (new) |
|---|---|---|
| Pull emails from Gmail | ✅ every 6h | unchanged |
| Match email to **existing** deal contact | ✅ via `matcher.ts` | unchanged |
| Surface email on deal Activities tab | ✅ via `IntegrationActivityFeed` | unchanged |
| Classify email as deal-relevant | ❌ | **new — AI classifier** |
| Create new Deal from email | ❌ | **new — AI extraction + write** |
| Update Deal fields as thread evolves | ❌ | **new — incremental extraction** |
| Auto-create Contacts from signatures | ❌ | **new — signature parser + AI fallback** |
| Privacy consent flow | ❌ | **new — explicit opt-in modal** |
| User-controlled config | ❌ | **new — settings UI + DB** |
| Review queue for borderline cases | ❌ | **new — UI page** |
| Audit trail of AI-created records | partial | **expanded — per-field provenance** |
| Notifications & digests | ❌ | **new — in-app, email, Slack** |
| Backfill past 90 days | ❌ | **new — bounded background job** |

## 3. Phasing

Each phase is independently shippable and demoable. Don't conflate them.

### Phase A — Classifier + Suggestion Queue (no auto-write, opt-in)
Safest start: AI labels emails, surfaces "potential deals" in a review queue. Nothing auto-created.

### Phase B — Auto-create above confidence threshold
Once Phase A has run for 2 weeks and we trust the classifier, flip a setting to auto-create above a threshold.

### Phase C — Thread continuity & field updates
Once a Deal is linked to a Gmail threadId, every new email on that thread becomes an incremental update.

### Phase D — Contact auto-extraction
Signature parser + AI fallback + dedupe/merge.

### Phase E — Configuration surface
The "proper configuration" panel: toggle, threshold, allowlist, blocklist, sector filter, min deal size.

### Phase F — Backfill
Scan last 90 days when feature first enabled.

### Phase G — Push notifications
Gmail Pub/Sub push → instant. Replaces 6h poll once usage justifies infra.

---

## 4. Architecture sketch

```
Gmail sync (existing 6h cron)
        │
        ▼
IntegrationActivity row created (existing)
        │
        ▼
NEW: Pre-LLM filter (regex/keyword/sender allowlist+blocklist)
        │ pass
        ▼
NEW: dealEmailClassifier (GPT-4.1-mini, ~$0.001/email)
        │
   ┌────┴─────────────────────────┐
   ▼ confidence ≥ threshold       ▼ confidence < threshold
   ┌─────────────────┐             ┌──────────────────────┐
   │ threadId known? │             │  to Suggestion Queue │
   └────┬────────────┘             │  (Phase A) or drop   │
        │                          └──────────────────────┘
   ┌────┴─────────────────┐
   ▼ yes: known deal      ▼ no: new deal
   ┌──────────────────┐   ┌──────────────────────┐
   │ incrementalUpdate│   │ dealExtractor (full) │
   │ agent (delta)    │   │ + signatureParser    │
   └────────┬─────────┘   │ + Company match/new  │
            │             │ + Contacts match/new │
            │             └──────────┬───────────┘
            ▼                        ▼
   DealUpdateProposal           Deal (source: 'ai_email')
   (or auto-apply if            + Company + Contacts
    Phase C high-conf)          + ContactDeal links
            │                        │
            └─────────┬──────────────┘
                      ▼
            Notification fanout
            (in-app, email digest, optional Slack)
                      │
                      ▼
            Audit log: AI inference table (existing)
            + per-field provenance on Deal
```

---

## 5. The complete TODO checklist (end-to-end)

### Phase A — Classifier + Suggestion Queue (no auto-write)

**Backend — AI**
- [ ] Design `dealEmailClassifier` output schema (Zod): `{ isRelevant: bool, confidence: 0-1, reasoning: string, hints: { companyName?, sector?, dealType?, askPrice?, contactRoles[] } }`
- [ ] Build `apps/api/src/services/agents/dealEmailClassifier/` (prompt + schema + index)
- [ ] Golden-set test fixtures: 30 emails (cold pitch, banker intro, founder intro, LP intro, portfolio update, recruiter spam, calendar invite, newsletter, internal team, vendor invoice)
- [ ] Pre-LLM filter (regex/keyword/blocklist) to skip obvious noise before paying for LLM
- [ ] Cost guardrail: per-integration cap of N classifications per cron run

**Backend — DB & API**
- [ ] Migration: `dealRelevance` JSONB column on `IntegrationActivity` (score, reasoning, hints)
- [ ] Migration: `DealSuggestion` table (status `pending | accepted | dismissed`, sourceEmailIds, extractedFields, confidence)
- [ ] Wire classifier into Gmail mapper (run before upsert)
- [ ] `GET /api/deal-suggestions` (org-scoped, paginated, filter by status)
- [ ] `POST /api/deal-suggestions/:id/accept` → creates Deal + Company + Contacts from extracted fields
- [ ] `POST /api/deal-suggestions/:id/dismiss` → logs dismissal for future prompt tuning

**Frontend — Suggestion Queue UI**
- [ ] `/internal/deal-suggestions` page (or `/crm` tab — UX decision needed)
- [ ] Card per suggestion: subject, sender, extracted hints, confidence bar, *Accept / Edit / Dismiss*
- [ ] Accept flow: modal pre-filled with extracted data → user edits → Confirm → Deal created
- [ ] Dashboard banner when ≥1 pending suggestion: *"X new deal opportunities from email"*

**Privacy & consent**
- [ ] Consent modal copy reviewed by founder/legal
- [ ] DB: track consent acceptance — who, when, version of consent text
- [ ] Re-prompt if consent scope changes in future
- [ ] Privacy policy update to mention AI processing of email content

**Observability**
- [ ] Log every classifier call to existing AI inference audit table (already V1)
- [ ] Internal dashboard: classifications/day, % deal-relevant, % dismissed (track precision)

---

### Phase B — Auto-create above threshold

**Config & writes**
- [ ] Add `autoCreateDealsThreshold` to `Organization.settings` (null = off, suggested 0.85)
- [ ] Deal write path: company match-or-create, deal create, contacts create, ContactDeal links
- [ ] Mark all auto-created records with `source = 'ai_email'`, `sourceConfidence`, `sourceEmailId`
- [ ] Idempotency: same Gmail message ID processed twice must not create duplicate

**Notifications & visibility**
- [ ] In-app notification on every auto-create
- [ ] Daily digest email (configurable per user, default ON) — *"AI created N deals yesterday"*
- [ ] Slack notification if user has Slack channel
- [ ] Dashboard widget: *"AI created in last 7 days"* with quick edit/delete
- [ ] CRM list: filter chip *"AI-created only"*
- [ ] "AI" badge on every auto-created deal row
- [ ] Deal page header: *"Created from email thread X. [View source]"*

**Undo & safety**
- [ ] Per-deal *"Delete & tell AI this isn't a deal"* button (logs feedback)
- [ ] Settings → safety valve: *"Bulk delete all AI-created records from past 24h"*
- [ ] Feedback log table: dismissed/deleted suggestions → fuel for future prompt iteration

---

### Phase C — Thread continuity + incremental updates

**Backend**
- [ ] `Deal.sourceThreadIds` (text[]) — link Gmail threadIds to deals
- [ ] Index on `sourceThreadIds` for fast lookup
- [ ] Build `dealIncrementalUpdate` agent (delta-only output schema)
- [ ] On new email: if threadId already linked, run incremental agent; else fall back to classifier
- [ ] `DealUpdateProposal` table (field, oldValue, newValue, sourceEmailId, confidence, status)
- [ ] Sensitive-field list (size, stage, owner, askPrice) → always queue, never auto-apply
- [ ] Non-sensitive (notes, contact list) → auto-apply above threshold

**Frontend**
- [ ] Per-deal "AI proposals" panel showing pending field updates
- [ ] Approve / Reject / Edit per proposal
- [ ] Bulk approve UI for low-risk updates
- [ ] Per-field audit history: *"Size updated by AI on date, source X, confidence Y"*

**Conflict policy**
- [ ] **Never overwrite a human edit without explicit approval** (compare timestamps)
- [ ] If AI proposes a change to a field a human edited <7d ago → always queue

---

### Phase D — Contact auto-extraction

**Backend**
- [ ] `emailSignatureParser` — regex/heuristic first pass (name, title, company, phone, LinkedIn URL)
- [ ] AI fallback for unparsed signatures (single GPT-4.1-mini call)
- [ ] Contact dedupe pipeline: exact email match → fuzzy `(normalized_name, company_domain)` match
- [ ] Merge proposal queue (`ContactMergeProposal` table)
- [ ] Tag auto-extracted contacts with `source = 'ai_email_signature'`

**Frontend**
- [ ] Merge UI: side-by-side comparison, *"Merge into John Smith"* / *"Keep separate"*
- [ ] Bulk merge for obvious dupes
- [ ] Contact detail panel shows AI source if applicable

---

### Phase E — Configuration UI

- [ ] Settings → Integrations → Gmail → **"Auto-deal detection"** panel
- [ ] Master toggle (OFF by default — opt-in for legal/trust reasons)
- [ ] Confidence threshold slider (0.6 aggressive ↔ 0.95 conservative)
- [ ] Allowlist multi-chip input (sender emails or domains)
- [ ] Blocklist multi-chip input (pre-filled with LinkedIn, Indeed, Calendly, internal domain)
- [ ] Sector multi-select (pre-filled from firm profile)
- [ ] Min deal size text input (optional)
- [ ] Notification preferences (in-app yes/no, daily digest yes/no, Slack yes/no)
- [ ] *"Why was this surfaced?"* link on every suggestion → shows current config so user sees why

**Decisions baked into the UI**
- [ ] Per-user config (their Gmail, their preferences) — deals always written at org scope
- [ ] Role gate: any user can enable for their own Gmail; org-wide policies (e.g., "all members must opt in") are admin-only

---

### Phase F — Backfill (last 90 days when first enabled)

- [ ] Background job: chunked Gmail history fetch (Gmail API caps + 429 handling)
- [ ] Bounded concurrency (5 emails/sec to OpenAI)
- [ ] Progress bar: *"Scanning 12,432 emails… 38%"* in Settings panel
- [ ] Hard cap: 5,000 emails per backfill (configurable for power users)
- [ ] Single review queue at end with bulk-accept option
- [ ] Idempotency: re-running backfill must not produce duplicates
- [ ] Cost ceiling per backfill (warn user if estimated >$X)

---

### Phase G — Push notifications (replace 6h poll)

- [ ] Gmail Pub/Sub topic + watch registration
- [ ] Pub/Sub → webhook receiver (raw-body capture already in `webhookRouter.ts`)
- [ ] Drop the 6h poll once push is verified for 2 weeks
- [ ] Calendar `channels.watch` (parallel work for calendar-triggered flows)

---

### Cross-cutting / data storage & retention (security-critical)

Must be defined before Phase A merges. Founder + security review required.

- [ ] Define exactly what gets stored from each email: full body? snippet only? subject+sender only? Spec the schema.
- [ ] Encrypt email-body fields at rest (column-level via `DATA_ENCRYPTION_KEY`, matching V1 token storage)
- [ ] Retention policy: default **90 days for raw email content**, indefinitely for AI-extracted structured data (Deal/Contact fields). Configurable per org for paid plans.
- [ ] Cron job: purge `IntegrationActivity.rawBody` and similar fields older than retention window
- [ ] User-facing data export endpoint includes all AI-derived records tagged `source = 'ai_email'`
- [ ] Deletion request flow: user can request "purge all AI-extracted data from my email" — cascades to suggestions, AI-created deals (soft-deleted, recoverable for 30d per existing soft-delete pattern)
- [ ] Privacy policy update covering all of the above

### Cross-cutting / cross-user dedupe in same org

A single firm has multiple users with Gmail connected. Same banker emails three of them. Three classifiers fire. Without dedupe → three Acme deals.

- [ ] Dedupe key: normalized `companyName` + sender `domain` + 7-day window
- [ ] On suggestion creation: check for existing pending suggestion in org with same dedupe key → merge, don't create new
- [ ] On auto-create: check for existing Deal in org with same dedupe key → attach the new email/contacts to existing deal, don't create a duplicate Deal
- [ ] Log a "consolidation" event for audit: "User A's Gmail surfaced Acme on Monday; User B's Gmail surfaced same on Tuesday; linked"

### Cross-cutting / Deal ownership when AI creates

- [ ] `Deal.ownerId` = the user whose Gmail triggered creation (default)
- [ ] If dedupe merged across users (above), ownership stays with the original creator; co-owners listed as additional users
- [ ] Deal detail header shows: *"Created by AI from {{user.name}}'s Gmail on {{date}}"*
- [ ] One-click "Reassign owner" tooltip on first view

### Cross-cutting / Backfill cost preview

- [ ] Before user clicks "Scan 90 days", show estimate: *"~12,432 emails. ~$8 in AI processing. Proceed?"*
- [ ] Calculation: `estimatedEmails × pre-filter pass-rate × per-LLM-call cost`
- [ ] Hard stop if estimate exceeds 50% of monthly org budget — require explicit confirmation

### Cross-cutting / Re-classification on config changes

When user changes confidence threshold or allowlist/blocklist:

- [ ] **Future-only by default.** Past pending suggestions and past auto-created deals are NOT re-evaluated automatically.
- [ ] Optional "Re-run on past 7 days" button in Settings, with cost preview
- [ ] Never retroactively delete an already-accepted deal because the user later raised their threshold

---

### Cross-cutting / edge cases

- [ ] **Forwarded emails** — extract original sender chain, don't treat the internal forwarder as deal source
- [ ] **Multi-company emails** — heuristic: if multiple distinct companies mentioned, pick the one in the From/signature; flag rest as "also mentioned"
- [ ] **Reply chains** — user-sent messages on a thread also feed extraction (e.g., user replies "we're passing on this" → AI suggests `stage = passed`)
- [ ] **Auto-replies & out-of-office** — blocked at pre-LLM filter (regex on common signatures)
- [ ] **HTML emails with embedded images** — strip to text, ignore images for V1
- [ ] **Newsletter spam masquerading as outreach** — confidence floor + sector filter
- [ ] **Banker pitching many deals** — extraction must NOT merge unrelated company names into one deal

### Cross-cutting / discoverability

- [ ] In-product tour highlighting the new "Auto-deal detection" section when feature ships
- [ ] *"What's new"* banner for 7 days post-ship
- [ ] Add **"Enable auto-deal detection"** as an optional step in onboarding checklist
- [ ] Help doc + short video (Loom) embedded in Settings panel

### Cross-cutting / data lifecycle

- [ ] **Disconnect Gmail** → auto-created records remain (user choice). Show banner: *"3 deals were created from this Gmail. [Keep] [Delete]"*
- [ ] **GDPR export**: include all `source = 'ai_email'` records in user export
- [ ] **GDPR delete**: cascade delete auto-created records on user account deletion (already covered by FK)
- [ ] **Multi-Gmail accounts** — per-account toggle (work vs personal); only scan accounts explicitly enabled

### Cross-cutting / cost & performance

- [ ] Pre-LLM filter cuts ~70% of obvious noise before paying for classification
- [ ] AI cost attribution per user (already in V1 AI usage tracking)
- [ ] Per-org monthly AI budget cap with warning at 80%
- [ ] OpenAI rate limit handling (429 backoff)

### Cross-cutting / validation & rollout

- [ ] Beta cohort: 3-5 friendly users for 2 weeks before GA
- [ ] Internal precision/recall dashboard (precision = % of AI-created deals that user kept after 7d)
- [ ] Metrics: deals/day created, % approved, % deleted in 7d, false-positive rate by sender domain
- [ ] Feature flag (GrowthBook?) so we can disable per-org if something goes wrong
- [ ] Rollback plan: SQL to bulk-soft-delete `source = 'ai_email'` records if classifier misfires at scale

---

## 6. Product decisions (LOCKED for V1)

All 8 decisions resolved. Developer can build to these as if they are requirements. If you find a reason to deviate during implementation, raise it in the PR before merging.

| # | Question | **Decision** |
|---|---|---|
| 1 | Per-user or per-org config? | ✅ **Per-user.** Each user's Gmail is their own; their thresholds and preferences are their own. Deals are always written at org scope (so other team members see them). |
| 2 | Opt-in or opt-out for AI scanning? | ✅ **Opt-in.** Master toggle defaults OFF. Privacy modal must be accepted before any classifier call runs. |
| 3 | What counts as "deal-related"? | ✅ **Golden set required before Phase A ships.** Dev creates 30 example emails covering: cold pitch, banker intro, founder intro, LP intro, portfolio update, recruiter spam, calendar invite, newsletter, internal team, vendor invoice. Founder reviews and labels. Classifier must hit ≥80% precision on this set before going live. |
| 4 | Cost ceiling per org/month? | ✅ **$50/org/month** for V1. Pre-LLM filter must cut ~70% of obvious noise. Warning notification at 80% of cap. Hard stop at 100% (defer remaining classifications to next billing cycle). |
| 5 | Conflict on AI updates to human-edited fields? | ✅ **Never overwrite.** If AI proposes a change to a field a human edited <7 days ago, the proposal is always queued — never auto-applied even above threshold. |
| 6 | Sensitive fields list (always-queue, never-auto)? | ✅ **`dealSize, stage, owner, askPrice, companyName, sector`.** All other fields (notes, contact list, mentioned numbers as `notes`) can auto-apply above threshold. |
| 7 | Daily digest default? | ✅ **ON for first 30 days** after user enables the feature. Then they can keep, change to weekly, or turn off. |
| 8 | Suggestion queue UI location? | ✅ **New page `/internal/deal-suggestions`** + a dashboard banner that links to it. NOT a tab on CRM — the CRM list should only show real deals, not suggestions. |

---

## 7. Estimated effort

| Phase | Estimate |
|---|---|
| A — Classifier + Suggestion Queue (incl. consent flow) | **1.5 weeks** |
| B — Auto-create with threshold + notifications | **4 days** |
| C — Thread continuity + updates | **1 week** |
| D — Contact extraction + dedupe | **4 days** |
| E — Configuration UI | **3 days** |
| F — Backfill | **4 days** |
| G — Push notifications | **3 days** |
| Cross-cutting (testing, discoverability, monitoring) | **1 week** |
| **Total** | **~6 weeks for one focused dev** |

---

## 8. What this feature is NOT (V1 non-goals)

Explicitly out of scope for V1 so they don't sneak in. Each may become a V1.1+ feature.

- ❌ **Phase 4 Outbound** — sending mail from the CRM. Separate spec, separate risk profile (write scopes).
- ❌ **Document extraction** — financial agent on PDFs is a different existing feature.
- ❌ **Memo generation** — existing memo builder is the surface for that.
- ❌ **LinkedIn enrichment** — firm research agent does that.
- ❌ **Outlook** — same architecture in future when Outlook integration ships, but separate work.
- ❌ **Internationalization** — V1 classifier prompt is English-only. Non-English emails get processed (no crash) but extraction quality is undefined. Defer multilingual to V1.1.
- ❌ **HTML signatures with contact info embedded as an image** — signature parser is text-only. If a banker's contact details are baked into a logo PNG, they're lost. Documented limitation, not a bug.
- ❌ **Granola transcripts / Calendar events feeding the suggestion queue** — same suggestion-queue architecture would work for any synced activity surfacing new companies/contacts, but V1 is **Gmail-only**. Defer cross-source unification to V1.1.
- ❌ **Subject-line-only privacy mode** — paranoid-mode toggle where AI only sees subject + sender, never body. Trade-off: meaningfully lower accuracy. Defer.
- ❌ **Custom per-org classifier prompts** — every org gets the same prompt + golden set. Per-firm tuning is V1.1+.
- ❌ **Auto-applied stage transitions** — AI never moves a deal between stages (e.g., "diligence → IC"). That always stays human. Out of scope forever, not just V1.
