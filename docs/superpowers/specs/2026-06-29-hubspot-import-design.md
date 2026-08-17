# HubSpot CRM Import — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan
**Author:** Ganesh + Claude

## Goal

Let a firm onboarding onto the PE OS **bulk-import their existing HubSpot CRM data**
(Companies, Contacts, Deals, and activity history) so they don't have to re-enter it
by hand. Direction is one-way: **HubSpot → PE OS**. Import is **re-runnable** (merge/update,
never duplicate-pollute).

## Scope decisions (locked)

| Decision | Choice |
|---|---|
| Direction | Import FROM HubSpot → PE OS (one-way) |
| Objects | Companies, Contacts, Deals, Activities (notes/calls/emails/meetings/tasks) |
| Auth | Phase 1: Private App access token (paste). Phase 3: OAuth 2.0 "Connect HubSpot". |
| Dedup | Merge/update — match existing, fill blank fields only, never clobber non-empty values |
| Execution | Background job + live progress UI (survives navigation) |
| HubSpot Deals | Imported, but tagged (`hubspotId` + `customFields.source='hubspot'`) so they're filterable/bulk-deletable |
| Field mapping | Deterministic (HubSpot schema is fixed) — **no AI/GPT mapping** |

## Non-goals (v1)

- Two-way / continuous sync (HubSpot ← PE OS). One-way only.
- Live webhooks from HubSpot. This is a pull-on-demand import.
- Importing HubSpot marketing assets (forms, emails, workflows, lists).

## Architecture

New isolated module mirroring the existing `deal-import` pattern.

```
apps/api/src/services/hubspot/
  client.ts        # HubSpot REST wrapper: pagination + rate-limit/429 backoff
  mappers.ts       # HubSpot object -> PE OS row (pure, unit-tested)
  importEngine.ts  # chunked orchestration, cursor/counter persistence, dedup/merge
apps/api/src/routes/hubspot-import.ts
  # POST /api/integrations/hubspot/connect      (store/validate credential)
  # DELETE /api/integrations/hubspot/connect    (disconnect)
  # POST /api/integrations/hubspot/import        (start ImportJob)
  # GET  /api/integrations/hubspot/import/:id    (poll status)
  # POST /api/integrations/hubspot/import/:id/cancel
apps/web-next/src/app/(app)/settings/  # "Integrations" section: connect + import + progress
```

Route mounting follows the existing org-scoped middleware (`orgMiddleware`, `getOrgId(req)`).
All reads/writes scoped to the importing user's `organizationId`.

## Schema changes

One new migration: `apps/api/hubspot-import-migration.sql` (manual-run; Vercel does not
auto-run SQL — see project memory).

### `HubSpotConnection`
- `id` UUID PK
- `organizationId` UUID FK (unique — one connection per org)
- `authType` TEXT CHECK IN ('private_app','oauth')
- `accessToken` TEXT — encrypted via `services/encryption.ts` (AES-256-GCM)
- `refreshToken` TEXT NULL — encrypted (OAuth only)
- `tokenExpiresAt` TIMESTAMPTZ NULL (OAuth only)
- `portalId` TEXT NULL
- `connectedBy` UUID FK → User
- `createdAt` / `updatedAt`

### `ImportJob`
- `id` UUID PK
- `organizationId` UUID FK
- `status` TEXT CHECK IN ('queued','running','completed','failed','cancelled')
- `objectCounts` JSONB — per object type: `{ total, processed, created, updated, skipped, failed }`
- `currentObject` TEXT NULL — which object type is in flight
- `cursor` TEXT NULL — HubSpot pagination cursor for resume
- `error` TEXT NULL
- `startedBy` UUID FK → User
- `startedAt` / `finishedAt` / `createdAt`

### Column additions (Contact, Company, Deal)
- `hubspotId` TEXT NULL — stable external id for idempotent re-import matching (indexed, unique per org)
- `hubspotProperties` JSONB NULL — unmapped/custom HubSpot properties so nothing is lost

## Object mapping

| HubSpot object | PE OS target | Mapping notes |
|---|---|---|
| Company | `Company` | `name`; `industry`→`industry`; `domain`→`website`; `description`→`description`; custom props→`hubspotProperties` |
| Contact | `Contact` | `firstname`/`lastname`; `email`; `phone`; `jobtitle`→`title`; associated company name→`company` (free-text, matches existing schema); custom props→`hubspotProperties` |
| Deal | `Deal` | requires `companyId` — resolve from associated company (create/match); `amount`→`dealSize`; `dealstage`/`pipeline`→`customFields`; `customFields.source='hubspot'`; custom props→`hubspotProperties` |
| Note / Call / Email / Meeting (engagement) | `ContactInteraction` if contact-associated, else `Activity` if deal-associated | engagement type → interaction `type` (NOTE/CALL/EMAIL/MEETING) |
| Task | `ContactInteraction` type `OTHER` (contact-assoc) or `Activity` (deal-assoc) | no exact home; lands as OTHER |

### Dedup / merge (choice B)
1. Match by `hubspotId` (same org) first — guarantees idempotent re-import.
2. Else match by natural key: Contact = `email` (case-insensitive); Company = `website` domain, else `name` (case-insensitive).
3. On match: **fill blank fields only**, never overwrite non-empty existing values; always refresh `hubspotProperties` and set `hubspotId`.
4. No match: create new, org-scoped.

## Execution model

Vercel serverless caps request duration, so the import cannot run in one request.

- Engine processes in **bounded chunks** (e.g. 100 records/batch) per object type.
- Each batch: fetch page from HubSpot → map → dedup/merge upsert → persist `cursor` +
  increment counters on `ImportJob` → enqueue next batch via self-call.
- **Order:** Companies → Contacts → Deals → Activities (so associations resolve).
- **Rate limits:** HubSpot ~100–190 req/10s. `client.ts` throttles and honors `429 Retry-After`
  with exponential backoff.
- Job survives page navigation; frontend polls `GET .../import/:id`.
- Cancel sets `status='cancelled'`; engine checks before each batch and stops.

## UI / UX

Settings → new **"Integrations"** section:
1. **Connect:** paste HubSpot Private App token → validated (test API call) → `HubSpotConnection` stored.
2. **Import:** "Import from HubSpot" button → confirmation modal → starts `ImportJob`.
3. **Progress:** live card polling status — `Companies 340/1,200 · Contacts 0/… · Deals · Activities`.
4. **Summary:** created / updated / skipped / failed per object + in-app notification on completion.

## Phasing

- **Phase 1:** Private App token auth; import Companies, Contacts, Deals; background job + progress UI.
- **Phase 2:** Activities (notes/calls/emails/meetings/tasks) — highest volume, most rate-limit pressure.
- **Phase 3:** OAuth 2.0 "Connect HubSpot" (registers a public app; same engine, different credential source).

## Error handling

- Per-record failures are caught, counted (`failed`), logged, and **never abort the job**.
- Partial failures surfaced in the summary UI.
- Credential/auth failures (401/403) fail the job fast with a clear message.
- Rate-limit 429s are retried with backoff, not counted as failures.

## Testing

- **Mapper unit tests:** fixture HubSpot payloads → expected PE OS rows (all object types, custom props).
- **Dedup/merge:** match-by-hubspotId, match-by-email/domain, fill-blank-only, no-clobber.
- **Rate-limit backoff:** simulated 429 → retry honors Retry-After.
- **Resumable chunking:** cursor persists, next batch resumes, cancel stops cleanly.
- **Org isolation:** import only writes to the caller's org; cross-org leakage blocked.

## Open questions / future

- OAuth app review timeline (Phase 3) — HubSpot public app may need approval for marketplace.
- Whether to add a "dry-run / preview" mode before committing the import (deferred).
