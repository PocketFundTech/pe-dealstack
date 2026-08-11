# Client Portal / Deal Sharing — Design Spec

## Problem

Owners can't share a deal with anyone outside their org. Trevor (demo call M3) called a client-facing portal "the highest-priority feature from all calls combined" — push a deal to a client, they see it in their own view, you track who looked and when. Pascal's action plan (Tier 1, item 1) asks for the same thing as "deal-level external sharing." Today the workaround is screen-sharing.

## Goals

- "Share deal" from the deal page → revocable tokenized link → external person opens a clean, read-only, no-login portal page showing that one deal.
- Owner controls which sections are shared (financials / documents / memos; overview always).
- View tracking: the owner sees view counts + last-viewed per share.
- Document downloads via short-lived signed URLs only — never unauthenticated raw storage access.
- Portal is PE OS-branded ("Shared by {org} via PE OS") — the built-in referral loop both sources called out.

## Non-Goals (v1 — all are clean later upgrades, not redesigns)

- No email-verification gate on opening a link (the token is the secret — DocSend-style trust model; revoke + expiry are the controls).
- No external accounts / EXTERNAL_VIEWER role, no commenting or reactions.
- No per-document selection (section-level toggles only).
- No share-analytics page beyond per-share view count + last viewed.

## Design

### Data model — one manual migration (`apps/api/deal-share-migration.sql`)

```sql
CREATE TABLE "DealShare" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" uuid NOT NULL REFERENCES "Deal"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  token text NOT NULL UNIQUE,          -- 32-byte crypto-random hex
  label text,                          -- e.g. "Healthcare partner"
  "invitedEmail" text,                 -- informational + used for send-email
  "includeFinancials" boolean NOT NULL DEFAULT true,
  "includeDocuments" boolean NOT NULL DEFAULT true,
  "includeMemos" boolean NOT NULL DEFAULT true,
  "createdBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,             -- null = no expiry
  "revokedAt" timestamptz
);
CREATE INDEX ON "DealShare"("dealId");
CREATE TABLE "DealShareView" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shareId" uuid NOT NULL REFERENCES "DealShare"(id) ON DELETE CASCADE,
  "viewedAt" timestamptz NOT NULL DEFAULT now(),
  "userAgent" text
);
CREATE INDEX ON "DealShareView"("shareId");
```

Manual Supabase step per repo convention (Vercel doesn't run SQL). Endpoints 500 with a clear message until applied.

### Owner-side API — `routes/deals-share.ts` (authenticated, org-scoped, mounted under `/api/deals`)

- `POST /:dealId/shares` — body: `{label?, invitedEmail?, includeFinancials?, includeDocuments?, includeMemos?, expiresInDays?}`. Verifies deal access, generates token via `crypto.randomBytes(32).toString('hex')`, inserts, returns share + full portal URL (`{APP_URL}/portal/{token}`). If `invitedEmail` present, sends the link via Resend (same pattern as `sendInvitationEmail`; silent no-op if Resend unconfigured). Activity-logged on the deal.
- `GET /:dealId/shares` — list this deal's shares with `viewCount` + `lastViewedAt` (aggregated from `DealShareView`).
- `DELETE /:dealId/shares/:shareId` — sets `revokedAt` (soft revoke; row and its view history are kept).

### Public portal API — `routes/portal.ts` (mounted unauthenticated at `/api/public/portal`, same placement as `/api/public/invitations`)

- `GET /:token` — look up share; 404 unknown token, 410 revoked/expired (mirrors invitation-token semantics). Records a `DealShareView` row (fire-and-forget). Returns:
  - `share`: label, sharedBy org name, section flags
  - `deal`: name, companyName, industry, stage, description, dealSize, revenue, ebitda, currency (metadata only — no team, no internal notes, no scorecard)
  - `financials` (if enabled): active `FinancialStatement` rows (statementType, period, lineItems)
  - `documents` (if enabled): id, name, type, fileSize (no URLs)
  - `memos` (if enabled): per memo — title + its sections' (title, content), content sanitized client-side before render
- `GET /:token/documents/:documentId/download` — re-validates the token, confirms the document belongs to the shared deal AND documents are enabled on this share, then 302-redirects to a short-lived signed URL from the existing `getSignedDownloadUrl()`.

Both endpoints sit behind the existing general rate limiter; no auth middleware.

### Portal page — `apps/web-next/src/app/portal/[token]/page.tsx` (public, outside `(app)`)

Banker-styled read-only page: header ("{Deal name} — shared by {org} via PE OS", PE OS footer link), overview card, financials table (reusing `formatters.ts`), documents list with download buttons (hitting the download endpoint), memos rendered via the existing sanitised-markdown/HTML helpers. Dedicated friendly screens for 404 (unknown link) and 410 (revoked/expired). No sidebar/header chrome.

The public middleware must let `/portal/*` through unauthenticated — verify `middleware.ts`'s matcher and add the path if the default would redirect to login.

### Share UI — deal page

"Share deal" item in the existing `DealActionsMenu` (deal-panels.tsx) → new `ShareDealModal` (in `components/deal-actions/`, beside `DraftEmailModal`): create form (label, optional email, three section toggles, expiry preset: 7/30/90 days/never), created-link copy row, and the list of existing shares (label/email, created, views, last viewed, revoke). Uses `api.get/post/delete`.

## Testing

TDD. Backend: share CRUD round-trip + org-scoping (cross-org 404), token generation uniqueness/length, revoke semantics, portal token validation (valid/unknown/revoked/expired), section-flag filtering of the payload, view recording, download endpoint's deal-membership + flag gating. Frontend: ShareDealModal handler behavior (create → link shown; revoke updates list), portal page render states (loaded/404/410) at component level.

## Sequencing

1. Migration + owner-side share API + tests.
2. Public portal API + tests.
3. Portal page + middleware allowance + tests.
4. ShareDealModal + DealActionsMenu wiring + tests.
5. Manual verification writeup (standing no-credentials caveat).

Branch `feat/deal-sharing` off `origin/main` — no AI dependency; merges independently of the AI-rebuild stack. No feature flag (additive); rollback is revert. Deploy coupling: the manual migration.
