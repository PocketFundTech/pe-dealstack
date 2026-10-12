# HubSpot import: deal relationships, owners and files

**Date:** 2026-10-11 · **Status:** approved in conversation, pending written-spec review
**Branch:** `feat/hubspot-relationships-files`

## Why

A fact-check of the 8 Oct production import showed counts match HubSpot exactly for everything the
import covers, but several kinds of HubSpot data never reach Avise, and one panel state misleads users:

1. Which contacts are on which deal — not imported.
2. Deal owners — not imported, so no deal gets a Lead Partner.
3. Files and attachments — not imported.
4. Deals associated with several companies — only the first association is used, which may not be the
   company HubSpot marks as Primary.
5. If the HubSpot status call fails, the panel looks "disconnected" (codebase audit 2026-10-11, B12).

## Decisions (made with the founder)

| Topic | Decision |
|---|---|
| Scope | All five in one design and one PR. |
| Multi-company deals | Link the deal to HubSpot's **Primary** company (fallback: first). List the other associated companies by name on the deal's "Imported from HubSpot" card. No schema change. |
| Owners | Match HubSpot owner email → Avise user in the same org → Lead Partner. No match: Lead Partner stays "Not assigned" and the card shows "HubSpot owner: Name". Never auto-invite. |
| Which files | Files attached to a deal — directly, or via a note/email/meeting/call/task associated with that deal. Files only on a contact or company (no deal) are skipped and counted. |
| AI on import | Store only; no embedding during import. A deal-level "Index N documents for AI" button indexes on demand. |
| Architecture | **Approach A:** engagement phases enqueue attachments; a final `files` phase drains the queue in time-boxed batches. |

## Verified HubSpot facts

- Owners: `GET /crm/v3/owners` (paginated). Scope `crm.objects.owners.read`. Deal property `hubspot_owner_id`.
- Deal↔company association types on the v3 list endpoint: `deal_to_company` = **primary** (type 5),
  `deal_to_company_unlabeled` = other (type 341).
- Attachments: engagement property `hs_attachment_ids`, semicolon-separated file IDs.
- Files: `GET /files/v3/files/{id}` (metadata), `GET /files/v3/files/{id}/signed-url` (download URL, valid
  a few hours). Files attached to CRM records are *hidden* files: scopes **`files` and
  `files.ui_hidden.read`** are both required.

## Design

### 1. Status fix (B12)

`HubSpotPanel`'s mount effect swallows a failed `GET /integrations/hubspot/connect` and leaves
`connected=false`. Change: track the status load as `loading | connected | disconnected | error`. On
error, show the real message plus a **Retry** button in place of the connect form. Never render the
connect form unless the server actually said `connected: false`.

### 2. Contacts on deals

- `client.listPage('deals')` requests `associations=companies,contacts`.
- After a deal upserts, resolve the Avise deal id, then for each associated HubSpot contact that exists
  in Avise, insert `ContactDeal(contactId, dealId, role='OTHER')`. Use `UNIQUE(contactId, dealId)` to
  ignore existing links — never change a role a user set.
- Count new links in `objectCounts.deals.contactLinks`.
- **Deal page:** add a **Contacts** section listing linked contacts (name, title, company, role, email
  as a `mailto:` link — the contacts page has no per-contact URL to link to). There is no deal→contacts API today, so add `GET /api/deals/:dealId/contacts`
  (org-scoped). **Bundle parity:** mount the route in `app.ts` and `app-lite.ts`, and check
  `pickBundle` routes it to `lite`.
- Empty state says why: "No contacts linked to this deal yet. Link one from a contact's page, or import
  from HubSpot."

### 3. Owner → Lead Partner

- Add `hubspot_owner_id` to `STANDARD_PROPERTIES.deals`.
- On the first deals batch, fetch all owners once per job (cached per jobId, like stage labels) →
  `Map<ownerId, {email, name}>`.
- Per deal with an owner:
  - Find an Avise `User` in the org whose email matches (case-insensitive).
  - **Match:** if `Deal.assignedTo` is null (or mode is `refresh`), set `assignedTo` and add a
    `DealTeamMember(role='LEAD')` row if absent — the same effect as `POST /deals/:id/team` with LEAD.
    Count in `objectCounts.deals.ownersMatched`.
  - **Always:** write a readable `hubspot_owner` entry ("Jane Doe <jane@x.com>") into the deal's
    `hubspotProperties`, so the HubSpot card shows it whether or not it matched.
- If the owners call returns 403/401, skip owner matching for the rest of the job and append a note
  naming the missing scope (`crm.objects.owners.read`) to the job's message. The rest of the import
  continues.

### 4. Primary company

- Pick the association whose `type === 'deal_to_company'`; fall back to the first result.
  `HubSpotRecord.associations` gains an optional `type` on results.
- Write `associated_companies` (names of the non-primary companies that exist in Avise, comma-joined;
  HubSpot ids for any that don't) into the deal's `hubspotProperties`. It renders on the card through
  the existing `humanizeHubspotKey`.

### 5. Files

**Enqueue (during engagement phases).**
- Add `hs_attachment_ids` to `STANDARD_PROPERTIES` for notes, calls, meetings, emails and tasks.
- `mapEngagement` returns `attachmentIds: string[]`.
- For every engagement with attachments, resolve its **deal** associations — independently of the
  existing contact-first logic, which stays unchanged. For each (deal, fileId) pair, insert a queue row.
- Engagements with attachments but no resolvable deal increment `objectCounts.files.skipped` with
  reason `no_deal`.
- A failed queue insert (e.g. migration not yet run) is logged and counted in `files.failed`. It must
  **not** fail the engagement record.

**Drain (new final phase `files`).**
- `ORDER` gains `'files'` after `'tasks'`. `files` is not a HubSpot list object: the engine branches on
  it and drains `HubSpotFileQueue` rows for this job (`status='pending'`). It processes one file at a
  time and stops at a per-batch time budget (~60s) or 10 files, whichever comes first. Resumable like
  every other phase.
- Total for the progress bar = queue rows for this job (set when the phase starts).
- Per file:
  1. Fetch metadata. If the file is over the size limit for its type (`fileValidator`) → `skipped`,
     reason `too_large`.
  2. Fetch the signed URL, then download.
  3. Store via a server-side **add-file-to-deal** helper with the same validation, sha256 dedup and
     default-folder placement as a normal upload, but **no embedding and no AI extraction**. Text is
     extracted locally (PDF/Excel) so it is ready for indexing later.
     - **Do not duplicate `handleDocumentUpload`.** Extract the shared steps out of
       `routes/documents-upload.ts` into a service that both the upload route and the importer call.
     - `uploadedBy` is the user who started the import.
  4. Set `Document.hubspotFileId`. A file already imported to that deal (`dealId + hubspotFileId`, or the
     same sha256) → `updated`, not a second copy.
  5. Mark the queue row `done` / `skipped` / `failed` with a reason.
- **Missing scope:** if metadata or signed-URL calls return 403, stop the phase, mark the remaining rows
  `skipped` with reason `missing_scope`, and append a note naming `files` + `files.ui_hidden.read`.
- Counts live in `objectCounts.files` (created / updated / skipped / failed / total).

**Index for AI (on click).**
- Deal page (Documents tab): when the deal has documents with extracted text but no embedding, show
  **"Index N documents for AI"**.
- `POST /api/deals/:dealId/documents/index-pending` embeds them one by one via the existing
  `embedDocument`, within a time budget, and returns `{ indexed, remaining }`. The button continues
  until `remaining = 0`. This is user-clicked AI, so it's allowed under the AI-on-click rule.

### 6. Scopes and older connections

- `REQUIRED_SCOPES` (shown in the connect help text and missing-scope errors) gains
  `crm.objects.owners.read`, `files`, `files.ui_hidden.read`.
- Connections made before this change keep working. Owners and files each degrade to "skipped, add
  scope X" independently; contact links and primary company need no new scope.

### 7. Progress panel

`IntegrationsSection.hubspotProgress.tsx` shows:
- Under Deals: "N contacts linked · M owners matched as Lead Partner".
- A **Files** row: "X of Y imported · S skipped · F failed".
- Skipped reasons, expandable: no deal, too large, missing scope.
- Jobs stored before this change (no `files`, no new counters) still render.

## Data model (manual migration — founder runs in Supabase)

```sql
CREATE TABLE IF NOT EXISTS public."HubSpotFileQueue" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "jobId" uuid NOT NULL REFERENCES public."ImportJob"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  "dealId" uuid NOT NULL REFERENCES public."Deal"(id) ON DELETE CASCADE,
  "hubspotFileId" text NOT NULL,
  "sourceEngagementId" text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','failed')),
  reason text,
  "documentId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("jobId", "dealId", "hubspotFileId")
);
CREATE INDEX IF NOT EXISTS idx_hubspotfilequeue_job_status ON public."HubSpotFileQueue" ("jobId", status);
-- Server-only table (service role). Deny-all RLS so the public anon key can't read it (audit S5).
ALTER TABLE public."HubSpotFileQueue" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."Document" ADD COLUMN IF NOT EXISTS "hubspotFileId" text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_deal_hubspotfile
  ON public."Document" ("dealId", "hubspotFileId") WHERE "hubspotFileId" IS NOT NULL;
```

No migration for: `ContactDeal` (exists), owners (existing columns), primary company (existing columns),
new counters (JSONB).

**Before the migration runs**, the import still completes. The files phase reports "files: not imported
— database migration pending", and queue-insert failures never fail engagement records.

## Error handling summary

| Failure | Behaviour |
|---|---|
| Status call fails | Real error + Retry; connect form hidden |
| Owners 401/403 | Skip owner matching for this job; note names the scope |
| Contact on deal not in Avise | Link skipped, not counted (the contact itself failed or was never in HubSpot's contact list) |
| Queue insert fails | Logged, `files.failed++`; engagement record still succeeds |
| File too large | Queue row `skipped/too_large` |
| File 403 | Phase stops; remaining rows `skipped/missing_scope`; note names both scopes |
| File download/network 5xx | Existing client retry/backoff; then row `failed` with reason; phase continues |
| Duplicate file | Matched by `hubspotFileId` or sha256 → `updated`, no second copy |

## Testing

- **API (vitest, existing mock patterns in `tests/hubspot-*.test.ts`):**
  - primary-company selection, including fallback;
  - `associated_companies` written;
  - deal→contact links inserted and idempotent; existing role untouched;
  - owner matched → `assignedTo` + LEAD team row; fill mode keeps an existing Lead Partner; unmatched
    → `hubspot_owner` only; owners 403 → skip and note;
  - attachments enqueued per deal, including when the engagement resolves to contacts;
  - no-deal attachments counted as skipped; queue-insert failure doesn't fail the engagement;
  - files phase: success, too-large skip, 403 stops and marks the rest, dedup on re-run, time budget
    yields `more`;
  - add-file-to-deal helper: shared validation/dedup/folder; no embedding call;
  - `GET /deals/:id/contacts` org-scoped (404 across orgs);
  - `index-pending` embeds and reports remaining;
  - bundle-parity test covers the new routes.
- **Web:**
  - `HubSpotPanel` status error + Retry; never shows connect form on error;
  - progress rows for links, owners, files, and old jobs still render;
  - deal Contacts section, including its empty state;
  - "Index N documents for AI" button.
- **Manual (preview, test HubSpot portal):** a deal with two companies (one Primary), two contacts, an
  owner whose email is an Avise teammate, a note with a PDF attachment, and a 120MB file. Run the
  import twice: no duplicates, and the counts match.

## Out of scope

- Ongoing sync / write-back to HubSpot.
- Files only on contacts or companies; HubSpot File Manager files with no record.
- True multi-company deals.
- Emails scope correction (`sales-email-read` vs `crm.objects.emails.read`) — tracked separately.
- Deal-stage mapping UI for custom pipelines — tracked separately.
