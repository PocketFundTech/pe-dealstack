# Pocket Fund Staff Access Log — Design Spec

> **Status:** Spec ready to build
> **Companion plan:** [`docs/superpowers/plans/2026-05-07-staff-access-log-implementation.md`](../plans/2026-05-07-staff-access-log-implementation.md) *(written alongside this spec)*
> **Tracker:** [`docs/SECURITY-TRUST-MASTER-TODO.md`](../../SECURITY-TRUST-MASTER-TODO.md) → Priority 1
> **Refines and replaces:** [`docs/superpowers/specs/2026-05-05-trust-without-soc2-design.md`](2026-05-05-trust-without-soc2-design.md) → B1 (this spec is the single-feature deep-dive; the 2026-05-05 doc keeps the broader context for B2-B6)

---

## The single sentence

When a Pocket Fund employee accesses a customer's data, that customer sees the access — in real time, in their own audit log, with employee email, route, and reason — and can configure a Slack/email webhook to be paged the moment it happens.

---

## Problem statement

PE prospects on every demo eventually ask the question that sales has no good answer for:

> **"What about YOUR engineers? They have admin access to the database, right? What stops them from reading my pipeline?"**

Today's honest answer is *"we have access controls and audit logging internally."* That doesn't land. PE compliance officers don't trust internal-only controls — they trust **customer-visible evidence**.

The prospect's actual fear isn't that we're malicious. It's:

1. **Insider risk** — a rogue engineer reads a competitor's pipeline before the deal closes
2. **Inadvertent exposure** — a junior engineer debugging a customer's issue reads their LOI by accident
3. **No way to verify** — even if we promise we don't access data, they can't check

This spec fixes #3 by giving the customer a verifiable, real-time view of every Pocket Fund staff access to their data. Solving #3 also indirectly solves #1 and #2 because access becomes auditable.

---

## What success looks like

**On a demo, when a prospect raises the engineer-access question:**

1. Sales clicks Settings → Security & Privacy
2. Scrolls to the new "Pocket Fund staff access log" card
3. The card displays: a large green check, the count `0`, and the message *"Pocket Fund staff has accessed your data **0 times** in the last 90 days. When staff access your data, you'll see entries here in real-time."*
4. Sales: *"Want your security team paged the moment that number goes above zero? Drop a Slack webhook URL right here."* — pastes a test webhook URL, clicks Save and Test, prospect's Slack receives a test event

**Total demo time:** 30 seconds. **Demo outcome:** the engineer-access objection is dead.

---

## Non-goals

- **Staff impersonation flow** — explicitly switching staff into a customer org context. This is a follow-up. The middleware in this spec is forward-compatible with it but does not require it.
- **Per-route allowlists for staff access** — fine-grained "engineers can read deals but not financials" rules. Out of scope; v1 logs all access uniformly.
- **Real-time block** of staff access (e.g. "no Pocket Fund employee can read this deal without my approval"). This is a future feature; v1 logs but does not gate.
- **Cryptographic tamper-evidence** for the staff access log specifically. Audit log tamper-evidence is a separate Phase 3 spec covering the whole audit log.

---

## How it works (the design in three pieces)

### 1. Identifying staff requests

A request is a "staff access" event if both:

- The authenticated user's email is in the **`POCKET_FUND_STAFF_EMAILS`** environment variable (a comma-separated allowlist set on Vercel)
- The request hits an instrumented data route — one of: `/api/deals`, `/api/documents`, `/api/folders`, `/api/financials`, `/api/memos`, `/api/contacts`, `/api/companies`, `/api/audit`

This list is conservative. We log access to *customer business data*, not generic platform routes (auth, settings, profile pages).

### 2. Recording the event

A new audit action `STAFF_ACCESS` is appended to the **target organization's** audit log. The event payload contains:

```json
{
  "action": "STAFF_ACCESS",
  "resourceType": "SETTINGS",
  "resourceId": "<orgId>",
  "organizationId": "<orgId>",
  "userId": "<staff-internal-user-id>",
  "severity": "WARNING",
  "metadata": {
    "staffEmail": "engineer@pocket-fund.com",
    "method": "GET",
    "path": "/api/deals",
    "ip": "1.2.3.4",
    "ua": "<user-agent>",
    "justification": "<future field, optional in v1>"
  },
  "createdAt": "..."
}
```

Severity is `WARNING` not `INFO` so it stands out in the customer's filtered audit views.

### 3. Surfacing the event

Two surfaces:

**Surface A — In-app card in Settings → Security & Privacy.** Always rendered. When count is 0, the card shows a green check and reassurance text. When count > 0, the card shows the count and a list of the 10 most recent entries (timestamp, email, method + path).

**Surface B — Customer-configurable webhook.** Admin pastes a Slack incoming webhook URL and/or an email address into a config form (also in Settings → Security & Privacy). On every `STAFF_ACCESS` event, both targets are pinged with the same payload as above. A "Save and Test" button fires a one-shot test event so the customer can verify wiring before they need it.

### 4. Failure semantics (CRITICAL — get this right)

- The middleware **never blocks** the staff request, even if the audit log write fails. The customer's experience must not depend on this logging path.
- The webhook + email notification is **fire-and-forget** with a 5-second timeout. If Slack is down, we don't crash the audit write.
- The `POCKET_FUND_STAFF_EMAILS` env var is **case-insensitive** matched and trimmed.
- If the env var is unset or empty, the middleware no-ops cleanly. Don't error-out.

---

## User flows

### Flow A — Customer admin views their staff access log (empty state)

1. Logs into lmmos.ai
2. Profile dropdown → Settings → Security & Privacy
3. Below the existing 2FA / Encryption / Tenant isolation cards, sees a new card titled **"Pocket Fund staff access log"**
4. Card shows a 32px green checkmark icon, large text `0`, and the message: *"Pocket Fund staff has accessed your data **0 times** in the last 90 days. When staff access your data, you'll see entries here in real-time."*
5. Below the message: a small "View full audit log →" link that deep-links into Admin Dashboard activity feed pre-filtered to action=`STAFF_ACCESS`

### Flow B — Customer admin configures a Slack webhook

1. In the same card, scrolls to "Real-time notifications" subsection
2. Sees a form with three fields:
   - Slack webhook URL (text input, validation: must start with `https://hooks.slack.com/`)
   - Notification email (email input, optional)
   - Toggle: "Enable real-time notifications"
3. Pastes a test webhook URL into the Slack field
4. Clicks **"Save and test"**
5. UI shows a spinner, then a success toast: *"Saved. Test event sent."*
6. The Slack channel receives a message: *"This is a test from Pocket Fund. Real staff access events will appear here. — Organization: [Org Name]"*
7. Customer audit log gains a new event: `STAFF_WEBHOOK_TEST`

### Flow C — A Pocket Fund engineer accesses a customer's deal

(Without the future "staff impersonation" flow, this happens only when a staff member is also a member of the customer's org — e.g., an enterprise customer adds the founder's email as a member for support reasons. This is the realistic trigger path in v1.)

1. Engineer with email `dev@pocket-fund.com` (which is in `POCKET_FUND_STAFF_EMAILS`) is added as a member of `acme-fund-llc` org
2. Engineer logs in, navigates to `/deals/abc-123` to debug a reported issue
3. Frontend issues `GET /api/deals/abc-123` with the engineer's JWT
4. `authMiddleware` populates `req.user` (id, email, organizationId=`acme-fund-llc`)
5. `orgMiddleware` confirms organizationId
6. `enforceOrgMfaMiddleware` (existing) passes — engineer has MFA
7. **NEW: `staffAccessLogger`** middleware runs:
   - Sees `req.user.email = dev@pocket-fund.com` is in `POCKET_FUND_STAFF_EMAILS`
   - Sees request path `/api/deals` matches an instrumented prefix
   - Asynchronously calls `logAuditEvent` with action=`STAFF_ACCESS`, organizationId=`acme-fund-llc`, severity=`WARNING`, metadata={ staffEmail, method, path, ip, ua }
   - Asynchronously fires webhook + email if configured
   - Calls `next()` synchronously — the engineer's request continues without delay
8. The customer's admin opens Settings → Security & Privacy, sees the count update from `0` to `1`
9. (If webhook configured) the customer's Slack channel gets a message within ~5 seconds: *"Pocket Fund staff (dev@pocket-fund.com) accessed your data: GET /api/deals — Organization: Acme Fund LLC"*

### Flow D — Customer admin reviews a staff access event

1. Sees the count `1` in the staff access log card
2. Clicks "View entries" or scrolls down
3. Sees a list with one entry:
   ```
   2026-05-07 14:23:11 UTC    dev@pocket-fund.com    GET /api/deals
                              IP: 1.2.3.4
   ```
4. Clicks the entry → navigates to Admin Dashboard activity feed pre-filtered to `STAFF_ACCESS`
5. Activity feed shows the full audit row with all metadata and gives the option to export as CSV

---

## Component design

### Backend

#### Migration `apps/api/staff-access-log-migration.sql`

Idempotent. Adds two columns to `Organization`:

```sql
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "staffAccessWebhookUrl" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "staffAccessNotifyEmail" TEXT NULL;
```

These columns are nullable. Default is null (no notifications). The customer opts in.

#### Audit actions in `apps/api/src/services/auditLog.ts`

Add two new constants to `AUDIT_ACTIONS`:

```ts
STAFF_ACCESS: 'STAFF_ACCESS',
STAFF_WEBHOOK_TEST: 'STAFF_WEBHOOK_TEST',
```

#### Middleware `apps/api/src/middleware/staffAccessLogger.ts`

New file. Exports `staffAccessLogger`. Called after `authMiddleware`, `orgMiddleware`, `enforceOrgMfaMiddleware`. Logic:

```
function staffAccessLogger(req, res, next):
  next()                            # ALWAYS proceed first
  try:
    user = req.user
    if not user or not user.email: return
    email = user.email.lowercase().trim()
    staffEmails = parseEnv("POCKET_FUND_STAFF_EMAILS")  # cached, refreshed lazily
    if email not in staffEmails: return
    path = req.originalUrl.split("?")[0]
    if not any(path.startsWith(p) for p in INSTRUMENTED_PREFIXES): return
    orgId = user.organizationId
    if not orgId: return
    fireAndForget(logAuditEvent({
      action: STAFF_ACCESS,
      resourceType: SETTINGS,
      resourceId: orgId,
      organizationId: orgId,
      userId: user.id,
      severity: WARNING,
      metadata: { staffEmail, method: req.method, path, ip: req.ip, ua: req.get("user-agent") },
    }, req))
    fireAndForget(notifyStaffAccess(orgId, { staffEmail, method, path }))
  except err:
    log.warn("staffAccessLogger error", err)
```

Notes:
- `INSTRUMENTED_PREFIXES = ['/api/deals', '/api/documents', '/api/folders', '/api/financials', '/api/memos', '/api/contacts', '/api/companies', '/api/audit']`. `/api/auth`, `/api/users/me`, `/api/organizations/me`, `/api/usage`, `/api/onboarding`, `/api/notifications`, `/api/templates`, `/api/tasks`, `/api/admin/security/run-isolation-test` are intentionally NOT instrumented (these are platform routes, not customer business data).
- `parseEnv` caches the parsed set per process for performance; refreshes if the env var changes (rare; restart anyway).
- Best-effort — never crashes the request.

#### Notifier `apps/api/src/services/staffAccessNotifier.ts`

New file. Exports `notifyStaffAccess(orgId, event)`. Logic:

```
async function notifyStaffAccess(orgId, event):
  org = supabase.from("Organization").select("staffAccessWebhookUrl, staffAccessNotifyEmail, name").eq("id", orgId).single()
  if not org: return
  payload = {
    timestamp: now(),
    event: "staff_access",
    staffEmail, method, path,
    organization: org.name,
    testMode: event.testMode || false,
    message: testMode ? "Test from Pocket Fund. Real events will appear here."
                      : "Pocket Fund staff (" + staffEmail + ") accessed your data: " + method + " " + path,
  }
  if org.staffAccessWebhookUrl:
    fetch(org.staffAccessWebhookUrl, POST, body=slackBlocks(payload), timeout=5000)
  if org.staffAccessNotifyEmail:
    resend.send({ from: "security@pocket-fund.com", to: org.staffAccessNotifyEmail, subject: ..., html: ... })
```

`slackBlocks` builds a Slack-compatible payload (text + attachments with key/value fields).

#### Route `apps/api/src/routes/org-staff-webhook.ts`

New file. Exports an Express router with one endpoint:

```
PATCH /api/organizations/me/staff-access-webhook
```

- Admin-only (role check)
- Body validated by Zod: `{ staffAccessWebhookUrl: nullable URL, staffAccessNotifyEmail: nullable email }` strict
- Updates the org row, audit-logs `SETTINGS_CHANGED`
- If the body sets a non-null URL or email, immediately fires a test event via `notifyStaffAccess(orgId, { ..., testMode: true })`
- Audit-logs `STAFF_WEBHOOK_TEST`
- Returns the updated `{ id, staffAccessWebhookUrl, staffAccessNotifyEmail }`

Mounted in `app.ts`:

```ts
app.use('/api/organizations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, orgStaffWebhookRouter);
```

(Mounted alongside the existing `organizationsRouter`.)

### Frontend (Next.js / `apps/web-next`)

#### New component `apps/web-next/src/app/(app)/settings/SecuritySection.staffAccessLog.tsx`

Server-or-client component (client, since it has interactive form + live data fetch). Renders inside the existing `SecuritySection.tsx`. Two stacked cards:

**Card 1 — Staff access count + recent entries**

Fetches `GET /api/audit?action=STAFF_ACCESS&limit=10` on mount. Passes through the existing `api.get` helper which forwards the JWT.

States:
- **Loading:** `<Skeleton />`
- **Empty (count = 0):** Big green check icon + `"0"` count + reassurance text + "View full audit log →" deep link to `/admin?activityFilter=STAFF_ACCESS`
- **Non-empty (count > 0):** count + list of 10 most recent entries (timestamp, email, method + path) + "View all" link
- **Error:** muted "Unable to load staff access log" with retry button

**Card 2 — Real-time notifications config (admin-only)**

Form:
- Slack webhook URL field (placeholder: `https://hooks.slack.com/services/...`)
- Notification email field (placeholder: `security@yourfirm.com`)
- "Save and test" button (full width, primary color)

On save:
- POST `PATCH /api/organizations/me/staff-access-webhook`
- Show toast: *"Saved. Test event sent — check your Slack/email."*
- On error: toast with message + keep form values

Visible to admin only (role check via existing `useUser()` hook). For non-admins, show: *"Your admin can configure real-time notifications for Pocket Fund staff access."*

#### Wire into existing `SecuritySection.tsx`

Add `<StaffAccessLogCard />` below the existing tenant isolation badge and AI handling note, above the "Active sessions" card. Order matters for demo flow.

#### Reload on focus

Use `useEffect` with `window.addEventListener('focus', refresh)` so the count updates when the user returns to the tab. Helpful for demos where sales clicks the button, switches tabs, then returns.

---

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `POCKET_FUND_STAFF_EMAILS` | Vercel production env | Comma-separated allowlist of staff Gmail addresses. Example: `ganesh@pocket-fund.com,dev@pocket-fund.com,security@pocket-fund.com` |
| `RESEND_API_KEY` | Already set | Used for the notification email path (existing infra) |

If `POCKET_FUND_STAFF_EMAILS` is unset, the middleware no-ops cleanly. **Set it on Vercel before merging the PR**, otherwise the feature is dead-effective.

---

## Acceptance criteria

A staff user authenticated as `dev@pocket-fund.com`, member of customer org `acme-fund-llc` (which has `dev@pocket-fund.com` added as a member for support reasons):

- [ ] `GET /api/deals` → 200, customer audit log gets a new `STAFF_ACCESS` row within 1 second
- [ ] `GET /api/users/me` → 200, NO `STAFF_ACCESS` event (not instrumented)
- [ ] `GET /api/organizations/me` → 200, NO `STAFF_ACCESS` event (not instrumented)
- [ ] `POST /api/auth/sessions/:id/revoke` → 200, NO `STAFF_ACCESS` event (auth route)

A non-staff user authenticated as `customer@acme-fund-llc.com`:

- [ ] `GET /api/deals` → 200, NO `STAFF_ACCESS` event (not staff)

A staff user accessing their OWN org (where they are a regular member of `pocket-fund-internal-test-org`):

- [ ] `GET /api/deals` → 200. NO `STAFF_ACCESS` event (cross-org check would be ideal but for v1, since target org IS staff's home org, log nothing). Actually: spec says we log every staff access into whatever org they're operating as — so this DOES log. **Decision for v1:** log it. False positives are acceptable; prospects can audit the entries and confirm they're internal. Easier than building a cross-org check now.

Customer admin in Settings → Security:

- [ ] Empty state renders correctly with count = 0 and the reassurance message
- [ ] After a `STAFF_ACCESS` event fires, refreshing the page shows the entry in the list
- [ ] Admin pastes a Slack webhook URL → "Save and test" → Slack receives test event within 5 seconds
- [ ] Admin pastes an email → "Save and test" → email arrives within 30 seconds
- [ ] Non-admin sees the staff access log count but NOT the webhook config form
- [ ] Saving an invalid URL ("not-a-url") returns 400 with field-level error

The middleware:

- [ ] If `POCKET_FUND_STAFF_EMAILS` is unset, every staff request behaves identically to a non-staff request (no events, no errors)
- [ ] If Supabase is briefly unreachable when writing the audit event, the request still completes (the engineer doesn't see a 500)
- [ ] If the configured Slack webhook URL returns 500 or times out, the audit event is still written (best-effort separation)

---

## Risks and open questions

| Risk | Mitigation |
|---|---|
| **False positives in v1** — staff member accessing their own org logs `STAFF_ACCESS`. | Document in spec. Add a follow-up cross-org check as Phase 2. Customer can mentally filter. |
| **Webhook misconfiguration spams customer Slack** | Test event on save validates the wiring. Rate-limit production webhook firing to max 1/sec per org if needed (not in v1). |
| **`POCKET_FUND_STAFF_EMAILS` rotation** | Document in CLAUDE.md / DEPLOYMENT.md. Stale entries (former employees still in env var) is annoying but not dangerous — they just show up in customer logs as expected. |
| **Customer reads the empty state and assumes we'll never access** | UX writing must be clear: *"When staff access your data, you'll see entries here."* — sets the expectation that 0 is current state, not eternal promise. |
| **Performance — every API request now does an env-var check + email check** | env-var parsed once and cached as a Set. Set lookup is O(1). Negligible cost. |
| **Privacy — staff IP and UA logged into customer's audit log** | Acceptable. Customer should know who+where accessed their data. No PII beyond what they expect. |

### Open question: should v1 capture a "justification" field?

If we required staff to provide a written justification before any cross-org access (e.g., "investigating bug report #4521"), each `STAFF_ACCESS` event would have a human-readable reason. **Decision for v1: no.** Adding the justification flow requires a UI for staff and a separate impersonation pattern. Ship v1 without; add justification in Phase 2 when we build proper impersonation. For now, the metadata captures the route/method which is enough for forensics.

---

## What's NOT in this spec (intentional, for later phases)

- **Staff impersonation flow** — explicit toggle for staff to switch into a customer org context. Future spec.
- **Cross-org checking** — distinguish "staff accessing customer org" vs "staff accessing internal org". Future enhancement.
- **Real-time block** — customer rule "no Pocket Fund employee can access this deal without a ticket". Future feature.
- **Aggregated weekly digest** — automated weekly email summarizing all staff accesses. Future enhancement.
- **Tamper-evident audit log** — cryptographic chain so we can't quietly delete entries. Big separate spec.
- **Anomaly detection** — "unusual access pattern" alerts. Builds on this foundation but is a separate feature.

---

## After this ships, what's next (priority queue)

This spec is one feature. The full sequence I want to build, one at a time, is:

| # | Feature | Effort | Why |
|---|---|---|---|
| 1 | **Pocket Fund staff access log** *(this spec)* | ~3 days | Closes the #1 demo objection |
| 2 | **Per-deal access timeline** — embedded in deal pages | ~2 days | Big team-visibility win for the user too, not just security |
| 3 | **Document watermarking on PDF downloads** | ~2 days | Strong leak deterrent; impressive demo |
| 4 | **Self-serve "Delete all my data" button** | ~2 days | Settles "lock-in" objection (Phase 1.5 B2) |
| 5 | **Customer security dashboard** | ~1.5 days | One-page security KPIs (active sessions, MFA enrollment %, recent exports, recent role changes, anomalies) |
| 6 | **Anomaly detection (rule-based v1)** | ~2 days | Catches "User X downloaded 50 docs in 5 min" type patterns |
| 7 | **AI inference audit trail** | ~1 day | Every LLM call on a deal logged with prompt summary |
| 8 | **One-click data export** | ~1.5 days | "I'll be locked in" objection (Phase 1.5 B4) |
| 9 | **Trust onboarding sandbox tier** | ~3 days | "Not ready to upload day 1" objection (Phase 1.5 B3) |
| 10 | **30-day soft-delete recovery** | ~1.5 days | "What if I delete by mistake?" |
| 11 | **Document fingerprinting (SHA-256 verification)** | ~1.5 days | "Has my doc been tampered with?" |
| 12 | **Tamper-evident audit log (Merkle chain)** | ~2 days | "Can you delete entries quietly?" |
| 13 | **Per-deal access controls (Chinese walls)** | ~3 days | Confidential-deal hiding for IC-only deals |
| 14 | **Auto-expiring share links for external counsel** | ~2 days | Lawyer/banker portal use case |
| 15 | **Founder pledge section on `/security`** | ~0.5 day | Small but personal trust signal (Phase 1.5 B6) |

That's roughly 5-6 weeks of focused work. Each ships independently. Each has its own demo line.

---

## Demo line for THIS feature

> *"You're worried about my engineers? Here's the log of every Pocket Fund staff access to your data. Currently zero. Add your Slack webhook here — your security team gets paged the moment that number changes."*

That's it. That's the feature.

---

## File-level changes (forward reference to the implementation plan)

| File | Change |
|---|---|
| `apps/api/staff-access-log-migration.sql` | New — adds 2 columns to Organization |
| `apps/api/src/services/auditLog.ts` | Modified — adds 2 new audit actions |
| `apps/api/src/services/staffAccessNotifier.ts` | New — webhook + email notifier |
| `apps/api/src/middleware/staffAccessLogger.ts` | New — middleware that fires `STAFF_ACCESS` events |
| `apps/api/src/routes/org-staff-webhook.ts` | New — `PATCH /me/staff-access-webhook` endpoint |
| `apps/api/src/routes/organizations.ts` | Modified — `GET /me` returns the new webhook config fields |
| `apps/api/src/app.ts` | Modified — mounts `staffAccessLogger` globally on `/api/*`; mounts `orgStaffWebhookRouter` |
| `apps/web-next/src/app/(app)/settings/SecuritySection.staffAccessLog.tsx` | New — the UI card + form |
| `apps/web-next/src/app/(app)/settings/SecuritySection.tsx` | Modified — imports and renders the new component |
| `apps/api/tests/staff-access-logger.test.ts` | New — vitest unit tests for the middleware |
| `apps/api/tests/org-staff-webhook.test.ts` | New — vitest tests for the webhook config endpoint |

Implementation plan with task-by-task breakdown will live at `docs/superpowers/plans/2026-05-07-staff-access-log-implementation.md` (next document).

---

*Design reviewed by: Claude (Opus 4.7). Approved by: Ganesh (auto mode authorization).*
