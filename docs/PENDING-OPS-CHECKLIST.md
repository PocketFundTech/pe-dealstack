# Pending Ops Checklist — Founder/Ops Actions

> **Purpose:** every manual action (SQL, env var, dashboard click) the founder needs to take **once** to make the security/trust workstream fully effective in production. Updated as each feature ships.
>
> **Rule:** code can ship, deploys can land, but a feature isn't *complete* until its row here is checked.

---

## Carry-overs from earlier shipped PRs

These items still pending from PRs #9 / #30 / #34 / #35.

- [ ] **OPS-1 — `POCKET_FUND_STAFF_EMAILS` env var on Vercel**
  - Where: Vercel Dashboard → Project `pe-dealstack` → Settings → Environment Variables
  - Add: `POCKET_FUND_STAFF_EMAILS` = comma-separated staff emails (e.g., `ganeshjagtap7@gmail.com,dev@pocket-fund.com`)
  - Scope: Production
  - Without it: PR #30 staff access log middleware no-ops cleanly — the feature ships dead-effective.

- [ ] **OPS-2 — Expose Supabase `auth` schema in PostgREST**
  - Where: Supabase Dashboard → Project Settings → API → "Exposed schemas"
  - Add: `auth`
  - Without it: Active sessions UI shows "Session management unavailable", security dashboard's `activeSessions` metric returns null.

- [ ] **OPS-3 — Promote founder to ADMIN role**
  - Where: Supabase Dashboard → SQL Editor
  - Run:
    ```sql
    UPDATE "User" SET role = 'ADMIN' WHERE email = 'ganeshjagtap7@gmail.com';
    SELECT id, email, role, "organizationId" FROM "User" WHERE email = 'ganeshjagtap7@gmail.com';
    ```
  - Without it: security dashboard 403s for founder; admin-only endpoints (audit export, MFA toggle, isolation test) all 403.

---

## New ops items from this batch (Features 5–15)

Filled in as each feature ships. Each row references the PR + feature.

### Database migrations (run in Supabase SQL Editor in this order)

- [ ] **OPS-MIG-1** — _to be filled by an upcoming PR_

### Environment variables (Vercel → Settings → Environment Variables)

- [ ] _to be filled_

### Supabase / external dashboard configuration

- [ ] _to be filled_

---

## How to use this doc

When the dev says **"feature N shipped"**, do not consider that feature complete until:

1. Find its row(s) here under "New ops items"
2. Run the SQL / set the env var / click the dashboard toggle
3. Smoke-test the feature in your browser
4. Tick the checkbox in this file (PR is fine, or just edit on disk)

If a feature has **no rows here**, it's effective the moment it deploys.

---

*Last updated: 2026-05-10 (this PR)*
