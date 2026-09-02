# Signup Welcome Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a warm "Welcome to Avise" email via Resend the moment a new account is created, regardless of whether Supabase returns a session immediately (email-confirmation-required signups have none yet).

**Architecture:** A new unauthenticated route (`POST /api/public/welcome-email`) accepts only a Supabase user id, looks the user up server-side via the Supabase admin client (never trusting client-supplied email/name), and only sends for accounts created in the last 15 minutes. A small `welcomeEmail.ts` service does the actual Resend call, following the exact null-safe pattern already used by `docRequestEmail.ts` and `routes/invitations.ts`. The signup page fires this via the existing `api.post` helper right after `supabase.auth.signUp()` resolves.

**Tech Stack:** Express + TypeScript (`apps/api`), Resend SDK, Vitest + Supertest for tests, Next.js 16 client component (`apps/web-next`).

Spec: [`docs/superpowers/specs/2026-08-25-signup-welcome-email-design.md`](../specs/2026-08-25-signup-welcome-email-design.md)

---

## Task 1: Welcome email service

**Files:**
- Create: `apps/api/src/services/welcomeEmail.ts`
- Test: `apps/api/tests/welcomeEmail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/welcomeEmail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resendSend = vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: resendSend },
  })),
}));

describe('sendWelcomeEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns false and skips Resend when RESEND_API_KEY is not set', async () => {
    const { sendWelcomeEmail } = await import('../src/services/welcomeEmail.js');
    const result = await sendWelcomeEmail({ to: 'new@user.com', name: 'Jamie' });
    expect(result).toBe(false);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the configured from-address and subject when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'welcome@avise.io';
    const { sendWelcomeEmail } = await import('../src/services/welcomeEmail.js');
    const result = await sendWelcomeEmail({ to: 'new@user.com', name: '<Jamie>' });

    expect(result).toBe(true);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Avise <welcome@avise.io>',
        to: 'new@user.com',
        subject: 'Welcome to Avise',
      }),
    );
  });

  it('HTML-escapes the name and uses only the first name in the greeting', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendWelcomeEmail } = await import('../src/services/welcomeEmail.js');
    await sendWelcomeEmail({ to: 'new@user.com', name: '<Jamie> Smith' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi &lt;Jamie&gt;,');
  });

  it('falls back to "there" when name is empty', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendWelcomeEmail } = await import('../src/services/welcomeEmail.js');
    await sendWelcomeEmail({ to: 'new@user.com', name: '' });

    const htmlArg = resendSend.mock.calls[0][0].html;
    expect(htmlArg).toContain('Hi there,');
  });

  it('returns false when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    resendSend.mockResolvedValueOnce({ data: null, error: { message: 'bad request' } });
    const { sendWelcomeEmail } = await import('../src/services/welcomeEmail.js');
    const result = await sendWelcomeEmail({ to: 'new@user.com', name: 'Jamie' });

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run tests/welcomeEmail.test.ts`
Expected: FAIL — `Cannot find module '../src/services/welcomeEmail.js'` (or similar resolution error), since the file doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/welcomeEmail.ts`:

```typescript
// ─── Signup welcome email ──────────────────────────────────────────
// Sent once, right after a new account is created (see
// routes/welcome-email.ts for the guarded caller). Null-safe on
// RESEND_API_KEY exactly like docRequestEmail.ts and routes/invitations.ts:
// a missing key logs and returns false, it never throws into the caller.

import { Resend } from 'resend';
import { log } from '../utils/logger.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export interface WelcomeEmailInput {
  to: string;
  name?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send the "Welcome to Avise" email. Returns true when the mail was handed
 * to Resend, false when email isn't configured or the send failed — the
 * caller (routes/welcome-email.ts) treats either as a silent no-op.
 */
export async function sendWelcomeEmail(input: WelcomeEmailInput): Promise<boolean> {
  if (!resend) {
    log.warn('Resend not configured — welcome email skipped', { to: input.to });
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const trimmedName = input.name?.trim();
  const firstName = trimmedName ? escapeHtml(trimmedName.split(' ')[0]) : 'there';

  try {
    const { error } = await resend.emails.send({
      from: `Avise <${fromEmail}>`,
      to: input.to,
      subject: 'Welcome to Avise',
      html: `
        <div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <p>Hi ${firstName},</p>
          <p>Welcome to Avise &mdash; glad to have you on board.</p>
          <p>You've now got one place for deal screening, diligence, and portfolio work &mdash; pre-loaded context, no blank-page prompts. Jump back in whenever you're ready.</p>
          <p style="margin-top:24px;">&mdash; The Avise Team</p>
        </div>
      `,
    });

    if (error) {
      log.error('Welcome email failed', { error });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Welcome email threw', { err });
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run tests/welcomeEmail.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/welcomeEmail.ts apps/api/tests/welcomeEmail.test.ts
git commit -m "feat(email): add sendWelcomeEmail service"
```

---

## Task 2: Welcome email route

**Files:**
- Create: `apps/api/src/routes/welcome-email.ts`
- Test: `apps/api/tests/welcome-email-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/welcome-email-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetUserById = vi.fn();
const mockSupabase = {
  auth: { admin: { getUserById: mockGetUserById } },
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendWelcomeEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/welcomeEmail.js', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

const buildApp = async () => {
  const { default: welcomeEmailRouter } = await import('../src/routes/welcome-email.js');
  const app = express();
  app.use(express.json());
  app.use('/api/public/welcome-email', welcomeEmailRouter);
  return app;
};

describe('POST /api/public/welcome-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends using the server-looked-up email and name, ignoring any client-supplied ones', async () => {
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'real@user.com',
          created_at: new Date().toISOString(),
          user_metadata: { full_name: 'Real Name' },
        },
      },
      error: null,
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/welcome-email')
      .send({ userId: 'user-1', email: 'spoofed@evil.com', name: 'Spoofed' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(mockSendWelcomeEmail).toHaveBeenCalledWith({ to: 'real@user.com', name: 'Real Name' });
  });

  it('no-ops without calling sendWelcomeEmail when the account is older than 15 minutes', async () => {
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'real@user.com',
          created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          user_metadata: {},
        },
      },
      error: null,
    });

    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({ userId: 'user-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('no-ops when the user lookup fails', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: 'not found' } });

    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({ userId: 'nope' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('no-ops when userId is missing from the request body', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run tests/welcome-email-route.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/welcome-email.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/welcome-email.ts`:

```typescript
// ─── Signup welcome email trigger ──────────────────────────────────
// Mounted at /api/public/welcome-email WITHOUT auth middleware — this
// fires immediately after supabase.auth.signUp() resolves client-side,
// before a session necessarily exists (email-confirmation-required
// signups have none yet). Never trusts a client-supplied email/name:
// looks the user up server-side by id and only sends for accounts
// created in the last 15 minutes, so the endpoint can't be replayed
// into a generic "email anyone repeatedly" vector even though ids are
// unguessable UUIDs.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendWelcomeEmail } from '../services/welcomeEmail.js';

const router = Router();

const MAX_ACCOUNT_AGE_MS = 15 * 60 * 1000;

router.post('/', async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  if (!userId) {
    return res.json({ sent: false });
  }

  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    log.warn('Welcome email: user lookup failed', { userId, error });
    return res.json({ sent: false });
  }

  const user = data.user;
  const createdAt = user.created_at ? new Date(user.created_at).getTime() : 0;
  if (!createdAt || Date.now() - createdAt > MAX_ACCOUNT_AGE_MS) {
    return res.json({ sent: false });
  }

  if (!user.email) {
    return res.json({ sent: false });
  }

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null;
  const sent = await sendWelcomeEmail({ to: user.email, name: fullName });
  res.json({ sent });
});

export default router;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run tests/welcome-email-route.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/welcome-email.ts apps/api/tests/welcome-email-route.test.ts
git commit -m "feat(email): add POST /api/public/welcome-email route"
```

---

## Task 3: Mount the route in both serverless bundles

**Files:**
- Modify: `apps/api/src/app.ts:71` (import) and `apps/api/src/app.ts:335` (mount)
- Modify: `apps/api/src/app-lite.ts:63` (import) and `apps/api/src/app-lite.ts:261` (mount)

- [ ] **Step 1: Add the import and mount to `app.ts`**

In `apps/api/src/app.ts`, after the existing line:

```typescript
import dealsReactivationsRouter from './routes/deals-reactivations.js';
```

add:

```typescript
import welcomeEmailRouter from './routes/welcome-email.js';
```

Then, after the existing block:

```typescript
// Document-request upload page must be public — brokers/sellers have no
// accounts; the DocRequest token is the credential (see routes/doc-request-portal.ts).
app.use('/api/public/doc-requests', docRequestPortalRouter);
```

add:

```typescript
// Signup welcome email must be public — it fires right after signUp()
// resolves, before a session necessarily exists (see routes/welcome-email.ts).
app.use('/api/public/welcome-email', welcomeEmailRouter);
```

- [ ] **Step 2: Add the same import and mount to `app-lite.ts`**

In `apps/api/src/app-lite.ts`, after the existing line:

```typescript
import dealsReactivationsRouter from './routes/deals-reactivations.js';
```

add:

```typescript
import welcomeEmailRouter from './routes/welcome-email.js';
```

Then, after the existing block:

```typescript
// Document-request upload page must be public — brokers/sellers have no
// accounts; the DocRequest token is the credential (see routes/doc-request-portal.ts).
app.use('/api/public/doc-requests', docRequestPortalRouter);
```

add:

```typescript
// Signup welcome email must be public — it fires right after signUp()
// resolves, before a session necessarily exists (see routes/welcome-email.ts).
app.use('/api/public/welcome-email', welcomeEmailRouter);
```

Do **not** add anything to `app-ai.ts` or `apps/web-next/src/lib/api-routing.ts` — this route touches no LLM/agent code, so `pickBundle`'s default (lite) is correct.

- [ ] **Step 3: Verify bundle parity**

Run: `cd apps/api && npx vitest run tests/bundle-route-parity.test.ts`
Expected: PASS — `welcome-email` now appears in both `app.ts` and `app-lite.ts`, satisfying the parity check.

- [ ] **Step 4: Run the full API test suite to catch regressions**

Run: `cd apps/api && npx vitest run`
Expected: PASS (all suites, including the two new files from Tasks 1–2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/app-lite.ts
git commit -m "feat(email): mount welcome-email route in dev + lite bundles"
```

---

## Task 4: Configure the from-address

**Files:**
- Modify: `apps/api/.env`

- [ ] **Step 1: Add `RESEND_FROM_EMAIL` to local env**

In `apps/api/.env`, directly below the existing `RESEND_API_KEY` line, add:

```
RESEND_FROM_EMAIL=welcome@avise.io
```

This is a shared env var already read by `docRequestEmail.ts` and `routes/invitations.ts` — setting it here changes the from-name for those senders too (from the current unset fallback of `onboarding@resend.dev` to `Avise <welcome@avise.io>`), which is the intended, better identity for all of them.

- [ ] **Step 2: No commit needed**

`apps/api/.env` is gitignored — this step only affects local dev/testing, not the repo. Note for the user: **this must also be added to Vercel's production environment variables** (`RESEND_API_KEY` and `RESEND_FROM_EMAIL=welcome@avise.io`) — no automated tooling has access to do this from this session.

---

## Task 5: Wire the signup page

**Files:**
- Modify: `apps/web-next/src/app/(auth)/signup/page.tsx:89-95`

- [ ] **Step 1: Add the import**

At the top of `apps/web-next/src/app/(auth)/signup/page.tsx`, alongside the existing imports:

```typescript
import { api } from "@/lib/api";
```

- [ ] **Step 2: Fire the welcome-email call after signUp succeeds**

Replace:

```typescript
    if (data.session) {
      setSuccess("Account created! Redirecting to setup...");
      setTimeout(() => router.push("/onboarding"), 1200);
    } else {
      setSuccess("Check your email to verify your account, then log in.");
      setLoading(true); // keep button disabled
    }
  };
```

with:

```typescript
    if (data.user) {
      // Best-effort, non-blocking — never delays or fails the signup flow.
      // Fires here (not from an authenticated onboarding endpoint) because
      // email-confirmation-required signups have no session yet at this point.
      api.post("/public/welcome-email", { userId: data.user.id }).catch((err) => {
        console.warn("[signup] welcome email trigger failed:", err);
      });
    }

    if (data.session) {
      setSuccess("Account created! Redirecting to setup...");
      setTimeout(() => router.push("/onboarding"), 1200);
    } else {
      setSuccess("Check your email to verify your account, then log in.");
      setLoading(true); // keep button disabled
    }
  };
```

(Per `apps/web-next/CLAUDE.md`: all API calls go through `api.ts`, and every `catch` must have explicit handling — here, a `console.warn` with context, since there's no user-facing error state for a best-effort background call.)

- [ ] **Step 3: Type-check**

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: PASS, no new errors.

- [ ] **Step 4: Commit**

```bash
git add "apps/web-next/src/app/(auth)/signup/page.tsx"
git commit -m "feat(email): trigger welcome email from signup page"
```

---

## Task 6: Manual verification

- [ ] **Step 1: Start the API locally**

Run: `cd apps/api && npm run dev` (or the repo's standard local-dev command)

- [ ] **Step 2: Confirm the endpoint is reachable and no-ops for a bogus id**

Run:

```bash
curl -s -X POST http://localhost:3001/api/public/welcome-email \
  -H "Content-Type: application/json" \
  -d '{"userId":"00000000-0000-0000-0000-000000000000"}'
```

Expected: `{"sent":false}` (lookup fails for a nonexistent user).

- [ ] **Step 3: Sign up a real test account through the web-next UI**

Run: `npm run dev:web-next` (or the repo's standard command), open the signup page, create an account with a real inbox you control.

Expected: the "Welcome to Avise" email arrives (check spam folder too, since this is a brand-new sending domain — deliverability reputation is still warming up).

- [ ] **Step 4: Confirm production env vars**

Remind the user (this step is a manual action, not something to automate): add `RESEND_API_KEY` and `RESEND_FROM_EMAIL=welcome@avise.io` to the Vercel project's production environment variables, then redeploy — otherwise this feature silently no-ops in prod (logs a warning, never errors).
