# Email Notifications Batch — Design Spec

## Problem

Following the signup-welcome-email work (merged, `docs/superpowers/specs/2026-08-25-signup-welcome-email-design.md`), a gap audit against industry-standard SaaS/PE-CRM/VDR email taxonomy identified 9 more missing email types (10th — billing/dunning — dropped: this codebase has no payment/billing infrastructure at all, so there's nothing to hook an email into; revisit once monetization exists).

This spec batches lightweight designs for all 9 so they can be built together. Each follows the same reference pattern established by `apps/api/src/services/welcomeEmail.ts`: a null-safe Resend client, `escapeHtml`'d inputs, inline Banker Blue (`#003366`) HTML, returns `boolean`, never throws into its caller.

## Cross-cutting decisions

- **Recipient resolution never trusts client input for security-sensitive sends** (password-changed, new-device login) — always looked up server-side from the authenticated session (`req.user`), same principle as welcome-email's server-side lookup-by-id.
- **Two features require a manual Supabase migration** (flagged per-feature below) — per this repo's migration gate, they are not "done" until the founder runs the SQL and confirms it. The other 7 need zero schema changes.
- **Bundle placement**: none of these touch LLM/agent code, so every new route/cron lands in the **lite** bundle (`app.ts` + `app-lite.ts` only, no `app-ai.ts`/`pickBundle` change) — same reasoning as welcome-email.
- **Cron auth**: new cron routes follow the existing pattern (`CRON_SECRET` bearer header, see `cron-reactivation.ts`, `cron-doc-request-reminders.ts`) and get an entry in `apps/api/vercel.json`.

---

## 1. Password-changed confirmation

**No migration needed.**

- **Trigger**: client-side, right after `supabase.auth.updateUser({ password })` resolves successfully in either of the two existing call sites — `apps/web-next/src/app/(app)/settings/SecuritySection.tsx:50` (settings page) and `apps/web-next/src/app/(auth)/reset-password/page.tsx:85` (post-reset-link page). Unlike signup, a valid session exists at both call sites (reset-password uses Supabase's recovery-token session), so this uses a **normal authenticated** endpoint via `api.post(...)` — no userId-lookup/recency-guard dance needed.
- **New route**: `apps/api/src/routes/account-security.ts`, mounted authenticated at `/api/account/security` (needs `authMiddleware` only — no org/MFA middleware, since this fires for any logged-in user). `POST /password-changed` reads `req.user.id`/`email`/`name` from the auth middleware's attached user, calls the service.
- **New service**: `apps/api/src/services/passwordChangedEmail.ts` — `sendPasswordChangedEmail({to, name})`.
- **Copy**: "Your Avise password was just changed. If this wasn't you, contact us immediately." No link/button (avoids being an ideal phishing template).

## 2. New-device / new-location login alert

**⚠️ Migration needed** — no login/device tracking exists anywhere in this codebase today (confirmed: no `Session`/`LoginHistory` table, `auth-sessions.ts` only proxies Supabase's own session list live, doesn't persist anything).

- **New table** (`apps/api/login-device-migration.sql`):
  ```sql
  CREATE TABLE "KnownLoginDevice" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" uuid NOT NULL,
    "fingerprintHash" text NOT NULL,   -- sha256(ip + '|' + userAgent)
    "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
    "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE("userId", "fingerprintHash")
  );
  CREATE INDEX ON "KnownLoginDevice"("userId");
  ```
- **Trigger**: client-side, right after `supabase.auth.signInWithPassword()` succeeds in `apps/web-next/src/app/(auth)/login/page.tsx` — authenticated POST to `/api/account/security/login-check` (same router as #1).
- **Server logic**: hash `req.ip` + `req.headers['user-agent']` (never trust a client-reported fingerprint for this). Upsert against `KnownLoginDevice` on `(userId, fingerprintHash)`: if the row is new → send the alert email + insert; if it exists → just bump `lastSeenAt`, no email.
- **New service**: `apps/api/src/services/newDeviceLoginEmail.ts` — `sendNewDeviceLoginEmail({to, name, approxLocation?})`. IP→location is out of scope for v1 (no geo-IP service wired in) — copy says "a new device" without claiming a location, to avoid stating something we can't verify.
- **Copy**: "New sign-in to your Avise account from a device we haven't seen before. If this was you, no action needed. If not, reset your password immediately." No unsubscribe — security alerts are never optional.

## 3. NDA signature-completed confirmation

**No migration needed.** Cheapest build — detection infra already exists and is a one-shot event (only fires once per document, since the poller only re-checks rows still in `SENT` status).

- **Trigger**: inside `apps/api/src/services/legalDocSignaturePollService.ts`, in the existing `if (state.signed) { ... }` branch (~line 132) where the row transitions `SENT` → `SIGNED` — add the email call right alongside the existing status/`,signedAt` update.
- **Recipient**: whoever sent the document — read the `LegalDocument` row's sender field (confirm exact column name at implementation time — likely `sentBy`/`createdBy`; fall back to the deal's `assignedTo` if absent).
- **New service**: `apps/api/src/services/signatureCompletedEmail.ts` — `sendSignatureCompletedEmail({to, name, dealName, documentName, signedAt})`.
- **Copy**: "The NDA for {dealName} was just signed." No button — the NDA page itself is where they'd go look, and we don't want to encourage clicking links in an email about a legal document.

## 4. Deal stage-changed notification

**No migration needed.** Scope note: this is **only** "email the owner when a deal's stage changes" — NOT a generic "stale deal" nudge. Real inactivity-based staleness detection doesn't exist anywhere in this codebase (`cron-reactivation.ts` is a different thing — a PASSED-deal rescoring sweep, not a staleness detector) and would be its own separate feature with its own criteria design; scoping it into this batch would be guessing at requirements that need their own brainstorm.

- **Trigger**: `apps/api/src/routes/deals-mutate.ts`, in the existing stage-change branch (~line 222, `if (data.stage && data.stage !== existingDeal.stage)`) — alongside the existing in-app `notifyDealTeam(deal.id, 'DEAL_UPDATE', ...)` call (~line 234-243), add an email to `assignedUser.email` (already joined into the query per the existing `assignedUser:User!assignedTo(id, name, avatar, email)` select).
- **New service**: `apps/api/src/services/dealStageChangedEmail.ts` — `sendDealStageChangedEmail({to, name, dealName, oldStage, newStage})`.
- **No email if there's no `assignedTo`** on the deal (silent no-op, same as every other null-safe sender in this codebase).

## 5. Weekly team activity digest

**No migration needed** — `AuditLog` already has everything required (`organizationId`, `userId`/`userEmail`, `action`, `createdAt`, with an existing `(organizationId, createdAt)` index).

- **New cron**: `apps/api/src/routes/cron-weekly-digest.ts`, `vercel.json` entry `{"path": "/api/cron/weekly-digest", "schedule": "0 8 * * 1"}` (Monday 8am UTC), `CRON_SECRET`-guarded like the other crons.
- **Logic**: per org, query `AuditLog` for the past 7 days, group by `action` for a simple count-per-category summary (deals created, documents uploaded, memos generated, etc.). Recipients: users with `role = 'ADMIN'` in that org (existing role enum, see `invitations.ts`).
- **New service**: `apps/api/src/services/weeklyDigestEmail.ts` — `sendWeeklyDigestEmail({to, name, orgName, counts, weekOf})`.
- **Skip orgs with zero activity** in the window — an empty digest is worse than no digest.

## 6. Document-viewed notification (first view only)

**No migration needed** — `DealShareView` rows are already inserted on every portal open (`apps/api/src/routes/portal.ts:62-68`); today it's pure silent tracking.

- **Trigger**: same insert point in `portal.ts`. To avoid spamming the owner on every repeat view, only send when this is the **first** `DealShareView` row for that `shareId` (check count before insert, or check-then-insert) — i.e. "your shared deal was just opened for the first time," not a running notification per view.
- **Recipient**: the `DealShare.createdBy` user (the person who created the share).
- **New service**: `apps/api/src/services/documentViewedEmail.ts` — `sendDocumentViewedEmail({to, name, dealName, shareLabel})`.
- Future extension (not in this pass): per-view digest or real-time for every view — noted as a possible v2, not built now, since "DocSend-style live tracking" is explicitly flagged as often a paid-tier feature even at mature vendors.

## 7. Share-link expiring warning

**⚠️ Migration needed** — one new column to make the cron idempotent (without it, every daily run would re-warn the same share).

- **Migration** (`apps/api/deal-share-expiry-warning-migration.sql`):
  ```sql
  ALTER TABLE "DealShare" ADD COLUMN "expiryWarningSentAt" timestamptz;
  ```
- **New cron**: `apps/api/src/routes/cron-share-expiry-warnings.ts`, `vercel.json` entry `{"path": "/api/cron/share-expiry-warnings", "schedule": "0 9 * * *"}` (daily 9am UTC). Finds `DealShare` rows where `expiresAt` is within the next 48 hours, `revokedAt IS NULL`, and `expiryWarningSentAt IS NULL`; sends the warning, then sets `expiryWarningSentAt = now()` so it never re-fires for that share.
- **Recipient**: `DealShare.createdBy`.
- **New service**: `apps/api/src/services/shareExpiryWarningEmail.ts` — `sendShareExpiryWarningEmail({to, name, dealName, shareLabel, expiresAt})`.

## 8. @mention email

**No migration needed** — the in-app mention system is fully built (`apps/api/src/routes/activities.ts`, `createNotification({type: 'MENTION', ...})`); it just never emails.

- **Trigger**: same resolved-mentions loop in `activities.ts` (~lines 112-156) where `mentionedEmails` are turned into org-scoped `User` rows and `createNotification` is called — add the email call right alongside it, same recipients.
- **New service**: `apps/api/src/services/mentionEmail.ts` — `sendMentionEmail({to, name, mentionedByName, dealName, noteExcerpt})`.
- Truncate `noteExcerpt` to ~150 chars (escaped) — full note stays in-app only.

## 9. Re-engagement / inactivity nudge

**No migration needed** — derives "last active" from `MAX(AuditLog.createdAt)` per user rather than adding a new tracked column (avoids new infra; `AuditLog` already logs `LOGIN` and other actions per user).

- **New cron**: `apps/api/src/routes/cron-reengagement-nudge.ts`, `vercel.json` entry `{"path": "/api/cron/reengagement-nudge", "schedule": "0 10 * * 1"}` (weekly, Monday 10am UTC).
- **Logic**: per org, find users whose most recent `AuditLog` row is older than 14 days (and who have at least one `AuditLog` row at all — a user with zero activity ever is a fresh/never-onboarded account, a different problem than re-engagement, so excluded here).
- **New service**: `apps/api/src/services/reengagementEmail.ts` — `sendReengagementEmail({to, name})`.
- **Copy**: light, no guilt-trip — "Haven't seen you in a while — your deals are still here" style, one line, no CTA button (matches the welcome email's "no button" decision from the earlier spec).
- **Dedup guard**: since this runs weekly and the 14-day threshold moves slowly, the SAME inactive user could get emailed multiple weeks in a row. Accepted for v1 (simplest correct behavior — genuinely-inactive users repeatedly nudged is the intended behavior of a re-engagement email, not a bug); revisit only if it proves annoying in practice.

---

## Build order (dependency-aware, for the Workflow pass)

No cross-dependencies between any of the 9 — each touches a different file/insertion-point. They can build fully in parallel except:
- **#1 and #2 share one new route file** (`account-security.ts`) — sequence these two together, not fully parallel, to avoid two agents editing the same new file.
- **#2 and #7 each need their own migration file** — write both migrations as part of their respective feature's build, not shared.

## Out of scope for this pass

- Actual "stale deal" (generic inactivity) nudges — needs its own criteria design, separate future brainstorm.
- Geo-IP lookup for the new-device alert (no location claimed in v1 copy).
- Per-view (not just first-view) document tracking.
- Any billing/dunning email — no payment infrastructure exists in this codebase to hook into.
