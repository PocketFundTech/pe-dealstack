# HubSpot Engagement History Import (Phase 2) — Design Spec

**Date:** 2026-08-05
**Status:** Approved (design), pending implementation plan
**Author:** Ganesh + Claude

## Goal

Extend the existing HubSpot import (Companies/Contacts/Deals, shipped in PR #88/#89) to
also pull a contact's **engagement history** — Notes, Calls, Meetings, Emails, and
Tasks — so a client's HubSpot activity log isn't lost on migration.

This is Phase 2 of the phasing called out in the original spec
(`2026-06-29-hubspot-import-design.md`). It reuses that spec's engine, dedup, and
execution model unchanged — this document only covers what's new.

## Scope decisions (locked)

| Decision | Choice |
|---|---|
| Engagement types | Notes, Calls, Meetings, Emails, Tasks — all five |
| Emails | Imported despite overlap risk with the existing Gmail integration (`src/integrations/gmail`) — explicit tradeoff accepted, not deferred |
| Tasks | No local Task entity exists. Folded into `ContactInteraction` as `type='OTHER'`, with subject/due-date/status/priority baked into `description` text. Building a first-class Task table/UI is out of scope for this phase. |
| Trigger | Always runs as part of the existing "Import from HubSpot" button — no new opt-in toggle. Every future import also pulls engagement history. |
| Association scope | **Deviates from the original Phase 1 spec's placeholder mapping** (which said "else `Activity` if deal-associated"). This phase is contact-scoped only: an engagement with no resolvable *local* contact association is skipped, not routed to `Activity`. Flagged to the user as a default assumption, not pushed back on. |
| Multi-contact engagements | One `ContactInteraction` row per associated local contact (e.g. a 3-person meeting produces 3 rows) |

## Non-goals (this phase)

- A first-class Task entity (table, API routes, due-date UI, completion workflow) — noted as a possible future feature, not built here.
- Deal-level or company-level engagement history (`Activity` table) — only contact-scoped.
- Deduping HubSpot-imported emails against Gmail-synced ones. They will coexist; a contact's timeline may show the same email logged twice from two sources.

## HubSpot object → property mapping

Verified against HubSpot's CRM v3 engagement docs (not assumed — the Phase 1 postmortem
found a real bug from guessing at API shape, so this phase verifies each type explicitly):

| HubSpot object type | Key properties |
|---|---|
| `notes` | `hs_note_body`, `hs_timestamp` |
| `calls` | `hs_call_title`, `hs_call_body`, `hs_timestamp`, `hs_call_duration`, `hs_call_direction` |
| `meetings` | `hs_meeting_title`, `hs_meeting_body`, `hs_meeting_start_time`, `hs_meeting_end_time`, `hs_meeting_outcome` |
| `emails` | `hs_email_subject`, `hs_email_text`, `hs_timestamp`, `hs_email_direction` |
| `tasks` | `hs_task_subject`, `hs_task_body`, `hs_timestamp` (due date), `hs_task_status`, `hs_task_priority` |

All five support `associations=contacts` on the list endpoint, same as Deals already use
for `associations=companies`.

## Local mapping → `ContactInteraction`

| HubSpot type | `ContactInteraction.type` | `title` | `description` | `date` |
|---|---|---|---|---|
| note | `NOTE` | — | `hs_note_body` | `hs_timestamp` |
| call | `CALL` | `hs_call_title` | `hs_call_body` + duration/direction | `hs_timestamp` |
| meeting | `MEETING` | `hs_meeting_title` | `hs_meeting_body` + outcome | `hs_meeting_start_time` (fallback `hs_timestamp`) |
| email | `EMAIL` | `hs_email_subject` | `hs_email_text` | `hs_timestamp` |
| task | `OTHER` | `[Task] ` + `hs_task_subject` | `hs_task_body` + due date/status/priority | `hs_timestamp` |

## Schema changes

Additive migration on `ContactInteraction` (manual-run in Supabase, per the standing
"Vercel doesn't auto-run SQL" gotcha):

```sql
ALTER TABLE "ContactInteraction" ADD COLUMN IF NOT EXISTS "hubspotId" text;

-- Compound, not a plain hubspotId unique index: one HubSpot engagement can produce
-- multiple ContactInteraction rows (one per associated local contact).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactinteraction_hubspot
  ON "ContactInteraction" ("contactId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
```

## Architecture

Reuses the existing engine (`apps/api/src/services/hubspot/`) unchanged in shape:

- `types.ts`: extend `HubSpotObjectType` to `'companies' | 'contacts' | 'deals' | 'notes' | 'calls' | 'meetings' | 'emails' | 'tasks'`.
- `client.ts`: extend `STANDARD_PROPERTIES` with the five new object types' key properties above. `listPage()` already supports arbitrary object types and the `associations` param — no client changes needed beyond the properties table.
- **New file** `engagementMappers.ts`: one `mapEngagement(objectType, record)` function covering all five types' field-extraction rules (kept separate from `mappers.ts`, which stays scoped to Company/Contact/Deal — avoids one file doing two unrelated jobs).
- `importEngine.ts`: extend `ORDER` to `['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks']` (contacts must precede engagements so association lookups resolve) and add one branch in the per-record loop that calls `mapEngagement()`, resolves each associated contact via the existing hubspotId-lookup pattern, and calls `upsertByHubspotId('ContactInteraction', ...)` once per resolved contact.

No changes to `dedup.ts`, the batching/cursor logic, the property-count cap, or the
cap-hit failure handling — all reused as-is from PR #88/#89.

## Execution model

Unchanged from Phase 1: bounded 100-record batches per object type, cursor-resumable,
same job. Engagement volume is typically much higher than Companies/Contacts/Deals
combined (years of logged emails/calls per contact), so the existing MAX_BATCHES
cap-hit path (PR #89: job fails with an actionable, safe-to-retry message) is more
likely to actually trigger for real clients here than it was for core CRM objects —
this is exactly the scenario that fix was built for.

## UI / UX

No new UI. The existing contact interaction feed (`detail-panel-sections.tsx` /
`InteractionStats`) already renders any `ContactInteraction` row — imported entries
appear inline with manually-added ones, indistinguishable in the feed itself (they
carry `hubspotId` internally but the UI doesn't currently surface a "source" badge).

## Testing

- **Mapper unit tests** (`engagementMappers.test.ts`): one fixture per HubSpot object
  type → expected `ContactInteraction` shape, covering the title/description/date
  extraction rules in the table above.
- **Multi-contact fan-out**: one engagement with 2+ associated contacts produces one
  row per contact.
- **No resolvable contact**: engagement with zero matched local contacts is skipped,
  not written anywhere.
- **Dedup**: re-import matches existing `(contactId, hubspotId)` rows, applies the
  existing fill/refresh mode semantics — no new dedup logic to test beyond confirming
  the compound key is used correctly.
- **Pipeline integration**: `ORDER` includes all 8 object types in the right sequence;
  a batch of one new type still exercises the existing cursor/counts/cap-hit paths
  unchanged.

## Open questions / deferred

- Whether the UI should eventually surface a "source: HubSpot" indicator on imported
  interactions, given emails may now appear from two sources (HubSpot import + Gmail
  sync). Not addressed this phase — flagged for follow-up if it causes client confusion.
- First-class Task entity (own table, due-date reminders, completion workflow) —
  explicitly deferred; tasks land as generic interaction log entries for now.
