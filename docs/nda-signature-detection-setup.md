# NDA Signature Auto-Detection — Operator Setup

How the app auto-detects that a counterparty has signed an NDA, and what you
need to configure for it to work in production.

---

## Current mode: on-demand polling (active)

This is the mechanism that runs **today**, including on `*.vercel.app` preview
and production deployments. No webhook, no cron, no migration.

How it works:

- The frontend calls `POST /api/legal-documents/check-signatures` whenever the
  NDA page is opened or the browser tab regains focus / becomes visible
  (`apps/web-next/src/app/(app)/nda/page.tsx`).
- The backend (`legalDocSignaturePollService.pollOrgSignatures`) walks every
  **SENT-but-unsigned** NDA in the caller's org. For each, it reads the Google
  Doc's metadata using the **sender's** Workspace token and applies the
  `contentRestrictions[].readOnly` lock heuristic (see "The readOnly heuristic"
  below). Newly-locked docs are flipped to `status: 'SIGNED'`.
- On detection the backend stamps:
  - `metadata.signatureDetectedVia === 'drive-poll'`
  - `metadata.signatureDetectedAt` — ISO timestamp
- The gallery UI shows a **"Signed · auto-detected"** badge on those documents
  (it fires for either `drive-poll` or the dormant `drive-watch` provenance) and
  refetches when the check completes.

Because it works against `*.vercel.app`, there is **nothing to configure** for
polling — it is on by default.

> **Detection is near-real-time, not instant.** A signature surfaces the next
> time the NDA page is opened or the tab regains focus — not the instant the
> counterparty signs. For instant detection you need push (below), which is an
> optional enhancement for the verified production domain.

---

## Enabling push in production (DO BEFORE PROD)

Push (Drive `files.watch`) gives **instant** detection instead of waiting for an
NDA-page open / tab focus. It is **commented out** today because
`*.vercel.app` callbacks can't be GCP-domain-verified. Re-enable it on the
verified custom domain.

### 1. What is commented out, and where

Re-enable by **uncommenting** in these two files:

- **`apps/api/src/app-lite.ts`** — the `legalDocWebhooksRouter` import and the
  `app.use('/api/webhooks/legal-docs', ...)` mount.
- **`apps/api/src/services/legalDocSendService.ts`** — the `registerSignatureWatch`
  import and the best-effort call that registers a watch when an NDA is sent.

### 2. Prerequisites

All of the following must be in place before push will work:

- A **custom HTTPS domain** (not `*.vercel.app`).
- **GCP / Google Search Console domain verification** of that domain — verify it
  as a property in Search Console **and** add it under **GCP → APIs & Services →
  Domain verification** in the project that owns the Drive API credentials. Both
  must show verified (see "One-time GCP setup" below for the step-by-step).
- **`APP_URL`** set to the `https://` **custom domain** (NOT `*.vercel.app`) —
  this builds the webhook callback URL.
- **`CRON_SECRET`** set.
- A **daily cron** POSTing to `/api/webhooks/legal-docs/_cron/renew-watches`
  with `Authorization: Bearer $CRON_SECRET` (or `x-cron-secret: $CRON_SECRET`)
  to renew watch channels before they expire.

### 3. Push is optional

Push is an **optional enhancement for instant detection** — on-demand polling
(above) already works without it, including on Vercel. Treat push as the
production-only upgrade for instant flips, not a requirement to ship.

---

## Why this exists

Google offers **no eSignature status API**. When a Google Doc eSignature
completes, Google locks the document by adding a **content restriction**
(`readOnly`) to the file. We use that lock as a proxy for "signed". Both
mechanisms read the same lock:

- **Polling (active):** reads each unsigned NDA's file metadata on demand.
- **Push (dormant):** a Drive
  [`files.watch`](https://developers.google.com/drive/api/guides/push) channel
  notifies our webhook when the Doc changes, and the handler inspects the file's
  metadata for the lock.

This is a **probable, not-yet-confirmed** signal — a Doc can be locked for other
reasons, and Google's behavior may change. To let us validate and tune the
heuristic, the backend **logs the raw Drive file metadata** when it inspects a
file. Treat auto-detected signatures as a strong hint, not legal proof.

---

## The readOnly heuristic

On a genuinely completed signature, Google sets `contentRestrictions[].readOnly`
to `true` on the file. Both the poll service and the (dormant) webhook treat that
flip as "signed".

Because the lock signal is probabilistic, validate it against real signatures
before trusting it broadly:

1. **Find the raw-metadata log line** the backend emits when it inspects a file
   (search your logs for the per-file Drive metadata entry).
2. **Confirm the lock flips** — on a genuinely completed signature, check that
   `contentRestrictions[].readOnly` becomes `true` in that metadata.
3. **Adjust detection if Google's actual behavior differs** — if you see the
   lock appear without a real signature (or a real signature without the lock),
   tune the detection logic against the logged metadata rather than assuming the
   `readOnly` flip is exact.

---

## Push reference (for when push is enabled)

The sections below apply **only after** push has been re-enabled per "Enabling
push in production". They are not needed for the active polling path.

### One-time GCP setup

Drive `files.watch` **rejects unverified callback addresses**. The domain of the
webhook callback URL (your `APP_URL`) must be verified before any watch channel
will be accepted:

1. **Verify the domain in Google Search Console** — add and verify the
   `APP_URL` domain (e.g. `lmmos.ai`) as a property.
2. **Add it as a verified domain in the GCP project** — in the same GCP project
   that owns the Drive API credentials, go to **APIs & Services → Domain
   verification** and add the domain. It must show as verified there too.

Without both, Drive returns an error when we try to register the watch and push
auto-detection silently never starts. (Polling is unaffected — it needs no
domain verification.)

### Environment variables (push only)

| Variable | Required for push | Notes |
| --- | --- | --- |
| `APP_URL` | yes | Must be `https://` and the **verified custom domain** (e.g. `https://lmmos.ai`). Used to build the webhook callback URL. |
| `CRON_SECRET` | yes | Shared secret for the channel-renewal cron (below). |

> **`*.vercel.app` cannot be domain-verified.** Google will not accept a
> preview/`vercel.app` callback address, so **push auto-detection only runs on
> the production custom domain**. Preview deployments will not register watch
> channels — this is expected, and polling covers them.

### Channel renewal cron

Drive watch channels **expire** (max ~7 days). A scheduled job must renew them
before they lapse, or push detection quietly stops.

- **Endpoint:** `POST ${APP_URL}/api/webhooks/legal-docs/_cron/renew-watches`
- **Auth header:** `x-cron-secret: $CRON_SECRET`
  (a `Authorization: Bearer $CRON_SECRET` header also works)
- **Recommended schedule:** **daily** — comfortably inside the ~7-day window so a
  single missed run doesn't drop coverage.

Example:

```bash
curl -X POST "$APP_URL/api/webhooks/legal-docs/_cron/renew-watches" \
  -H "x-cron-secret: $CRON_SECRET"
```

### The webhook endpoint

- **Endpoint:** `POST /api/webhooks/legal-docs/drive`
- **Public — no auth header.** Google sends no Authorization header on push
  notifications, so this route cannot require one.

Security model:

- Each watch uses a **random per-document channel token**, and the handler
  verifies the incoming **`resourceId`** matches the document it expects — so a
  spoofed notification can't flip an arbitrary doc.
- The handler **always returns `200`**, even on validation failure, so Google
  won't retry-storm the endpoint.
- The handler **logs the raw Drive file metadata** on every notification for
  heuristic tuning (see "The readOnly heuristic" above).
