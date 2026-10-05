# HubSpot Import: Persist Progress/History Across Page Reloads

## Problem

`HubSpotPanel` (`apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`) only checks
`GET /integrations/hubspot/connect` on mount. It never fetches the org's most recent
`ImportJob`. Result:

- A running import's progress card and the client-side poll/continue-driving loop live only
  in that one tab's React state. Reloading the page, navigating away and back, or opening
  Settings in a new tab shows a bare "Import from HubSpot" button with no indication an
  import is (or was) in flight.
- There is no way to see what a *past* import did (counts, failures, when it ran) once the
  tab that ran it is gone — even though `ImportJob` already stores all of this.

Confirmed via direct DB read: a job can be genuinely `running` and making progress server-side
(e.g. contacts count climbing) while the UI shows nothing, because nothing re-hydrates it.

## Fix

### Backend
Add `GET /api/integrations/hubspot/import/latest`:
- Returns the single most recent `ImportJob` row (`source = 'hubspot'`) for the caller's org,
  ordered by `startedAt desc`, or `null` if none exists.
- Same auth/org-scoping middleware as the existing `hubspot-import.ts` routes.
- Read-only, no new table/column.

### Frontend
In `HubSpotPanel`, on mount (alongside the existing `connect` check):
1. Call `GET /integrations/hubspot/import/latest`.
2. If the returned job's `status === 'running'`:
   - Set it as `job` state so the progress card renders immediately.
   - Resume the existing poll loop (`setInterval` status GET every 2s) — this part already
     exists in `startImport()`, so factor it into a shared helper both `startImport()` and
     the mount effect call.
   - Resume driving it: call the same `/continue` loop `startImport()` already has, reusing
     the returned `jobId` instead of calling `POST /import` first (since the job already
     exists, no need to re-create it).
3. If the returned job's `status` is terminal (`completed`/`failed`/`cancelled`):
   - Set it as `job` state so the final per-object counts render as a persistent "Last import"
     summary instead of nothing — this doubles as the "import log" the user asked for.
4. If no job exists: no change to current behavior (just the Connect/Import button).

No changes to `driveImport`, `runImportBatch`, or any import-engine logic — this is purely
making already-stored state visible, not changing import behavior.

## Out of scope (explicitly not doing now)
- A dedicated Companies list page (separate, already-discussed follow-up).
- A multi-import history view (list of all past jobs) — just the single most recent one.
- Per-record failure detail surfaced in the UI (still log-only for now).

## Risk / edge cases
- Two tabs both resuming the `/continue` drive loop for the same job: safe but wasteful —
  `upsertByHubspotId` is idempotent per `hubspotId`, and the route's cursor update is
  cancel-guarded (`.neq('status','cancelled')`), so concurrent drivers don't corrupt data,
  they just do some duplicate HubSpot GETs. Acceptable for a one-time import flow.
- `latest` endpoint must stay org-scoped (reuse `getOrgId`/`orgMiddleware`) — same as every
  other route in this file.
