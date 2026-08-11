# Trust Without SOC 2 — Design Spec

> **Status:** Spec, approved Path B + parallel Path A.
> **Author context:** Pocket Fund (PE deal CRM) is pre-revenue and not pursuing SOC 2 yet, but every demo prospect hesitates before uploading sensitive deal data (signed LOIs, DD packets, valuation models). This spec proposes a way to **build emotional trust visibly in the product** so prospects feel safe putting real data in, without paying for a SOC 2 cert.
> **Companion plan:** [`docs/superpowers/plans/2026-05-05-trust-without-soc2-implementation.md`](../plans/2026-05-05-trust-without-soc2-implementation.md)
> **Builds on:** [`docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`](../../SECURITY-TRUST-DEVELOPER-HANDOFF.md) (Phase 0 + Phase 1 already shipped on `feature/security-trust` / PR #9).

---

## Problem statement

PE prospects on every demo raise the same worry: *"Our deals are super valuable. We signed multiple LOIs and DDs to source them. We can't just hand them over to a startup CRM we just met."*

This is **emotional trust**, not **certification trust**. SOC 2 only solves a piece of it. The actual fears are:

1. **Insider risk** — "What if your engineer goes rogue and looks at my pipeline?"
2. **Continuity risk** — "What if your startup folds and our data ends up on someone's trash drive?"
3. **AI bleed-through risk** — "What if your AI surfaces my LOI in another customer's chat?"
4. **Opacity** — "I have no way to verify any of your security claims myself."
5. **Sunk-cost lock-in** — "If I upload everything and then want out, am I stuck?"

These are five different fears, not one. Each needs a separate visible answer.

We have already shipped (PR #9): tenant isolation proof, public Trust Center, sub-processor list, audit log filtering/export, org-wide MFA enforcement, security overview PDF. **That handles fear #4 (opacity) and chips at #1 and #3.** This spec covers what's left — and what would buy us the most demo conversion before SOC 2.

---

## Goals

A prospect on a demo, without seeing a single certification, should be able to say all of:

- "I can see exactly when Pocket Fund employees touch my data, and right now they haven't."
- "I can delete everything in one click and watch it happen."
- "I don't have to upload my live pipeline on day 1 — I can graduate from sandbox data when I'm ready."
- "I can get all my data back in a single export, anytime."
- "If a breach happens, I'm legally and financially covered."

If they can say those five things, they sign. SOC 2 stays on the roadmap but is no longer the gate.

---

## Non-goals

- SOC 2 Type I or II certification (continues separately on the existing roadmap)
- BYOK / customer-managed encryption keys (defer until a real enterprise prospect demands it)
- VPC / dedicated-tenant deployments (defer)
- Local-first / desktop / hybrid storage architecture (defer)
- Penetration test (separate budget item; useful but not in this spec)

---

## Approach

Two parallel workstreams. The dev only owns **Path B**. The founder/ops side owns **Path A**.

### Path B — Visible in-product trust (eng work)

The thesis: replace "trust me" with "verify it yourself." Every prospect fear answered by something they can click on in the product during a demo.

| # | Component | Fear it addresses | Effort |
|---|---|---|---|
| B1 | Customer-visible "Pocket Fund staff access log" | Insider risk (#1) | ~3 days |
| B2 | Self-serve "Delete all my organization's data" button | Sunk-cost lock-in (#5) | ~2 days |
| B3 | Trust-onboarding tier (sandbox → graduate to real data) | Day-one fear, opacity (#4) | ~3 days |
| B4 | Read-only one-click data export (full org dump as JSON+CSV) | Sunk-cost lock-in (#5), continuity (#2) | ~1 day |
| B5 | Optional access-log webhook to customer's Slack / email | Insider risk (#1), opacity (#4) | ~2 days |
| B6 | Public security pledge page with founder signature & contacts | Continuity (#2), opacity (#4) | ~0.5 days |

**Total: ~12 dev days. ~2.5 weeks calendar with one developer.**

### Path A — Paperwork & insurance wrap (ops/legal — runs in parallel, NOT eng work)

| # | Item | Cost | Time | Owner |
|---|---|---|---|---|
| A1 | DPA template drafted by SaaS lawyer (Cooley / Gunderson templates work fine) | $1-3K once | ~1 week | Founder + lawyer |
| A2 | Cyber insurance ($1M coverage) — Coalition / At-Bay / Vouch | $5-10K/yr | ~1 week | Founder |
| A3 | Pre-filled SIG-Lite questionnaire, kept current in `docs/security-questionnaires/SIG-Lite-2026.md` | $0 | ~1 day | Founder |
| A4 | Mutual NDA template, sent before any first demo with sensitive content | $0 | now | Sales |
| A5 | First reference customer (one PE firm willing to vouch publicly) — comp them with a free year if needed | ~$0 | ongoing | Founder |

These items are documented here only so the developer knows the context — they are NOT part of the dev backlog. Founder owns them. The product needs to *expose* the resulting artifacts (DPA download, insurance policy mention) which is part of B6.

---

## Path B — detailed component design

### B1 — Customer-visible Pocket Fund staff access log

**The fear:** "What if your engineer reads my deals?"

**The answer:** Every time anyone with admin/staff credentials at Pocket Fund accesses a customer's data, it's logged with timestamp, employee email, and reason. The customer admin can see this in the app. Default state for a new org: empty.

**Behavior:**

- A new env-driven list `POCKET_FUND_STAFF_EMAILS=ganesh@pocket-fund.com,...` identifies staff users
- Existing `auditLog` middleware fires on every API request that touches deal/document/financial/memo/contact resources. We add a hook: if the requester's email is in the staff list AND the resource's `organizationId` ≠ their own org, write a `STAFF_ACCESS` audit event *into the customer's organization's log*.
- A new section in Settings → Security: "Pocket Fund staff access log" — fetches `GET /api/audit?action=STAFF_ACCESS`, displays empty state by default ("Pocket Fund staff has accessed your data 0 times.")
- Empty state itself is the trust signal — no entries = nothing to fear

**Technical detail:**

- Add `STAFF_ACCESS` to `AUDIT_ACTIONS` in `apps/api/src/services/auditLog.ts`
- Modify the audit-log writer or add a parallel "staff access detector" middleware that runs after `orgMiddleware`:
  - If `req.user.email` is in `POCKET_FUND_STAFF_EMAILS`
  - AND the requested resource's `organizationId` differs from `req.user.organizationId`
  - Write an audit event into the *target org's* AuditLog with action `STAFF_ACCESS`, severity `WARNING`, metadata `{ staffEmail, route, method, justification?: string }`
- Frontend: new block in `apps/web/js/settingsSecurity.js` that fetches and renders the count + recent entries

**Acceptance:**

- A staff user accessing a customer's deal results in a visible audit row in that customer's audit log
- A staff user accessing their *own* org's data does NOT generate `STAFF_ACCESS` events (only cross-org access does)
- Empty state on Settings → Security says "Pocket Fund staff has accessed your data 0 times" with a clean visual
- An admin can click into individual entries to see timestamp + employee email + route + reason

**Demo line:** *"Want to see the log of every time Pocket Fund staff has touched your data? Click here. Currently zero. We'll never access your data without filing a ticket that lands here in real-time."*

---

### B2 — Self-serve "Delete all my data" button

**The fear:** "If I upload everything and then want out, you'll hold my data hostage."

**The answer:** A panic button in Settings that wipes the entire organization's data. 24-hour grace period to undo. Then irreversible. Customer gets a deletion certificate emailed.

**Behavior:**

- Settings → Security → "Delete organization data" (admin-only, requires typing the org name to confirm)
- Two-step:
  1. Click "Delete" → confirmation modal — must type org name + check "I understand this is irreversible after 24 hours"
  2. Confirmation modal → POST to `/api/organizations/me/schedule-deletion` → status: pending, deletion at `now + 24h`
- During grace: banner across the app says "Deletion scheduled for [date]. [Cancel deletion]"
- Cancel deletion: POST to `/api/organizations/me/cancel-deletion` (admin-only)
- After 24h: cron job (or scheduled function) executes the deletion: cascades deal, document, folder, memo, audit log, financial, contact for that org. Organization row stays as a "deleted" tombstone with `isActive=false`, `deletedAt`. Users get a final email with a deletion certificate (PDF or signed JSON).
- Vercel cron handles the scheduled execution (existing infra supports it); fallback: a simple admin-only endpoint to "execute pending deletions" that's invoked by an external cron service.

**Technical detail:**

- Two new columns on `Organization`: `deletionScheduledAt` (timestamptz, nullable), `deletionStatus` (enum: 'NONE' | 'PENDING' | 'DELETED', default 'NONE')
- New endpoints:
  - `POST /api/organizations/me/schedule-deletion` (admin only)
  - `POST /api/organizations/me/cancel-deletion` (admin only)
  - Internal cron-only `POST /api/admin/internal/execute-pending-deletions` (cron-secret-protected, NOT user-callable)
- New frontend block in Settings → Security with red styling, very explicit warnings
- Banner component (uses existing notification infra) that shows when `deletionStatus === 'PENDING'`
- Email template via Resend: "Your Pocket Fund organization data has been deleted. Certificate attached."

**Acceptance:**

- Admin can schedule deletion only after typing org name correctly
- Banner appears across app when scheduled
- Cancel works during grace period
- 24h+ later, cron executes — all org-scoped data deleted, certificate emailed
- Audit log: `ORG_DELETION_SCHEDULED`, `ORG_DELETION_CANCELLED`, `ORG_DELETION_EXECUTED` events
- Non-admins cannot schedule deletion (403)

**Demo line:** *"This is your panic button. Whether you stop paying us or just change your mind, your data is gone. 24-hour grace period in case you misclick. Want me to demo it on a test org right now?"* (Sales has a dedicated demo org for this.)

---

### B3 — Trust onboarding tier (sandbox → real data graduation)

**The fear:** "I'm not ready to upload my pipeline on day one."

**The answer:** New orgs default to **sandbox mode**. They get pre-loaded with synthetic deals (3-5 fake deals built from public SEC filings or anonymized data). They can play with the product without ever touching real data. When they're ready, they "graduate" — sandbox data is archived, real data uploads unlock.

**Behavior:**

- New `Organization` column: `mode` enum: 'SANDBOX' | 'PRODUCTION', default 'SANDBOX' for new orgs
- On signup, we seed the org with 3-5 synthetic deals (a JSON fixture in `apps/api/src/data/synthetic-deals.json`)
- All Pocket Fund features work normally on sandbox data
- Top of every page shows a sandbox banner: "Sandbox mode — these deals are demo data. [Graduate to production →]"
- On graduate: confirmation modal explains "Your sandbox deals will be archived. You can now upload real deals." → flips `mode` to PRODUCTION → archives sandbox deals (soft delete) → unlocks document upload
- In sandbox mode, **document upload is disabled** (most sensitive surface — no real CIMs, LOIs, financial models accidentally uploaded). Customer can browse-only. To unlock, they graduate.
- Sandbox can be reset back to fresh sandbox at any time (admin-only)

**Technical detail:**

- Migration: `Organization.mode` column + index
- Backend: middleware `enforceProductionMode` on document/upload routes — returns 403 with `code: SANDBOX_MODE` if org is in sandbox
- Frontend: `authFetch` interceptor catches `SANDBOX_MODE` → friendly modal "Upload requires graduating to production. [Graduate now]"
- Synthetic deals fixture: 3-5 deals with anonymized company names ("Acme Hardware Inc.", etc.), realistic financials, plausible LOIs (using public-domain CIM templates)
- Graduation endpoint: `POST /api/organizations/me/graduate` (admin only)
- Sandbox banner: rendered by `layout.js` when `org.mode === 'SANDBOX'`
- Reset endpoint: `POST /api/organizations/me/reset-sandbox` (admin only, sandbox mode only)

**Acceptance:**

- New signups land in sandbox mode with synthetic deals visible
- Document upload returns 403 in sandbox mode with clear UI message
- Banner visible across app
- Graduate flow archives sandbox deals and flips mode
- After graduation, document upload works normally
- Audit log entries: `ORG_GRADUATED`, `SANDBOX_RESET`

**Demo line:** *"On signup, you don't have to upload anything real. We pre-load sample deals so you can play. Most prospects spend 1-2 weeks in sandbox before graduating. We'll never push you."*

---

### B4 — One-click data export (full org dump)

**The fear:** "If I want to leave, I'm stuck with my data inside your system."

**The answer:** A button in Settings → Security: "Export all organization data." Single click → all deals, documents (links + metadata), financials, memos, contacts, audit logs, sub-folder hierarchy bundled into a `.zip` containing a JSON manifest + per-resource CSVs. Email arrives in 5-15 minutes with a signed download link (24-hour expiry).

**Behavior:**

- Frontend button in Settings → Security: "Export all data"
- Click → POST `/api/organizations/me/export` → returns `{ jobId, estimatedSeconds }` + closes modal with "We'll email you when it's ready"
- Backend kicks off a background export (synchronous for now, ≤5MB; consider async for larger). Builds `.zip` containing:
  - `manifest.json` — org metadata, export timestamp, content summary
  - `deals.csv`, `documents.csv` (with signed download URLs valid 24h), `financials.csv`, `memos.csv` (or `.json` for memo body), `contacts.csv`, `audit-log.csv`, `folders.csv`
  - `README.txt` explaining the structure
- Stores zip in Supabase Storage with 24h expiry
- Sends Resend email: "Your Pocket Fund export is ready: [download link]"
- Audit log: `ORG_DATA_EXPORTED`

**Technical detail:**

- New endpoint: `POST /api/organizations/me/export` (admin or any active user with `EXPORT` permission; default: admin/partner/principal)
- Reuses existing CSV serialization from audit-export route (B1's neighbor)
- Documents are exported as metadata + signed Supabase Storage URLs (NOT inlined; would balloon zip)
- Rate limited: max 1 export per org per day (configurable)

**Acceptance:**

- Admin clicks button → modal closes → email arrives within 15 min
- Zip contains all expected files
- All file content is valid CSV / JSON
- Document URLs in the zip work and expire after 24h
- Non-admin gets 403
- Audit log entry created

**Demo line:** *"You're not locked in. Click here, we email you a zip of everything in 15 minutes. Take it to a competitor. You always own your data."*

---

### B5 — Access-log webhook to customer's Slack / email

**The fear:** "I want passive monitoring of my own data — not have to log in to check."

**The answer:** Customer admin can configure a Slack incoming webhook URL OR an email address that gets pinged whenever a `STAFF_ACCESS` event fires. Real-time. The customer's security team gets notified before Pocket Fund's own staff finishes the read.

**Behavior:**

- Settings → Security → "Notify on staff access" section
- Fields: Slack webhook URL (https://hooks.slack.com/...), Email address, Toggle: enable/disable
- When `STAFF_ACCESS` event fires (B1), the audit log writer also POSTs to the configured webhook with: `{ timestamp, staffEmail, action, route, justification }`
- For email: send via Resend with subject "Pocket Fund staff accessed your data"
- Webhook delivery is best-effort: if Slack URL is invalid, log error but don't block
- Customer can rotate or disable the webhook anytime

**Technical detail:**

- New columns on Organization: `staffAccessWebhookUrl` (text, nullable), `staffAccessNotifyEmail` (text, nullable)
- Validate URL format on save (must start with https://hooks.slack.com/ for Slack — or just any https://; let customer choose any webhook target)
- Settings UI: form with three fields (URL, email, enable toggle), test button that sends a sample event
- Backend: in B1's `STAFF_ACCESS` writer, also fire webhook (fire-and-forget, with timeout)
- For email, uses existing Resend infra

**Acceptance:**

- Customer can configure webhook URL + email
- Saving fires a test event ("This is a test from Pocket Fund.")
- Real `STAFF_ACCESS` events trigger webhook + email within 5s
- Failed webhook delivery is logged but doesn't crash the audit write
- Customer can clear the config (admin only)

**Demo line:** *"Want your security team to get a Slack ping the moment any of our staff touches your data? Drop a webhook URL. They'll know before we finish the read."*

---

### B6 — Founder security pledge page

**The fear:** "I want a real human committing to this, not a corporate boilerplate."

**The answer:** A signed pledge page accessible from `/security` and Settings → Security. Includes:

- Founder's full name + title + signed signature image
- Specific commitments (e.g., "We will never sell, share, or use your data for ML training. If we breach our security, the founder personally indemnifies Pocket Fund per the DPA. Customers get 90 days notice before any sub-processor change.")
- Date signed
- Email link to founder for any concerns

**Behavior:**

- New section on existing `apps/web/security.html` titled "Founder pledge"
- Optional separate `apps/web/security-pledge.html` for direct-link sharing
- Linked from Settings → Security action buttons

**Technical detail:**

- Pure HTML edit. Signature can be a base64 PNG or just a script-font name in colored text initially.
- ~30 lines of HTML, ~1 hour of work

**Acceptance:**

- Pledge visible on `/security` page
- Linked from Settings
- Signed and dated

**Demo line:** *"Read the founder's pledge. He signs his name to this. If anything goes sideways, you have a name to call."*

---

## Path A — paperwork & insurance wrap (ops/legal, runs in parallel)

These items are surfaced in the product (download links, insurance mentions) but the eng dev does NOT own them. Founder owns these.

| Item | Where it surfaces in product |
|---|---|
| DPA PDF (lawyer-drafted) | `apps/web/assets/pocket-fund-dpa.pdf` (mailto fallback if not yet drafted), linked from `/security` and Settings → Security |
| Cyber insurance summary | One-line mention on `/security` page: "We carry $1M cyber-liability coverage via [Insurer]." |
| SIG-Lite questionnaire | `docs/security-questionnaires/SIG-Lite-2026.md` (sales sends on request) |
| Mutual NDA template | `docs/legal/mutual-nda-template.pdf` (sales sends before first demo with sensitive content) |
| Reference customer | When a PE firm signs to vouch, add a quote + logo to `/security` and update sales decks |

The dev's only Path A touchpoint: when these artifacts exist as static files, they replace the mailto-fallback links in `apps/web/security.html` and `apps/web/js/settingsSecurity.js`. Trivial swap.

---

## Demo flow — how it all comes together

After Path B + Path A ship:

1. (0:00) Prospect raises the data-safety concern.
2. (0:10) Sales: *"Three things — data, control, recourse. 90 seconds."*
3. (0:20) Open `/security` (already exists). Trust badges, sub-processor table, founder pledge, DPA download.
4. (0:35) Switch to logged-in app → Settings → Security.
5. (0:45) Click "Run isolation test" (already shipped). 8/8 BLOCKED in 1.8s.
6. (1:00) Scroll to "Pocket Fund staff access log." Empty. *"We have not accessed your data once. If we ever do, you'll see it here in real-time and your Slack will get a ping."*
7. (1:15) Show "Delete all my data" button. *"You're never locked in."*
8. (1:25) Show sandbox banner if applicable: *"You don't have to upload your real pipeline today. Sandbox first. Graduate when ready."*
9. (1:30) Wrap: *"DPA on the way after this call. We're insured for $1M. Want to start?"*

If we get all of this answered in 90 seconds, the security objection effectively disappears.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Sandbox mode breaks user expectations ("why can't I upload?") | Clear banner + friendly modal on the upload-blocked path; one-click graduation |
| 24h delay on data deletion frustrates rage-quitting customer | Document the policy clearly; offer founder-mediated immediate deletion as escape hatch |
| Webhook misconfiguration spams customer Slack | Test event on save; rate-limit notifications (max 1 per minute per org) |
| Synthetic deals look fake / unprofessional | Source from real anonymized deals; review with founder before shipping |
| `POCKET_FUND_STAFF_EMAILS` env var becomes stale | Document the rotation cadence; add a startup check that warns if list is empty |
| Reference customer pulls out / churns | Have a backup; don't bet sales narrative on a single firm |
| Data export contains sensitive PII a customer expected to be encrypted | Document explicitly what's in the export; let customer review before download |

**Open question for founder:** Do we want sandbox mode to be **on by default for new signups** (slower path to "real" usage but stronger trust signal), or **off by default with a clear "start in sandbox" toggle** (faster onboarding, weaker trust signal)? Recommendation: **on by default** — once trust is the bottleneck, we should optimize for it.

---

## Success criteria

- All 6 Path B components shipped to production
- Founder pledge live on `/security`
- DPA available (PDF or "available on request via mailto")
- Cyber insurance bound and mentioned on `/security`
- One reference PE firm publicly vouching by Q3
- **Demo objection rate** (tracked manually for next 10 demos) drops by ≥50%
- One signed contract from a prospect that previously hesitated on security

---

## Out of scope (explicitly)

- SOC 2 Type I or II
- ISO 27001
- BYOK / customer-managed keys
- VPC deployment
- End-to-end encryption / client-side encryption
- Local-first storage
- HIPAA / healthcare compliance
- Penetration test (recommended separately)

---

## References

- Builds on PR #9 work — see [`docs/SECURITY-TRUST-DEVELOPER-HANDOFF.md`](../../SECURITY-TRUST-DEVELOPER-HANDOFF.md)
- Public security page: `apps/web/security.html`
- Existing audit log infra: `apps/api/src/services/auditLog.ts`, `apps/api/src/routes/audit.ts`
- Existing org-scope middleware: `apps/api/src/middleware/orgScope.ts`
