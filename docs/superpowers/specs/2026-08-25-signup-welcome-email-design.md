# Signup Welcome Email — Design Spec

## Problem

New users who sign up get no acknowledgement email from the product — the only mail they may see is Supabase's own confirmation email (if email-confirmation is enabled on the project). We now have `avise.io` verified in Resend (DKIM/SPF/DMARC), and Resend is already wired into the codebase (`docRequestEmail.ts`, `routes/invitations.ts`) with a proven null-safe pattern. This closes the gap: send a warm, on-brand welcome email the moment an account is created.

## Goals

- Every new signup (`apps/web-next/src/app/(auth)/signup/page.tsx`) receives a "Welcome to Avise" email, sent from Avise's own infrastructure (Resend), immediately after `supabase.auth.signUp()` resolves — regardless of whether Supabase returns a session (email-confirmation-required signups have no session yet).
- Plain, warm copy. No CTA button (user already lands in-app or sees a "check your email" message).

## Non-Goals (v1)

- No other transactional email types (password reset, digest, etc.) — those are separate projects if/when needed.
- No welcome email for invited teammates joining an existing org (they already get an invitation email via `routes/invitations.ts`).
- No retry/queue infrastructure — a single fire-and-forget send, matching the existing Resend call sites' reliability bar.

## Design

### Why not the existing `/api/onboarding` router

`apps/api/src/routes/onboarding.ts` is mounted with `authMiddleware` + `orgMiddleware` in both `app.ts` and `app-ai.ts`. That's fine for its existing endpoints (status, welcome-shown, etc.) because by the time the client calls them, the user is logged in with a session. But we want to fire the welcome email **immediately** after `signUp()` resolves — including the branch where Supabase requires email confirmation and returns no session at all. An authenticated route can't be called at that moment. So this needs its own unauthenticated endpoint, independently guarded.

### New endpoint — `apps/api/src/routes/auth-welcome-email.ts`

`POST /api/auth/welcome-email` — no `authMiddleware`. Body: `{ userId: string }` (the Supabase Auth user id returned in `data.user.id` from `signUp()`).

Guardrails (never trust client-supplied email/name directly):
1. Look up the user via the service-role Supabase client: `supabase.auth.admin.getUserById(userId)`.
2. If not found, respond 200 `{ sent: false }` (no error surface to the client — this is fire-and-forget).
3. Reject (200, no-op) if `user.created_at` is older than 15 minutes. This keeps the endpoint from being usable as a generic "email anyone repeatedly" vector even though user ids are unguessable UUIDs — it can only ever fire once, shortly after real account creation.
4. Extract `email` and `user_metadata.full_name` from the looked-up record (never from the request body).
5. Call `sendWelcomeEmail({ to: email, name: full_name })`.
6. Always respond 200 `{ sent: boolean }` — this endpoint never 4xx/5xxs in a way that could surface an error to the signup UI.

Rate limiting: sits behind the existing general/auth rate limiter used elsewhere in `app-lite.ts`, same as other public-ish endpoints.

Bundle placement (per the serverless bundle-parity gotcha): this touches no LLM/agent code, so per `pickBundle`'s default it belongs in the **lite** bundle. Mount in `app.ts` (dev) and `app-lite.ts` (prod) only — no `app-ai.ts`, no `pickBundle` entry needed.

Confirmed the Next.js middleware (`apps/web-next/src/middleware.ts`) excludes `api/*` from its matcher entirely (the API verifies its own bearer JWT per-request), so an intentionally-unauthenticated API route is not blocked or redirected there.

### Email content — `apps/api/src/services/welcomeEmail.ts`

Same shape as `docRequestEmail.ts`: null-safe `Resend` client off `RESEND_API_KEY`, returns `boolean`, logs + swallows failures.

- From: `Avise <welcome@avise.io>` (new `RESEND_FROM_EMAIL=welcome@avise.io` — this changes the shared `RESEND_FROM_EMAIL` env var used by other senders too, so from name changes for onboarding/invite mail as well; acceptable since they already read the same var and this is a better identity than the current unset fallback of `onboarding@resend.dev`).
- Subject: `Welcome to Avise`
- Body (plain, no button), Banker Blue theme (`#003366` heading/accent, Inter-esque font stack, `#111827` body text, `#6B7280` muted), matching `docRequestEmail.ts`'s inline-style conventions:

  > Hi {first name, or "there"},
  >
  > Welcome to Avise — glad to have you on board.
  >
  > You've now got one place for deal screening, diligence, and portfolio work — pre-loaded context, no blank-page prompts. Jump back in whenever you're ready.
  >
  > — The Avise Team

  (No "reply to this email" line: Resend's "Enable Receiving" is currently off for `avise.io` per the domain setup, and nothing in this codebase consumes an inbox at `welcome@avise.io` — inviting replies would silently bounce. If/when inbound support mail is wired up, this can be revisited.)

- Name is HTML-escaped exactly like `docRequestEmail.ts`'s `escapeHtml`. Falls back to "there" if `full_name` is empty/whitespace.

### Client change — `signup/page.tsx`

Right after `supabase.auth.signUp()` resolves without an `authError`, fire (don't await-block UI on it):

```ts
if (data.user) {
  fetch('/api/auth/welcome-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: data.user.id }),
  }).catch(() => {}); // best-effort; never blocks signup UX
}
```

Placed before the existing `if (data.session) {...} else {...}` branching, so it fires in both the immediate-session and email-confirmation-required paths.

### Error handling

- Missing `RESEND_API_KEY`: `sendWelcomeEmail` logs a warning and returns `false` — matches every other Resend call site in this codebase.
- Resend API error: caught, logged, returns `false`.
- User lookup failure / stale account: route no-ops with `{ sent: false }`, 200.
- Nothing here can surface an error to the signup form; the email is best-effort by design.

### Testing

Following `apps/api/tests/invitations.test.ts`'s convention:
- `vi.mock('resend', ...)` with a `resendSend` spy, asserting the route calls it with the looked-up (not client-supplied) email/name for a fresh account.
- Mock the Supabase admin client to return `null` (not found) and an old `created_at` (>15 min) — both should no-op without calling `resendSend`.
- Missing `RESEND_API_KEY` — route responds `{ sent: false }` without constructing a `Resend` client.

## Config checklist (manual, outside this codebase)

- `RESEND_API_KEY` — already updated in local `apps/api/.env`; **must also be added to Vercel's production env vars** (founder action, no MCP access to Vercel from this session).
- `RESEND_FROM_EMAIL=welcome@avise.io` — new, needs to be set in both local `.env` and Vercel.

No database migration required.
