# HubSpot relationships, owners and files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The HubSpot import also brings over deal↔contact links, deal owners (as Lead Partner), the Primary company plus the names of other associated companies, and files attached to deals. The HubSpot panel stops posing as "disconnected" when its status call fails.

**Architecture:** Additions are confined to small, focused modules:
- `services/hubspot/dealRelations.ts` — contacts, owners
- `services/hubspot/fileQueue.ts` — attachment queue and its drain
- `services/documentStore.ts` — add a file to a deal's data room

`importEngine.ts` gains a final `files` phase that drains a queue filled during the engagement phases. The front end gets two small new deal-page components and a status/scope helper file for the HubSpot panel.

**Tech Stack:** Express + Supabase (`apps/api`, vitest + supertest), Next.js 16 / React 19 (`apps/web-next`, vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-11-hubspot-relationships-and-files-design.md`

**Worktree:** `/Users/ganesh/AI CRM/.worktrees/hubspot-relationships` (branch `feat/hubspot-relationships-files`). All paths below are relative to it.

**Worktree setup (once, before Task 1):**

```bash
cd packages/shared && npx tsc -p . && cd ../..
mkdir -p node_modules/@ai-crm && ln -sfn ../../packages/shared node_modules/@ai-crm/shared
cd apps/api && npx vitest run tests/hubspot-routes.test.ts   # sanity: should pass
```

If `node_modules` is missing in the worktree, run `npm install` at the worktree root first.

---

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `apps/api/hubspot-relationships-files-migration.sql` | Create | `HubSpotFileQueue` table + `Document.hubspotFileId` |
| `docs/PENDING-MIGRATIONS.md` | Modify | Founder checklist entry |
| `apps/api/src/services/hubspot/types.ts` | Modify | Association `type`, owner/file types, `ImportCounters`, `ImportPhase`, new mapped fields |
| `apps/api/src/services/hubspot/client.ts` | Modify | Owner + file endpoints, `HubSpotScopeError`, new properties/associations |
| `apps/api/src/services/hubspot/mappers.ts` | Modify | Primary company, other companies, deal contacts, owner id |
| `apps/api/src/services/hubspot/engagementMappers.ts` | Modify | `attachmentIds` |
| `apps/api/src/services/documentStore.ts` | Create | `inferDocumentType`, `resolveDefaultFolderId`, `extractLocalText`, `addFileToDeal` |
| `apps/api/src/routes/documents-upload.ts` | Modify | Use the three extracted helpers (behaviour unchanged) |
| `apps/api/src/services/hubspot/dealRelations.ts` | Create | `linkDealContacts`, `loadOrgUsersByEmail`, `applyDealOwner`, `ownerLabel` |
| `apps/api/src/services/hubspot/fileQueue.ts` | Create | `skipWithReason`, `mergeNotes`, `enqueueAttachments`, `drainFileQueue` |
| `apps/api/src/services/hubspot/importEngine.ts` | Modify | Wire deals relations, enqueue attachments, `files` phase, job notes |
| `apps/api/src/routes/hubspot-import.ts` | Modify | `REQUIRED_SCOPES` += owners/files |
| `apps/api/src/routes/deals-contacts.ts` | Create | `GET /api/deals/:dealId/contacts` |
| `apps/api/src/routes/deals-documents-index.ts` | Create | `GET/POST /api/deals/:dealId/documents/index-pending` |
| `apps/api/src/app.ts`, `apps/api/src/app-lite.ts` | Modify | Mount the two routers |
| `apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotStatus.tsx` | Create | `HubSpotScopeHelp`, `HubSpotStatusError` |
| `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx` | Modify | 4-state connection status |
| `apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotProgress.tsx` | Modify | Files row, links/owners line, skip reasons |
| `apps/web-next/src/app/(app)/deals/[id]/deal-contacts.tsx` | Create | Deal Contacts section |
| `apps/web-next/src/app/(app)/deals/[id]/deal-overview.tsx` | Modify | Render it |
| `apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.tsx` | Create | "Index N documents for AI" |
| `apps/web-next/src/app/(app)/deals/[id]/deal-page-left-panel.tsx` | Modify | Render it on the Documents tab |

---

### Task 1: Migration file and founder checklist

**Files:**
- Create: `apps/api/hubspot-relationships-files-migration.sql`
- Modify: `docs/PENDING-MIGRATIONS.md` (prepend a section)

- [ ] **Step 1: Write the migration**

`apps/api/hubspot-relationships-files-migration.sql`:

```sql
-- HubSpot import: files attached to deals (2026-10-11, feat/hubspot-relationships-files).
-- Idempotent. The app works before this runs: the files step reports
-- "database migration pending" and every other part of the import is unaffected.

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

-- Server-only table (service role bypasses RLS). Deny-all so the public anon
-- key can't read it — see docs/CODEBASE-AUDIT-2026-10-11.md S5.
ALTER TABLE public."HubSpotFileQueue" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."Document" ADD COLUMN IF NOT EXISTS "hubspotFileId" text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_deal_hubspotfile
  ON public."Document" ("dealId", "hubspotFileId") WHERE "hubspotFileId" IS NOT NULL;
```

- [ ] **Step 2: Add the founder checklist entry**

Insert this block at the very top of `docs/PENDING-MIGRATIONS.md` (above the first `#` heading):

````markdown
# ⏳ `hubspot-relationships-files-migration.sql` (2026-10-11) — PENDING (founder runs)

HubSpot import brings over files attached to deals. Adds the `HubSpotFileQueue` table (deny-all RLS) and
`Document.hubspotFileId`. Idempotent. Before it runs, imports still complete; the files row says
"database migration pending".

| # | File | Adds | Run? |
|---|---|---|---|
| 1 | `apps/api/hubspot-relationships-files-migration.sql` | File queue + `Document.hubspotFileId` | ⏳ |

Verify (expect 3 rows, `rls_enabled = true` on the table row):
```sql
select 'table' as what, c.relname as name, c.relrowsecurity as rls_enabled
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'HubSpotFileQueue'
union all
select 'column', column_name, null from information_schema.columns
 where table_name = 'Document' and column_name = 'hubspotFileId'
union all
select 'index', indexname, null from pg_indexes where indexname = 'idx_document_deal_hubspotfile';
```

---

````

- [ ] **Step 3: Commit**

```bash
git add apps/api/hubspot-relationships-files-migration.sql docs/PENDING-MIGRATIONS.md
git commit -m "feat(hubspot): migration for the deal file import queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Types and the HubSpot client (owners, files, associations)

**Files:**
- Modify: `apps/api/src/services/hubspot/types.ts`
- Modify: `apps/api/src/services/hubspot/client.ts`
- Test: `apps/api/tests/hubspot-client-owners-files.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/hubspot-client-owners-files.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HubSpotClient, HubSpotScopeError, STANDARD_PROPERTIES } from '../src/services/hubspot/client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('HubSpotClient — owners', () => {
  it('pages through /crm/v3/owners and maps name + email', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ results: [{ id: '1', email: 'a@x.com', firstName: 'Ann', lastName: 'Lee' }], paging: { next: { after: 'p2' } } }))
      .mockResolvedValueOnce(json({ results: [{ id: '2', email: null, firstName: '', lastName: '' }] }));
    const owners = await new HubSpotClient('t').listOwners();
    expect(owners).toEqual([
      { id: '1', email: 'a@x.com', name: 'Ann Lee' },
      { id: '2', email: null, name: null },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('/crm/v3/owners?limit=100');
    expect(fetchMock.mock.calls[1][0]).toContain('after=p2');
  });

  it('throws HubSpotScopeError naming the owners scope on 403', async () => {
    fetchMock.mockResolvedValueOnce(json({ category: 'MISSING_SCOPES' }, 403));
    await expect(new HubSpotClient('t').listOwners()).rejects.toMatchObject({
      name: 'HubSpotScopeError', scopes: 'crm.objects.owners.read', status: 403,
    });
  });
});

describe('HubSpotClient — files', () => {
  it('returns file metadata, null on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 'f1', name: 'CIM', extension: 'pdf', size: 1234 }))
      .mockResolvedValueOnce(json({}, 404));
    const c = new HubSpotClient('t');
    expect(await c.getFileMeta('f1')).toEqual({ id: 'f1', name: 'CIM', extension: 'pdf', size: 1234 });
    expect(await c.getFileMeta('gone')).toBeNull();
  });

  it('throws HubSpotScopeError naming both file scopes on 403', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    const err = await new HubSpotClient('t').getFileSignedUrl('f1').catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotScopeError);
    expect(err.scopes).toBe('files, files.ui_hidden.read');
  });

  it('gets a signed URL and downloads it without the bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ url: 'https://cdn.example/signed' }))
      .mockResolvedValueOnce(new Response(Buffer.from('hello'), { status: 200 }));
    const c = new HubSpotClient('secret');
    const url = await c.getFileSignedUrl('f1');
    expect(url).toBe('https://cdn.example/signed');
    const buf = await c.downloadSignedUrl(url);
    expect(buf.toString()).toBe('hello');
    const downloadInit = fetchMock.mock.calls[1][1] as RequestInit | undefined;
    expect(JSON.stringify(downloadInit ?? {})).not.toContain('secret');
  });
});

describe('HubSpotClient — properties and associations', () => {
  it('requests owner id on deals and attachment ids on every engagement type', () => {
    expect(STANDARD_PROPERTIES.deals).toContain('hubspot_owner_id');
    for (const t of ['notes', 'calls', 'meetings', 'emails', 'tasks'] as const) {
      expect(STANDARD_PROPERTIES[t]).toContain('hs_attachment_ids');
    }
  });

  it('asks for company AND contact associations on deals', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    await new HubSpotClient('t').listPage('deals', { properties: ['dealname'] });
    expect(fetchMock.mock.calls[0][0]).toContain('associations=companies%2Ccontacts');
  });

  it('still asks only for companies on contacts', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    await new HubSpotClient('t').listPage('contacts', { properties: ['email'] });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('associations=companies');
    expect(url).not.toContain('contacts%2C');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-client-owners-files.test.ts`
Expected: FAIL. `listOwners` / `HubSpotScopeError` aren't exported, and the property/association assertions fail.

- [ ] **Step 3: Update `types.ts`**

Replace the `HubSpotRecord` interface with:

```ts
/** One association entry. `type` is e.g. "deal_to_company" (primary) or "deal_to_company_unlabeled". */
export interface HubSpotAssociation {
  id: string;
  type?: string;
}

// Raw record shape returned by HubSpot CRM v3 list endpoints.
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: {
    companies?: { results: HubSpotAssociation[] };
    contacts?: { results: HubSpotAssociation[] };
    deals?: { results: HubSpotAssociation[] };
  };
}
```

In `MappedDeal`, after `associatedCompanyHubspotId: string | null;` add:

```ts
  /** Other companies on the deal (not the primary), de-duplicated. */
  otherCompanyHubspotIds: string[];
  /** Contacts associated with the deal in HubSpot, de-duplicated. */
  contactHubspotIds: string[];
  /** HubSpot owner id (`hubspot_owner_id`), or null. */
  ownerHubspotId: string | null;
```

In `MappedEngagement`, after `associatedDealHubspotIds: string[];` add:

```ts
  /** HubSpot file ids attached to this engagement (`hs_attachment_ids`). */
  attachmentIds: string[];
```

Append at the end of the file:

```ts
/** A HubSpot user who can own records. */
export interface HubSpotOwner {
  id: string;
  email: string | null;
  name: string | null;
}

/** Metadata from GET /files/v3/files/{id}. `name` excludes the extension. */
export interface HubSpotFileMeta {
  id: string;
  name: string;
  extension: string | null;
  size: number | null;
}

/** Phases of an import job: the HubSpot objects, then local file download. */
export type ImportPhase = HubSpotObjectType | 'files';

/** Per-phase counters stored in ImportJob.objectCounts (JSONB — no migration). */
export interface ImportCounters {
  processed: number; created: number; updated: number; failed: number; skipped: number;
  /** Records HubSpot says this object has (for "X of Y" progress); null if unknown. */
  total?: number | null;
  /** Of `updated`: existing Avise rows linked instead of duplicated. Absent on older jobs. */
  matched?: number;
  /** Deals: new deal↔contact links. */
  contactLinks?: number;
  /** Deals: deals whose HubSpot owner is their Avise Lead Partner. */
  ownersMatched?: number;
  /** Why records were skipped, e.g. { no_deal: 3, too_large: 1 }. */
  reasons?: Record<string, number>;
}
```

- [ ] **Step 4: Update `client.ts`**

1. Change the type import line to:

```ts
import type { HubSpotRecord, HubSpotObjectType, HubSpotOwner, HubSpotFileMeta } from './types.js';
```

2. In `STANDARD_PROPERTIES`:
   - Add `'hubspot_owner_id'` to `deals`.
   - Make the engagement lists:

```ts
  notes: ['hs_note_body', 'hs_timestamp', 'hs_attachment_ids'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_timestamp', 'hs_call_duration', 'hs_call_direction', 'hs_attachment_ids'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_timestamp', 'hs_attachment_ids'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_timestamp', 'hs_email_direction', 'hs_attachment_ids'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_timestamp', 'hs_task_status', 'hs_task_priority', 'hs_attachment_ids'],
```

   The `deals` line becomes:

```ts
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline', 'description',
    'closedate', 'createdate', 'dealtype', 'hs_deal_stage_probability', 'hubspot_owner_id',
  ],
```

3. Below the `TokenValidation` interface, add:

```ts
/**
 * HubSpot refused a call for lack of a scope (401/403). Optional parts of the
 * import (owners, files) catch this and skip themselves with a note naming
 * `scopes`, instead of failing the import.
 */
export class HubSpotScopeError extends Error {
  readonly name = 'HubSpotScopeError';
  constructor(readonly scopes: string, readonly status: number) {
    super(`HubSpot ${status}: missing scope(s) ${scopes}`);
  }
}

const OWNER_SCOPES = 'crm.objects.owners.read';
const FILE_SCOPES = 'files, files.ui_hidden.read';
```

4. In `listPage`, replace the line `if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');` with:

```ts
    // Deals also need their contacts (deal↔contact links). Contacts only need
    // their company.
    if (object === 'deals') params.set('associations', 'companies,contacts');
    else if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');
```

5. Add these methods inside the class, after `listPage`:

```ts
  /** Every owner (HubSpot user) in the portal. */
  async listOwners(): Promise<HubSpotOwner[]> {
    const out: HubSpotOwner[] = [];
    let after: string | null = null;
    do {
      const params = new URLSearchParams({ limit: '100' });
      if (after) params.set('after', after);
      const res = await this.requestWithBackoff(`${BASE}/crm/v3/owners?${params.toString()}`);
      if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(OWNER_SCOPES, res.status);
      if (!res.ok) throw new Error(`HubSpot owners list failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as {
        results?: Array<{ id: string; email?: string | null; firstName?: string | null; lastName?: string | null }>;
        paging?: { next?: { after?: string } };
      };
      for (const o of data.results ?? []) {
        const name = [o.firstName, o.lastName].filter((p) => p && p.trim()).join(' ').trim();
        out.push({ id: String(o.id), email: o.email || null, name: name || null });
      }
      after = data.paging?.next?.after ?? null;
    } while (after);
    return out;
  }

  /** File metadata, or null when HubSpot no longer has the file. */
  async getFileMeta(fileId: string): Promise<HubSpotFileMeta | null> {
    const res = await this.requestWithBackoff(`${BASE}/files/v3/files/${encodeURIComponent(fileId)}`);
    if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(FILE_SCOPES, res.status);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HubSpot file ${fileId} lookup failed: ${res.status}`);
    const f = (await res.json()) as { id: string; name?: string; extension?: string | null; size?: number | null };
    return { id: String(f.id), name: f.name || `hubspot-file-${fileId}`, extension: f.extension || null, size: f.size ?? null };
  }

  /** A short-lived download URL for a file (CRM attachments are "hidden" files). */
  async getFileSignedUrl(fileId: string): Promise<string> {
    const res = await this.requestWithBackoff(`${BASE}/files/v3/files/${encodeURIComponent(fileId)}/signed-url`);
    if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(FILE_SCOPES, res.status);
    if (!res.ok) throw new Error(`HubSpot signed URL for ${fileId} failed: ${res.status}`);
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error(`HubSpot returned no signed URL for ${fileId}`);
    return data.url;
  }

  /** Download a signed URL. No Authorization header: the URL itself is the credential. */
  async downloadSignedUrl(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
```

- [ ] **Step 5: Run the test — expect pass**

Run: `cd apps/api && npx vitest run tests/hubspot-client-owners-files.test.ts tests/hubspot-client.test.ts`
Expected: PASS (all). If `tests/hubspot-client.test.ts` asserted the exact old `associations=companies` for deals, update that assertion to `companies%2Ccontacts`. That is the intended change.

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit`
Expected: errors **only** in `mappers.ts` / `engagementMappers.ts` (missing new mapped fields). Task 3 fixes those. Commit anyway:

```bash
git add apps/api/src/services/hubspot/types.ts apps/api/src/services/hubspot/client.ts apps/api/tests/hubspot-client-owners-files.test.ts apps/api/tests/hubspot-client.test.ts
git commit -m "feat(hubspot): client reads owners, file metadata and deal contacts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Mappers — primary company, other companies, contacts, owner, attachments

**Files:**
- Modify: `apps/api/src/services/hubspot/mappers.ts`
- Modify: `apps/api/src/services/hubspot/engagementMappers.ts`
- Test: `apps/api/tests/hubspot-mappers-relations.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/hubspot-mappers-relations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapDeal } from '../src/services/hubspot/mappers.js';
import { mapEngagement } from '../src/services/hubspot/engagementMappers.js';
import type { HubSpotRecord } from '../src/services/hubspot/types.js';

const deal = (assoc: HubSpotRecord['associations'], props: Record<string, string | null> = {}): HubSpotRecord => ({
  id: 'd1', properties: { dealname: 'Acme', ...props }, associations: assoc,
});

describe('mapDeal — companies', () => {
  it('picks the company HubSpot marks as primary, not the first one', () => {
    const m = mapDeal(deal({ companies: { results: [
      { id: 'c2', type: 'deal_to_company_unlabeled' },
      { id: 'c1', type: 'deal_to_company' },
      { id: 'c1', type: 'deal_to_company_unlabeled' },
    ] } }));
    expect(m.associatedCompanyHubspotId).toBe('c1');
    expect(m.otherCompanyHubspotIds).toEqual(['c2']);
  });

  it('falls back to the first company when none is labelled primary', () => {
    const m = mapDeal(deal({ companies: { results: [{ id: 'c9' }, { id: 'c8' }] } }));
    expect(m.associatedCompanyHubspotId).toBe('c9');
    expect(m.otherCompanyHubspotIds).toEqual(['c8']);
  });

  it('has no companies when HubSpot returns none', () => {
    const m = mapDeal(deal(undefined));
    expect(m.associatedCompanyHubspotId).toBeNull();
    expect(m.otherCompanyHubspotIds).toEqual([]);
  });
});

describe('mapDeal — contacts and owner', () => {
  it('collects de-duplicated contact ids', () => {
    const m = mapDeal(deal({ contacts: { results: [{ id: 'p1' }, { id: 'p2' }, { id: 'p1' }] } }));
    expect(m.contactHubspotIds).toEqual(['p1', 'p2']);
  });

  it('reads the owner id and keeps the raw id out of hubspotProperties', () => {
    const m = mapDeal(deal(undefined, { hubspot_owner_id: '777' }));
    expect(m.ownerHubspotId).toBe('777');
    expect(m.hubspotProperties).not.toHaveProperty('hubspot_owner_id');
  });

  it('owner is null when unset', () => {
    expect(mapDeal(deal(undefined, { hubspot_owner_id: '' })).ownerHubspotId).toBeNull();
  });
});

describe('mapEngagement — attachments', () => {
  it('splits hs_attachment_ids on semicolons and drops blanks', () => {
    const m = mapEngagement('notes', { id: 'n1', properties: { hs_attachment_ids: '11; 12;;' } });
    expect(m.attachmentIds).toEqual(['11', '12']);
  });

  it('is empty when there are no attachments', () => {
    expect(mapEngagement('calls', { id: 'c1', properties: {} }).attachmentIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-mappers-relations.test.ts`
Expected: FAIL. `otherCompanyHubspotIds` / `contactHubspotIds` / `ownerHubspotId` / `attachmentIds` are undefined, and the primary-company case returns `c2`.

- [ ] **Step 3: Implement in `mappers.ts`**

Change `const DEAL_STD = new Set(['dealname', 'amount']);` to:

```ts
// hubspot_owner_id is shown as a readable `hubspot_owner` instead (importEngine).
const DEAL_STD = new Set(['dealname', 'amount', 'hubspot_owner_id']);
```

Add above `mapDeal`:

```ts
/** HubSpot's association type for a deal's primary company (type id 5). */
const PRIMARY_COMPANY_TYPE = 'deal_to_company';

/**
 * HubSpot lists the primary company twice (once labelled primary, once
 * unlabelled), so pick the primary first and de-duplicate the rest.
 */
function splitCompanies(r: HubSpotRecord): { primary: string | null; others: string[] } {
  const results = r.associations?.companies?.results ?? [];
  const primary = results.find((c) => c.type === PRIMARY_COMPANY_TYPE)?.id ?? results[0]?.id ?? null;
  const others = [...new Set(results.map((c) => c.id))].filter((id) => id !== primary);
  return { primary, others };
}
```

In `mapDeal`'s return object, replace `associatedCompanyHubspotId: r.associations?.companies?.results?.[0]?.id ?? null,` with:

```ts
    associatedCompanyHubspotId: companies.primary,
    otherCompanyHubspotIds: companies.others,
    contactHubspotIds: [...new Set((r.associations?.contacts?.results ?? []).map((c) => c.id))],
    ownerHubspotId: p.hubspot_owner_id?.trim() || null,
```

Add `const companies = splitCompanies(r);` as the first line inside `mapDeal`, after `const p = r.properties;`.

- [ ] **Step 4: Implement in `engagementMappers.ts`**

In `mapEngagement`, change the `base` line to:

```ts
  const attachmentIds = (p.hs_attachment_ids ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const base = { hubspotId: r.id, interactionType: INTERACTION_TYPE[type], associatedContactHubspotIds, associatedDealHubspotIds, attachmentIds };
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd apps/api && npx vitest run tests/hubspot-mappers-relations.test.ts tests/hubspot-mappers.test.ts tests/hubspot-engagement-mappers.test.ts && npx tsc --noEmit`
Expected: all PASS; `tsc` clean. If an older mapper test does `toEqual` on a whole mapped object, add the new fields to its expected value (`otherCompanyHubspotIds: []`, `contactHubspotIds: []`, `ownerHubspotId: null`, `attachmentIds: []`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/hubspot/mappers.ts apps/api/src/services/hubspot/engagementMappers.ts apps/api/tests/hubspot-mappers-relations.test.ts apps/api/tests/hubspot-mappers.test.ts apps/api/tests/hubspot-engagement-mappers.test.ts
git commit -m "feat(hubspot): map primary company, deal contacts, owner and attachments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `documentStore` — shared upload steps + `addFileToDeal`

**Files:**
- Create: `apps/api/src/services/documentStore.ts`
- Modify: `apps/api/src/routes/documents-upload.ts`
- Test: `apps/api/tests/document-store.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/document-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
const storageUpload = vi.fn(async () => ({ data: { path: 'p' }, error: null as unknown }));
vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => chain.from(t), storage: { from: () => ({ upload: storageUpload }) } },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const validateFile = vi.fn();
vi.mock('../src/services/fileValidator.js', () => ({
  validateFile: (...a: unknown[]) => validateFile(...a),
  isPotentiallyDangerous: () => false,
  sanitizeFilename: (n: string) => n,
}));
vi.mock('../src/services/pdfExtractor.js', () => ({
  extractTextFromPDF: vi.fn(async () => ({ text: 'pdf text\u0000', numPages: 3 })),
}));
vi.mock('../src/services/excelToMarkdown.js', () => ({ excelToMarkdown: () => '| a |' }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  isExcelFile: (mime: string | null) => !!mime && mime.includes('spreadsheet'),
}));
const embedDocument = vi.fn();
vi.mock('../src/rag.js', () => ({ embedDocument: (...a: unknown[]) => embedDocument(...a) }));

import { inferDocumentType, resolveDefaultFolderId, extractLocalText, addFileToDeal } from '../src/services/documentStore.js';

beforeEach(() => {
  chain.calls.length = 0;
  resolver = () => undefined;
  storageUpload.mockClear();
  validateFile.mockReset().mockReturnValue({ isValid: true, sanitizedFilename: 'CIM.pdf' });
  embedDocument.mockClear();
});

describe('inferDocumentType', () => {
  it.each([
    ['Project Atlas CIM.pdf', 'application/pdf', 'CIM'],
    ['teaser.pdf', 'application/pdf', 'TEASER'],
    ['model.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'FINANCIALS'],
    ['data.csv', 'text/csv', 'FINANCIALS'],
    ['Mutual NDA.docx', null, 'NDA'],
    ['photo.png', 'image/png', 'OTHER'],
  ])('%s → %s', (name, mime, expected) => {
    expect(inferDocumentType(name, mime)).toBe(expected);
  });
});

describe('resolveDefaultFolderId', () => {
  it('creates the default folders when the deal has none, then matches by type', async () => {
    resolver = (op) => {
      if (op.table === 'Folder' && op.action === 'select') return { data: [] };
      if (op.table === 'Folder' && op.action === 'insert') {
        return { data: [{ id: 'f-fin', name: '100 Financials' }, { id: 'f-legal', name: '200 Legal' }] };
      }
      return undefined;
    };
    expect(await resolveDefaultFolderId('deal-1', 'NDA')).toBe('f-legal');
    expect(chain.calls.some((c) => c.table === 'Folder' && c.action === 'insert')).toBe(true);
  });

  it('uses the first folder for a type without a pattern', async () => {
    resolver = (op) => (op.table === 'Folder' ? { data: [{ id: 'f-a', name: '100 Financials' }] } : undefined);
    expect(await resolveDefaultFolderId('deal-1', 'OTHER')).toBe('f-a');
  });
});

describe('extractLocalText', () => {
  it('PDF: text without NULs, page count, completed', async () => {
    expect(await extractLocalText(Buffer.from('x'), 'application/pdf', 'a.pdf'))
      .toEqual({ text: 'pdf text', numPages: 3, status: 'completed' });
  });
  it('Excel with content: text, still processing (matches the upload route)', async () => {
    const r = await extractLocalText(Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'm.xlsx');
    expect(r).toEqual({ text: '| a |', numPages: null, status: 'processing' });
  });
  it('other types: no text, completed', async () => {
    expect(await extractLocalText(Buffer.from('x'), 'image/png', 'p.png')).toEqual({ text: null, numPages: null, status: 'completed' });
  });
});

describe('addFileToDeal', () => {
  const input = {
    dealId: 'deal-1', filename: 'CIM.pdf', buffer: Buffer.from('%PDF-1.4 body'),
    mimeType: 'application/pdf', uploadedBy: 'user-1', hubspotFileId: 'hs-f1',
  };

  it('returns the existing document when this HubSpot file is already on the deal — no upload', async () => {
    resolver = (op) => (op.table === 'Document' && filterValue(op, 'hubspotFileId') === 'hs-f1'
      ? { data: { id: 'doc-old' } } : undefined);
    expect(await addFileToDeal(input)).toEqual({ outcome: 'existing', documentId: 'doc-old' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('rejects a file that fails validation', async () => {
    validateFile.mockReturnValue({ isValid: false, error: 'bad magic bytes' });
    expect(await addFileToDeal(input)).toEqual({ outcome: 'rejected', reason: 'bad magic bytes' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('links an identical file already on the deal (same sha256) instead of copying it', async () => {
    resolver = (op) => {
      if (op.table === 'Document' && op.action === 'select' && filterValue(op, 'fileSha256')) {
        return { data: { id: 'doc-same', hubspotFileId: null } };
      }
      return undefined;
    };
    expect(await addFileToDeal(input)).toEqual({ outcome: 'existing', documentId: 'doc-same' });
    const upd = chain.calls.find((c) => c.table === 'Document' && c.action === 'update');
    expect(upd?.payload).toEqual({ hubspotFileId: 'hs-f1' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('stores, inserts the Document with hubspotFileId and never embeds', async () => {
    resolver = (op) => {
      if (op.table === 'Folder' && op.action === 'select') return { data: [{ id: 'f-fin', name: '100 Financials' }] };
      if (op.table === 'Document' && op.action === 'insert') return { data: { id: 'doc-new' } };
      return undefined;
    };
    expect(await addFileToDeal(input)).toEqual({ outcome: 'created', documentId: 'doc-new' });
    expect(storageUpload).toHaveBeenCalledTimes(1);
    const ins = chain.calls.find((c) => c.table === 'Document' && c.action === 'insert');
    expect(ins?.payload).toMatchObject({
      dealId: 'deal-1', folderId: 'f-fin', uploadedBy: 'user-1', name: 'CIM.pdf', type: 'CIM',
      mimeType: 'application/pdf', extractedText: 'pdf text', status: 'completed', hubspotFileId: 'hs-f1',
    });
    expect(embedDocument).not.toHaveBeenCalled();
  });

  it('omits hubspotFileId entirely for non-HubSpot callers', async () => {
    resolver = (op) => (op.table === 'Document' && op.action === 'insert' ? { data: { id: 'doc-x' } } : undefined);
    await addFileToDeal({ ...input, hubspotFileId: null });
    const ins = chain.calls.find((c) => c.table === 'Document' && c.action === 'insert');
    expect(ins?.payload).not.toHaveProperty('hubspotFileId');
  });

  it('throws when storage fails (the caller marks the file failed)', async () => {
    storageUpload.mockResolvedValueOnce({ data: null as unknown as { path: string }, error: { message: 'bucket gone' } });
    await expect(addFileToDeal(input)).rejects.toThrow(/bucket gone/);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/document-store.test.ts`
Expected: FAIL (`documentStore.js` does not exist).

- [ ] **Step 3: Create `apps/api/src/services/documentStore.ts`**

```ts
import { createHash } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { validateFile, sanitizeFilename, isPotentiallyDangerous } from './fileValidator.js';
import { extractTextFromPDF } from './pdfExtractor.js';

// Shared "a file lands in a deal's data room" steps. The upload route
// (routes/documents-upload.ts) and server-side importers (HubSpot files) both
// use these, so type detection, folder placement and text extraction stay
// identical. addFileToDeal is the server-side entry point: it never embeds or
// runs AI — indexing for chat is a separate, user-clicked action.

/** Guess the document type from its name / MIME type (the upload route's rules). */
export function inferDocumentType(name: string, mimeType: string | null): string {
  const lowerName = name.toLowerCase();
  const lowerMime = (mimeType ?? '').toLowerCase();
  // Spreadsheets default to FINANCIALS so the deep financial extraction picks them up.
  const looksLikeSpreadsheet =
    lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv') ||
    lowerMime.includes('spreadsheet') || lowerMime.includes('excel') ||
    lowerMime === 'text/csv' || lowerMime === 'application/csv';

  if (lowerName.includes('cim') || lowerName.includes('confidential')) return 'CIM';
  if (lowerName.includes('teaser')) return 'TEASER';
  if (
    lowerName.includes('financial') || lowerName.includes('model') || lowerName.includes('p&l') ||
    lowerName.includes('p_l') || lowerName.includes('income') || lowerName.includes('balance') ||
    lowerName.includes('cashflow') || lowerName.includes('cash flow') ||
    lowerName.includes('master sheet') || lowerName.includes('mastersheet') || looksLikeSpreadsheet
  ) return 'FINANCIALS';
  if (lowerName.includes('legal') || lowerName.includes('dd')) return 'LEGAL';
  if (lowerName.includes('nda')) return 'NDA';
  if (lowerName.includes('loi') || lowerName.includes('letter')) return 'LOI';
  if (lowerName.includes('email') || lowerName.endsWith('.msg')) return 'EMAIL';
  return 'OTHER';
}

const FOLDER_PATTERNS: Record<string, RegExp> = {
  CIM: /financ|cim/i,
  FINANCIALS: /financ/i,
  LEGAL: /legal/i,
  NDA: /legal|nda/i,
  LOI: /legal|commercial/i,
  DD_REPORT: /due\s*diligence|dd/i,
};

const DEFAULT_FOLDERS = [
  { name: '100 Financials', sortOrder: 100, description: 'Financial statements, projections, and analysis' },
  { name: '200 Legal', sortOrder: 200, description: 'Legal documents, contracts, and agreements' },
  { name: '300 Commercial', sortOrder: 300, description: 'Commercial due diligence materials' },
  { name: '400 HR & Data', sortOrder: 400, description: 'HR documents and data room materials' },
  { name: '500 Intellectual Property', sortOrder: 500, description: 'IP documentation and patents' },
];

/**
 * The VDR folder a new document of `docType` goes into. Creates the default
 * folder set when the deal has none yet.
 */
export async function resolveDefaultFolderId(dealId: string, docType: string): Promise<string | null> {
  let { data: folders } = await supabase
    .from('Folder').select('id, name').eq('dealId', dealId).order('name', { ascending: true });

  if (!folders || folders.length === 0) {
    const { data: created } = await supabase
      .from('Folder')
      .insert(DEFAULT_FOLDERS.map((f) => ({ ...f, dealId, parentId: null, isRestricted: false })))
      .select('id, name');
    if (created && created.length > 0) {
      folders = created;
      log.info('Auto-created default VDR folders for deal', { dealId, count: created.length });
    }
  }
  if (!folders || folders.length === 0) return null;

  const pattern = FOLDER_PATTERNS[docType];
  const list = folders as Array<{ id: string; name: string }>;
  const match = pattern ? list.find((f) => pattern.test(f.name)) : undefined;
  return match?.id ?? list[0]?.id ?? null;
}

export interface LocalText {
  text: string | null;
  numPages: number | null;
  /** The upload route's extraction status: Excel with text stays 'processing' (AI may follow). */
  status: 'completed' | 'failed' | 'processing';
}

/** Local (no-AI) text extraction for PDFs and spreadsheets. */
export async function extractLocalText(buffer: Buffer, mimeType: string | null, name: string): Promise<LocalText> {
  if (mimeType === 'application/pdf') {
    const extraction = await extractTextFromPDF(buffer);
    if (!extraction) return { text: null, numPages: null, status: 'failed' };
    // PostgreSQL can't store NUL characters.
    return { text: extraction.text.replace(/\u0000/g, ''), numPages: extraction.numPages, status: 'completed' };
  }
  // Lazy-loaded so the lite bundle stays light on cold start.
  const { isExcelFile } = await import('./excelFinancialExtractor.js');
  if (isExcelFile(mimeType, name)) {
    try {
      const { excelToMarkdown } = await import('./excelToMarkdown.js');
      const markdown = excelToMarkdown(buffer);
      if (markdown) return { text: markdown.replace(/\u0000/g, ''), numPages: null, status: 'processing' };
      return { text: null, numPages: null, status: 'completed' };
    } catch (err) {
      log.error('Excel extraction failed', err, { name });
      return { text: null, numPages: null, status: 'completed' };
    }
  }
  return { text: null, numPages: null, status: 'completed' };
}

export interface AddFileInput {
  dealId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  /** Internal User.id, or null. */
  uploadedBy: string | null;
  /** Set by the HubSpot importer; omitted from the row otherwise. */
  hubspotFileId?: string | null;
}

export type AddFileResult =
  | { outcome: 'created' | 'existing'; documentId: string }
  | { outcome: 'rejected'; reason: string };

/**
 * Store a file in a deal's data room: validation, sha256 de-duplication,
 * default folder, local text extraction. No embedding and no AI.
 * Throws when storage or the insert fails.
 */
export async function addFileToDeal(input: AddFileInput): Promise<AddFileResult> {
  const { dealId, filename, buffer, mimeType, uploadedBy, hubspotFileId } = input;

  if (hubspotFileId) {
    const { data: already } = await supabase
      .from('Document').select('id').eq('dealId', dealId).eq('hubspotFileId', hubspotFileId).maybeSingle();
    if (already) return { outcome: 'existing', documentId: (already as { id: string }).id };
  }

  const validation = validateFile(buffer, filename, mimeType);
  if (!validation.isValid) return { outcome: 'rejected', reason: validation.error ?? 'File failed validation' };
  if (isPotentiallyDangerous(buffer, filename)) return { outcome: 'rejected', reason: 'File appears to contain executable or script content' };

  const fileSha256 = createHash('sha256').update(buffer).digest('hex');
  const { data: same } = await supabase
    .from('Document').select('id, hubspotFileId').eq('dealId', dealId).eq('fileSha256', fileSha256).limit(1).maybeSingle();
  if (same) {
    const row = same as { id: string; hubspotFileId?: string | null };
    if (hubspotFileId && !row.hubspotFileId) {
      await supabase.from('Document').update({ hubspotFileId }).eq('id', row.id);
    }
    return { outcome: 'existing', documentId: row.id };
  }

  const safeName = validation.sanitizedFilename || sanitizeFilename(filename);
  const filePath = `${dealId}/${Date.now()}_${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from('documents').upload(filePath, buffer, { contentType: mimeType, upsert: false });
  if (uploadError) throw new Error(`Storage upload failed: ${(uploadError as { message?: string }).message ?? 'unknown error'}`);

  const docType = inferDocumentType(safeName, mimeType);
  const folderId = await resolveDefaultFolderId(dealId, docType);
  const local = await extractLocalText(buffer, mimeType, safeName);

  const { data: doc, error: insertError } = await supabase
    .from('Document')
    .insert({
      dealId,
      folderId,
      uploadedBy,
      name: safeName,
      type: docType,
      fileUrl: filePath,
      fileSize: buffer.length,
      mimeType,
      fileSha256,
      extractedText: local.text,
      // No AI follows a server-side import, so the row is final.
      status: 'completed',
      ...(hubspotFileId ? { hubspotFileId } : {}),
    })
    .select('id')
    .single();
  if (insertError || !doc) throw new Error(`Document insert failed: ${(insertError as { message?: string } | null)?.message ?? 'no row'}`);

  await supabase.from('Deal')
    .update({ lastDocument: safeName, lastDocumentUpdated: new Date().toISOString() })
    .eq('id', dealId);

  return { outcome: 'created', documentId: (doc as { id: string }).id };
}
```

- [ ] **Step 4: Run the new test — expect pass**

Run: `cd apps/api && npx vitest run tests/document-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Make the upload route use the shared helpers (behaviour unchanged)**

In `apps/api/src/routes/documents-upload.ts`:

1. Add the import after the `extractTextFromPDF` import line:

```ts
import { inferDocumentType, resolveDefaultFolderId, extractLocalText } from '../services/documentStore.js';
```

2. Replace the whole document-type block — from `let docType = req.body.type || 'OTHER';` through the closing `}` of `if (docType === 'OTHER' && documentName) { ... }` — with:

```ts
    let docType = req.body.type || 'OTHER';
    if (docType === 'OTHER' && documentName) docType = inferDocumentType(documentName, mimeType);
```

3. Replace the text-extraction block — from `let extractedText: string | null = null;` through the end of the `} else if (file) { ... extractionStatus = 'completed'; }` chain — with:

```ts
    let extractedText: string | null = null;
    let extractionStatus = 'pending';
    let numPages: number | null = null;

    if (file) {
      // Local parsing only (no LLM call); see services/documentStore.ts.
      const local = await extractLocalText(file.buffer, mimeType, documentName);
      extractedText = local.text;
      numPages = local.numPages;
      extractionStatus = local.status;
      log.info('Local text extraction finished', { documentName, status: local.status, textLength: extractedText?.length ?? 0 });
    }
```

4. Replace the folder block — from `let resolvedFolderId = req.body.folderId || null;` through the closing `}` of `if (!resolvedFolderId) { ... }` — with:

```ts
    let resolvedFolderId = req.body.folderId || null;
    if (!resolvedFolderId) {
      resolvedFolderId = await resolveDefaultFolderId(dealId, docType);
      if (resolvedFolderId) log.info('Auto-assigned document to folder', { docType, folderId: resolvedFolderId });
    }
```

5. Remove the now-unused `extractTextFromPDF` import and the lazy `excelToMarkdown` / `isExcelFile` imports from `handleDocumentUpload` if `tsc` or lint flags them as unused. Keep them if they're still referenced elsewhere in the file (search first).

- [ ] **Step 6: Run the upload route's existing tests + typecheck**

Run: `cd apps/api && npx vitest run tests/ --reporter=dot -t "upload|document" && npx tsc --noEmit`
Expected: PASS and `tsc` clean. The route's behaviour must not change. If a test mocks `../src/services/pdfExtractor.js`, it still works, because `documentStore` imports the same module.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/documentStore.ts apps/api/src/routes/documents-upload.ts apps/api/tests/document-store.test.ts
git commit -m "refactor(documents): share upload steps; add server-side addFileToDeal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `dealRelations` — contact links and owner → Lead Partner

**Files:**
- Create: `apps/api/src/services/hubspot/dealRelations.ts`
- Test: `apps/api/tests/hubspot-deal-relations.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/hubspot-deal-relations.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));

import { linkDealContacts, loadOrgUsersByEmail, applyDealOwner, ownerLabel } from '../src/services/hubspot/dealRelations.js';

beforeEach(() => { chain.calls.length = 0; resolver = () => undefined; });

describe('linkDealContacts', () => {
  it('upserts with ignoreDuplicates and returns how many were new', async () => {
    resolver = (op) => (op.table === 'ContactDeal' ? { data: [{ id: 'l1' }] } : undefined);
    const n = await linkDealContacts('deal-1', ['c1', 'c2']);
    expect(n).toBe(1);
    const op = chain.calls.find((c) => c.table === 'ContactDeal')!;
    expect(op.action).toBe('upsert');
    expect(op.payload).toEqual([
      { contactId: 'c1', dealId: 'deal-1', role: 'OTHER' },
      { contactId: 'c2', dealId: 'deal-1', role: 'OTHER' },
    ]);
  });

  it('does nothing for an empty list', async () => {
    expect(await linkDealContacts('deal-1', [])).toBe(0);
    expect(chain.calls).toHaveLength(0);
  });

  it('throws on a database error', async () => {
    resolver = () => ({ error: { message: 'boom' } });
    await expect(linkDealContacts('deal-1', ['c1'])).rejects.toThrow(/boom/);
  });
});

describe('loadOrgUsersByEmail', () => {
  it('maps lower-cased email → User.id for the org', async () => {
    resolver = (op) => (op.table === 'User' ? { data: [{ id: 'u1', email: 'Ann@X.com' }, { id: 'u2', email: null }] } : undefined);
    const map = await loadOrgUsersByEmail('org-1');
    expect([...map]).toEqual([['ann@x.com', 'u1']]);
    expect(filterValue(chain.calls[0], 'organizationId')).toBe('org-1');
  });
});

describe('applyDealOwner', () => {
  it('no matching user → no_match, no writes', async () => {
    expect(await applyDealOwner({ dealId: 'd1', ownerUserId: null, mode: 'fill' })).toBe('no_match');
    expect(chain.calls).toHaveLength(0);
  });

  it('fill mode keeps an existing Lead Partner', async () => {
    resolver = (op) => (op.table === 'Deal' && op.action === 'select' ? { data: { assignedTo: 'someone-else' } } : undefined);
    expect(await applyDealOwner({ dealId: 'd1', ownerUserId: 'u1', mode: 'fill' })).toBe('kept_existing');
    expect(chain.calls.some((c) => c.action === 'update' || c.action === 'insert')).toBe(false);
  });

  it('already the Lead Partner → already, no writes', async () => {
    resolver = (op) => (op.table === 'Deal' && op.action === 'select' ? { data: { assignedTo: 'u1' } } : undefined);
    expect(await applyDealOwner({ dealId: 'd1', ownerUserId: 'u1', mode: 'fill' })).toBe('already');
    expect(chain.calls.some((c) => c.action === 'update')).toBe(false);
  });

  it('sets assignedTo and adds a LEAD team member when absent', async () => {
    resolver = (op) => {
      if (op.table === 'Deal' && op.action === 'select') return { data: { assignedTo: null } };
      if (op.table === 'DealTeamMember' && op.action === 'select') return { data: null };
      return undefined;
    };
    expect(await applyDealOwner({ dealId: 'd1', ownerUserId: 'u1', mode: 'fill' })).toBe('set');
    expect(chain.calls.find((c) => c.table === 'Deal' && c.action === 'update')?.payload).toMatchObject({ assignedTo: 'u1' });
    expect(chain.calls.find((c) => c.table === 'DealTeamMember' && c.action === 'insert')?.payload)
      .toEqual({ dealId: 'd1', userId: 'u1', role: 'LEAD' });
  });

  it('refresh mode replaces a different Lead Partner; existing team row is left alone', async () => {
    resolver = (op) => {
      if (op.table === 'Deal' && op.action === 'select') return { data: { assignedTo: 'old' } };
      if (op.table === 'DealTeamMember' && op.action === 'select') return { data: { id: 'tm1' } };
      return undefined;
    };
    expect(await applyDealOwner({ dealId: 'd1', ownerUserId: 'u1', mode: 'refresh' })).toBe('set');
    expect(chain.calls.some((c) => c.table === 'DealTeamMember' && c.action === 'insert')).toBe(false);
  });
});

describe('ownerLabel', () => {
  it.each([
    [{ id: '1', name: 'Ann Lee', email: 'a@x.com' }, 'Ann Lee <a@x.com>'],
    [{ id: '1', name: null, email: 'a@x.com' }, 'a@x.com'],
    [{ id: '1', name: 'Ann Lee', email: null }, 'Ann Lee'],
    [{ id: '9', name: null, email: null }, 'HubSpot owner 9'],
  ])('%o → %s', (o, expected) => { expect(ownerLabel(o)).toBe(expected); });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-deal-relations.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `apps/api/src/services/hubspot/dealRelations.ts`**

```ts
import { supabase } from '../../supabase.js';
import type { ImportMode } from './dedup.js';
import type { HubSpotOwner } from './types.js';

/**
 * Link contacts to a deal (ContactDeal). Existing links — including any role a
 * user picked — are left untouched. Returns how many links are new.
 */
export async function linkDealContacts(dealId: string, contactIds: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const rows = contactIds.map((contactId) => ({ contactId, dealId, role: 'OTHER' }));
  const { data, error } = await supabase
    .from('ContactDeal')
    .upsert(rows, { onConflict: 'contactId,dealId', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`ContactDeal link failed: ${(error as { message?: string }).message ?? 'unknown error'}`);
  return (data as unknown[] | null)?.length ?? 0;
}

/** The org's users keyed by lower-cased email → internal User.id. */
export async function loadOrgUsersByEmail(orgId: string): Promise<Map<string, string>> {
  const { data } = await supabase.from('User').select('id, email').eq('organizationId', orgId);
  const map = new Map<string, string>();
  for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) {
    if (u.email) map.set(u.email.trim().toLowerCase(), u.id);
  }
  return map;
}

export type OwnerResult = 'set' | 'already' | 'kept_existing' | 'no_match';

/**
 * Make the HubSpot owner the deal's Lead Partner — the same effect as adding
 * them with role LEAD via POST /deals/:id/team (Deal.assignedTo + a LEAD
 * DealTeamMember). Fill mode never replaces a Lead Partner someone set in Avise.
 */
export async function applyDealOwner(params: {
  dealId: string;
  ownerUserId: string | null;
  mode: ImportMode;
}): Promise<OwnerResult> {
  const { dealId, ownerUserId, mode } = params;
  if (!ownerUserId) return 'no_match';

  const { data: deal } = await supabase.from('Deal').select('assignedTo').eq('id', dealId).maybeSingle();
  const current = (deal as { assignedTo?: string | null } | null)?.assignedTo ?? null;
  if (current === ownerUserId) return 'already';
  if (current && mode === 'fill') return 'kept_existing';

  await supabase.from('Deal')
    .update({ assignedTo: ownerUserId, updatedAt: new Date().toISOString() })
    .eq('id', dealId);

  const { data: member } = await supabase
    .from('DealTeamMember').select('id').eq('dealId', dealId).eq('userId', ownerUserId).maybeSingle();
  if (!member) {
    await supabase.from('DealTeamMember').insert({ dealId, userId: ownerUserId, role: 'LEAD' });
  }
  return 'set';
}

/** "Name <email>" for the deal's HubSpot card, with sensible fallbacks. */
export function ownerLabel(o: HubSpotOwner): string {
  if (o.name && o.email) return `${o.name} <${o.email}>`;
  return o.name ?? o.email ?? `HubSpot owner ${o.id}`;
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `cd apps/api && npx vitest run tests/hubspot-deal-relations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hubspot/dealRelations.ts apps/api/tests/hubspot-deal-relations.test.ts
git commit -m "feat(hubspot): link deal contacts and set Lead Partner from the owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `fileQueue` — enqueue attachments and drain them

**Files:**
- Create: `apps/api/src/services/hubspot/fileQueue.ts`
- Test: `apps/api/tests/hubspot-file-queue.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/hubspot-file-queue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const addFileToDeal = vi.fn();
vi.mock('../src/services/documentStore.js', () => ({ addFileToDeal: (...a: unknown[]) => addFileToDeal(...a) }));

import { enqueueAttachments, drainFileQueue, skipWithReason, mergeNotes, MIGRATION_PENDING_NOTE } from '../src/services/hubspot/fileQueue.js';
import { HubSpotScopeError } from '../src/services/hubspot/client.js';
import type { ImportCounters } from '../src/services/hubspot/types.js';

const counters = (): ImportCounters => ({ processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 });
const pdfMeta = { id: 'f1', name: 'CIM', extension: 'pdf', size: 1000 };

function client(overrides: Partial<Record<'getFileMeta' | 'getFileSignedUrl' | 'downloadSignedUrl', unknown>> = {}) {
  return {
    getFileMeta: vi.fn(async () => pdfMeta),
    getFileSignedUrl: vi.fn(async () => 'https://signed'),
    downloadSignedUrl: vi.fn(async () => Buffer.from('%PDF')),
    ...overrides,
  } as never;
}

beforeEach(() => {
  chain.calls.length = 0;
  resolver = () => undefined;
  addFileToDeal.mockReset().mockResolvedValue({ outcome: 'created', documentId: 'doc-1' });
});

describe('skipWithReason / mergeNotes', () => {
  it('counts a skip as processed with its reason', () => {
    const c = counters();
    skipWithReason(c, 'no_deal', 2);
    skipWithReason(c, 'no_deal');
    expect(c).toMatchObject({ skipped: 3, processed: 3, reasons: { no_deal: 3 } });
  });
  it('appends notes once, keeping existing ones', () => {
    expect(mergeNotes('emails: 403', ['owners: x', 'owners: x'])).toBe('emails: 403 | owners: x');
    expect(mergeNotes('a | b', ['b'])).toBe('a | b');
    expect(mergeNotes(null, [])).toBeNull();
  });
});

describe('enqueueAttachments', () => {
  it('queues every deal × file pair, ignoring duplicates', async () => {
    expect(await enqueueAttachments({ jobId: 'j', orgId: 'o', dealIds: ['d1', 'd2'], fileIds: ['f1'], engagementId: 'n1' })).toBe(true);
    const op = chain.calls.find((c) => c.table === 'HubSpotFileQueue')!;
    expect(op.action).toBe('upsert');
    expect(op.payload).toEqual([
      { jobId: 'j', organizationId: 'o', dealId: 'd1', hubspotFileId: 'f1', sourceEngagementId: 'n1' },
      { jobId: 'j', organizationId: 'o', dealId: 'd2', hubspotFileId: 'f1', sourceEngagementId: 'n1' },
    ]);
  });
  it('returns false (does not throw) when the table is missing', async () => {
    resolver = () => ({ error: { message: 'relation "HubSpotFileQueue" does not exist' } });
    expect(await enqueueAttachments({ jobId: 'j', orgId: 'o', dealIds: ['d1'], fileIds: ['f1'], engagementId: 'n1' })).toBe(false);
  });
});

describe('drainFileQueue', () => {
  const base = { jobId: 'j', orgId: 'o', uploadedBy: 'u1' };

  it('sets the total on first run (queued + already processed) and imports a file', async () => {
    resolver = (op) => {
      if (op.table === 'HubSpotFileQueue' && op.selectOptions?.head) return { count: 2 };
      if (op.table === 'HubSpotFileQueue' && op.action === 'select') return { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] };
      return undefined;
    };
    const c = counters();
    skipWithReason(c, 'no_deal', 1);
    const r = await drainFileQueue({ ...base, client: client(), counts: c });
    expect(c.total).toBe(3);
    expect(r).toEqual({ done: false, note: null });
    expect(addFileToDeal).toHaveBeenCalledWith({
      dealId: 'd1', filename: 'CIM.pdf', buffer: Buffer.from('%PDF'), mimeType: 'application/pdf',
      uploadedBy: 'u1', hubspotFileId: 'f1',
    });
    expect(c).toMatchObject({ created: 1, processed: 2 });
    const upd = chain.calls.find((x) => x.table === 'HubSpotFileQueue' && x.action === 'update');
    expect(upd?.payload).toEqual({ status: 'done', reason: null, documentId: 'doc-1' });
  });

  it('done when nothing is pending', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head ? { data: [] } : { count: 0 });
    expect(await drainFileQueue({ ...base, client: client(), counts: counters() })).toEqual({ done: true, note: null });
  });

  it('reports a pending migration instead of failing', async () => {
    resolver = () => ({ error: { message: 'relation does not exist' } });
    expect(await drainFileQueue({ ...base, client: client(), counts: counters() })).toEqual({ done: true, note: MIGRATION_PENDING_NOTE });
  });

  it('skips files over the size limit before downloading', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] } : { count: 1 });
    const cl = client({ getFileMeta: vi.fn(async () => ({ ...pdfMeta, size: 500 * 1024 * 1024 })) });
    const c = counters();
    await drainFileQueue({ ...base, client: cl, counts: c });
    expect((cl as { getFileSignedUrl: ReturnType<typeof vi.fn> }).getFileSignedUrl).not.toHaveBeenCalled();
    expect(c.reasons).toEqual({ too_large: 1 });
  });

  it('skips file types Avise does not accept', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] } : { count: 1 });
    const c = counters();
    await drainFileQueue({ ...base, client: client({ getFileMeta: vi.fn(async () => ({ ...pdfMeta, extension: 'pptx' })) }), counts: c });
    expect(c.reasons).toEqual({ unsupported_type: 1 });
    expect(addFileToDeal).not.toHaveBeenCalled();
  });

  it('on a missing scope: skips all remaining files and says which scopes', async () => {
    resolver = (op) => {
      if (op.table === 'HubSpotFileQueue' && op.action === 'update') return { count: 4 };
      if (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head) {
        return { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] };
      }
      return { count: 4 };
    };
    const c = counters();
    const r = await drainFileQueue({
      ...base, counts: c,
      client: client({ getFileMeta: vi.fn(async () => { throw new HubSpotScopeError('files, files.ui_hidden.read', 403); }) }),
    });
    expect(r.done).toBe(true);
    expect(r.note).toContain('files, files.ui_hidden.read');
    expect(c.reasons).toEqual({ missing_scope: 4 });
  });

  it('a failing file is marked failed and the drain continues', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }, { id: 'q2', dealId: 'd1', hubspotFileId: 'f2' }] } : { count: 2 });
    addFileToDeal.mockRejectedValueOnce(new Error('Storage upload failed: x')).mockResolvedValueOnce({ outcome: 'existing', documentId: 'doc-2' });
    const c = counters();
    await drainFileQueue({ ...base, client: client(), counts: c });
    expect(c).toMatchObject({ failed: 1, updated: 1, processed: 2 });
  });

  it('stops at the time budget and leaves the rest pending', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }, { id: 'q2', dealId: 'd1', hubspotFileId: 'f2' }] } : { count: 2 });
    let t = 0;
    const r = await drainFileQueue({ ...base, client: client(), counts: counters(), budgetMs: 10, now: () => (t += 20) });
    expect(r).toEqual({ done: false, note: null });
    expect(addFileToDeal).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-file-queue.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `apps/api/src/services/hubspot/fileQueue.ts`**

```ts
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { addFileToDeal } from '../documentStore.js';
import { getExpectedMimeType, FILE_SIZE_LIMITS } from '../fileValidator.js';
import { HubSpotScopeError, type HubSpotClient } from './client.js';
import type { ImportCounters } from './types.js';

// Files attached to deals. The engagement phases enqueue (deal, file) pairs;
// the final `files` phase drains the queue a few files at a time so a slow
// download can't stall the CRM import or overrun the serverless time limit.

export const MIGRATION_PENDING_NOTE =
  'files: not imported — database migration pending (apps/api/hubspot-relationships-files-migration.sql).';

/** Count `n` skipped records with `reason` (skips also count as processed). */
export function skipWithReason(c: ImportCounters, reason: string, n = 1): void {
  if (n <= 0) return;
  c.skipped += n;
  c.processed += n;
  c.reasons = { ...(c.reasons ?? {}), [reason]: (c.reasons?.[reason] ?? 0) + n };
}

/** Append notes to the job's message (" | "-separated), never twice. */
export function mergeNotes(existing: string | null, notes: string[]): string | null {
  const parts = existing ? existing.split(' | ') : [];
  for (const n of notes) if (!parts.includes(n)) parts.push(n);
  return parts.length ? parts.join(' | ') : null;
}

/** Queue each (deal, file) pair. Returns false (never throws) if the queue can't be written. */
export async function enqueueAttachments(input: {
  jobId: string; orgId: string; dealIds: string[]; fileIds: string[]; engagementId: string;
}): Promise<boolean> {
  const rows = input.dealIds.flatMap((dealId) => input.fileIds.map((hubspotFileId) => ({
    jobId: input.jobId, organizationId: input.orgId, dealId, hubspotFileId, sourceEngagementId: input.engagementId,
  })));
  if (rows.length === 0) return true;
  const { error } = await supabase
    .from('HubSpotFileQueue')
    .upsert(rows, { onConflict: 'jobId,dealId,hubspotFileId', ignoreDuplicates: true });
  if (error) {
    log.warn(`[hubspot] could not queue attachments for engagement ${input.engagementId}: ${(error as { message?: string }).message}`);
    return false;
  }
  return true;
}

type FileClient = Pick<HubSpotClient, 'getFileMeta' | 'getFileSignedUrl' | 'downloadSignedUrl'>;
type FileOutcome = { status: 'done'; documentId: string; created: boolean } | { status: 'skipped'; reason: string };

async function importOneFile(
  client: FileClient, row: { dealId: string; hubspotFileId: string }, uploadedBy: string | null,
): Promise<FileOutcome> {
  const meta = await client.getFileMeta(row.hubspotFileId);
  if (!meta) return { status: 'skipped', reason: 'not_found' };
  const ext = meta.extension?.toLowerCase() ?? null;
  const filename = ext && !meta.name.toLowerCase().endsWith(`.${ext}`) ? `${meta.name}.${ext}` : meta.name;
  const mimeType = getExpectedMimeType(filename);
  if (!mimeType) return { status: 'skipped', reason: 'unsupported_type' };
  const limit = FILE_SIZE_LIMITS[mimeType] ?? FILE_SIZE_LIMITS.default;
  if (meta.size != null && meta.size > limit) return { status: 'skipped', reason: 'too_large' };

  const url = await client.getFileSignedUrl(row.hubspotFileId);
  const buffer = await client.downloadSignedUrl(url);
  if (buffer.length > limit) return { status: 'skipped', reason: 'too_large' };

  const res = await addFileToDeal({
    dealId: row.dealId, filename, buffer, mimeType, uploadedBy, hubspotFileId: row.hubspotFileId,
  });
  if (res.outcome === 'rejected') return { status: 'skipped', reason: 'invalid_file' };
  return { status: 'done', documentId: res.documentId, created: res.outcome === 'created' };
}

async function markRow(id: string, status: 'done' | 'skipped' | 'failed', reason: string | null, documentId: string | null) {
  await supabase.from('HubSpotFileQueue').update({ status, reason, documentId }).eq('id', id);
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/**
 * Import up to `maxFiles` queued files, stopping early at `budgetMs`.
 * `done` = nothing left for this job; `note` = a message for the job (or null).
 */
export async function drainFileQueue(opts: {
  jobId: string; orgId: string; client: FileClient; uploadedBy: string | null; counts: ImportCounters;
  budgetMs?: number; maxFiles?: number; now?: () => number;
}): Promise<{ done: boolean; note: string | null }> {
  const { jobId, client, uploadedBy, counts } = opts;
  const budgetMs = opts.budgetMs ?? 60_000;
  const maxFiles = opts.maxFiles ?? 10;
  const now = opts.now ?? Date.now;
  const started = now();

  if (counts.total === undefined || counts.total === null) {
    const { count, error } = await supabase
      .from('HubSpotFileQueue').select('id', { count: 'exact', head: true }).eq('jobId', jobId);
    if (error) return { done: true, note: MIGRATION_PENDING_NOTE };
    // Already processed here = attachments skipped (no deal) or failed to queue.
    counts.total = (count ?? 0) + counts.processed;
  }

  const { data: rows, error } = await supabase
    .from('HubSpotFileQueue').select('id, dealId, hubspotFileId')
    .eq('jobId', jobId).eq('status', 'pending')
    .order('createdAt', { ascending: true }).limit(maxFiles);
  if (error) return { done: true, note: MIGRATION_PENDING_NOTE };
  const pending = (rows ?? []) as Array<{ id: string; dealId: string; hubspotFileId: string }>;
  if (pending.length === 0) return { done: true, note: null };

  for (const row of pending) {
    if (now() - started >= budgetMs) return { done: false, note: null };
    try {
      const out = await importOneFile(client, row, uploadedBy);
      if (out.status === 'done') {
        await markRow(row.id, 'done', null, out.documentId);
        if (out.created) counts.created += 1; else counts.updated += 1;
        counts.processed += 1;
      } else {
        await markRow(row.id, 'skipped', out.reason, null);
        skipWithReason(counts, out.reason);
      }
    } catch (err) {
      if (err instanceof HubSpotScopeError) {
        const { count } = await supabase
          .from('HubSpotFileQueue').update({ status: 'skipped', reason: 'missing_scope' }, { count: 'exact' })
          .eq('jobId', jobId).eq('status', 'pending');
        skipWithReason(counts, 'missing_scope', count ?? 0);
        return {
          done: true,
          note: `files: skipped — your HubSpot token is missing the ${err.scopes} scopes. Add them to the Private App, then run the import again.`,
        };
      }
      log.warn(`[hubspot] file ${row.hubspotFileId} for deal ${row.dealId} failed: ${shortError(err)}`);
      await markRow(row.id, 'failed', shortError(err), null);
      counts.failed += 1;
      counts.processed += 1;
    }
  }
  return { done: false, note: null };
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `cd apps/api && npx vitest run tests/hubspot-file-queue.test.ts && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

Note on the chain mock: `update(payload, { count: 'exact' })` passes `{count}` as a second argument, which `supabaseChainMock`'s `update` ignores. That's fine. The resolver returns `{ count: 4 }` for the update op.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hubspot/fileQueue.ts apps/api/tests/hubspot-file-queue.test.ts
git commit -m "feat(hubspot): queue and import files attached to deals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire it into the import engine

**Files:**
- Modify: `apps/api/src/services/hubspot/importEngine.ts`
- Test: `apps/api/tests/hubspot-engine-relationships.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/hubspot-engine-relationships.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const listPage = vi.fn();
const listOwners = vi.fn();
vi.mock('../src/services/hubspot/client.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/client.js')>();
  return {
    ...real,
    HubSpotClient: vi.fn().mockImplementation(function () {
      return {
        listPage, listOwners,
        listPropertyNames: vi.fn(async () => ['dealname']),
        listDealStageLabels: vi.fn(async () => ({})),
        countObjects: vi.fn(async () => null),
      };
    }),
  };
});
const upsertByHubspotId = vi.fn(async () => 'created');
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: (...a: unknown[]) => upsertByHubspotId(...a),
  upsertContactInteractionByHubspotId: vi.fn(async () => 'created'),
  upsertDealActivityByHubspotId: vi.fn(async () => 'created'),
}));
vi.mock('../src/services/dealDuplicates.js', () => ({
  loadLiveDealIndex: vi.fn(async () => new Map()),
  normaliseCompanyName: (s: string) => s.toLowerCase(),
}));
const linkDealContacts = vi.fn(async () => 2);
const applyDealOwner = vi.fn(async () => 'set');
vi.mock('../src/services/hubspot/dealRelations.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/dealRelations.js')>();
  return {
    ...real,
    linkDealContacts: (...a: unknown[]) => linkDealContacts(...a),
    applyDealOwner: (...a: unknown[]) => applyDealOwner(...a),
    loadOrgUsersByEmail: vi.fn(async () => new Map([['ann@x.com', 'user-ann']])),
  };
});
const enqueueAttachments = vi.fn(async () => true);
const drainFileQueue = vi.fn();
vi.mock('../src/services/hubspot/fileQueue.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/fileQueue.js')>();
  return {
    ...real,
    enqueueAttachments: (...a: unknown[]) => enqueueAttachments(...a),
    drainFileQueue: (...a: unknown[]) => drainFileQueue(...a),
  };
});

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

const ALL = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks', 'files'];
const freshCounts = () => Object.fromEntries(ALL.map((o) => [o, { processed: 0, created: 0, updated: 0, failed: 0, skipped: 0, total: null }]));

function jobRow(currentObject: string, extra: Record<string, unknown> = {}) {
  return { id: 'job-1', organizationId: 'org-1', status: 'running', objectCounts: freshCounts(), currentObject, cursor: null, error: null, startedBy: 'user-starter', ...extra };
}

/** The objectCounts written by the job's final update in this batch. */
function lastJobUpdate() {
  const ups = chain.calls.filter((c) => c.table === 'ImportJob' && c.action === 'update');
  return ups[ups.length - 1]?.payload as Record<string, unknown>;
}

beforeEach(() => {
  chain.calls.length = 0;
  resetStageLabelCache();
  listPage.mockReset();
  listOwners.mockReset().mockResolvedValue([{ id: 'own-1', email: 'Ann@x.com', name: 'Ann Lee' }]);
  upsertByHubspotId.mockClear();
  linkDealContacts.mockClear();
  applyDealOwner.mockClear();
  enqueueAttachments.mockClear();
  drainFileQueue.mockReset();
});

describe('deals phase — relationships', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('deals') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      if (op.table === 'Company') {
        return { data: filterValue(op, 'hubspotId') === 'c-primary' ? { id: 'co-1', name: 'Acme' } : { id: 'co-2', name: 'Beta Holdings' } };
      }
      if (op.table === 'Deal') return { data: { id: 'deal-1' } };
      if (op.table === 'Contact') return { data: { id: `local-${filterValue(op, 'hubspotId')}` } };
      return undefined;
    };
    listPage.mockResolvedValue({
      nextCursor: null,
      results: [{
        id: 'hs-d1',
        properties: { dealname: 'Acme deal', hubspot_owner_id: 'own-1' },
        associations: {
          companies: { results: [{ id: 'c-other', type: 'deal_to_company_unlabeled' }, { id: 'c-primary', type: 'deal_to_company' }] },
          contacts: { results: [{ id: 'p1' }, { id: 'p2' }] },
        },
      }],
    });
  });

  it('uses the primary company and records the others + owner on the HubSpot card', async () => {
    await runImportBatch('job-1', 'tok');
    const [, , , row] = upsertByHubspotId.mock.calls.find((c) => c[0] === 'Deal')!;
    expect(row).toMatchObject({
      companyId: 'co-1',
      hubspotProperties: expect.objectContaining({ hubspot_owner: 'Ann Lee <Ann@x.com>', associated_companies: 'Beta Holdings' }),
    });
  });

  it('links the deal to its contacts and counts the new links', async () => {
    await runImportBatch('job-1', 'tok');
    expect(linkDealContacts).toHaveBeenCalledWith('deal-1', ['local-p1', 'local-p2']);
    expect((lastJobUpdate().objectCounts as Record<string, { contactLinks?: number }>).deals.contactLinks).toBe(2);
  });

  it('matches the owner by email to an Avise user and counts it', async () => {
    await runImportBatch('job-1', 'tok', 'fill');
    expect(applyDealOwner).toHaveBeenCalledWith({ dealId: 'deal-1', ownerUserId: 'user-ann', mode: 'fill' });
    expect((lastJobUpdate().objectCounts as Record<string, { ownersMatched?: number }>).deals.ownersMatched).toBe(1);
  });

  it('owners scope missing: deal still imports, job gets a note naming the scope', async () => {
    const { HubSpotScopeError } = await import('../src/services/hubspot/client.js');
    listOwners.mockRejectedValue(new HubSpotScopeError('crm.objects.owners.read', 403));
    await runImportBatch('job-1', 'tok');
    expect(upsertByHubspotId).toHaveBeenCalled();
    expect(applyDealOwner).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: null }));
    expect(String(lastJobUpdate().error)).toContain('crm.objects.owners.read');
  });

  it('a relationship failure does not fail the deal', async () => {
    linkDealContacts.mockRejectedValueOnce(new Error('ContactDeal link failed: x'));
    await runImportBatch('job-1', 'tok');
    const deals = (lastJobUpdate().objectCounts as Record<string, { failed: number; created: number }>).deals;
    expect(deals).toMatchObject({ failed: 0, created: 1 });
  });
});

describe('engagement phase — attachments', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('notes') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      if (op.table === 'Contact') return { data: { id: 'local-contact' } };
      if (op.table === 'Deal') return { data: filterValue(op, 'hubspotId') === 'hs-deal' ? { id: 'deal-1' } : null };
      return undefined;
    };
  });

  it('queues attachments for the deal even when the note attaches to a contact', async () => {
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n1', properties: { hs_note_body: 'x', hs_attachment_ids: 'f1;f2' },
      associations: { contacts: { results: [{ id: 'pc' }] }, deals: { results: [{ id: 'hs-deal' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    expect(enqueueAttachments).toHaveBeenCalledWith({ jobId: 'job-1', orgId: 'org-1', dealIds: ['deal-1'], fileIds: ['f1', 'f2'], engagementId: 'n1' });
  });

  it('attachments with no deal are skipped with reason no_deal', async () => {
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n2', properties: { hs_attachment_ids: 'f9' },
      associations: { contacts: { results: [{ id: 'pc' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    expect(enqueueAttachments).not.toHaveBeenCalled();
    const files = (lastJobUpdate().objectCounts as Record<string, { skipped: number; reasons?: Record<string, number> }>).files;
    expect(files).toMatchObject({ skipped: 1, reasons: { no_deal: 1 } });
  });

  it('a queue failure never fails the engagement', async () => {
    enqueueAttachments.mockResolvedValueOnce(false);
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n3', properties: { hs_attachment_ids: 'f1' },
      associations: { deals: { results: [{ id: 'hs-deal' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    const c = lastJobUpdate().objectCounts as Record<string, { failed: number }>;
    expect(c.notes.failed).toBe(0);
    expect(c.files.failed).toBe(1);
  });

  it('after tasks, the job moves on to files (not completed)', async () => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('tasks') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      return undefined;
    };
    listPage.mockResolvedValue({ nextCursor: null, results: [] });
    expect(await runImportBatch('job-1', 'tok')).toBe(true);
    expect(lastJobUpdate()).toMatchObject({ currentObject: 'files', status: 'running' });
  });
});

describe('files phase', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('files') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      return undefined;
    };
  });

  it('drains with the starter as uploader and keeps going while files remain', async () => {
    drainFileQueue.mockResolvedValue({ done: false, note: null });
    expect(await runImportBatch('job-1', 'tok')).toBe(true);
    expect(drainFileQueue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', orgId: 'org-1', uploadedBy: 'user-starter' }));
    expect(listPage).not.toHaveBeenCalled();
    expect(lastJobUpdate()).toMatchObject({ currentObject: 'files', status: 'running' });
  });

  it('completes the job when the queue is empty and keeps the note', async () => {
    drainFileQueue.mockResolvedValue({ done: true, note: 'files: skipped — scopes' });
    expect(await runImportBatch('job-1', 'tok')).toBe(false);
    expect(lastJobUpdate()).toMatchObject({ status: 'completed', currentObject: null, error: 'files: skipped — scopes' });
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-engine-relationships.test.ts`
Expected: FAIL (no relations or files wiring yet).

- [ ] **Step 3: Implement the engine changes**

Edit `apps/api/src/services/hubspot/importEngine.ts`:

**3a. Imports and constants.** Replace lines 3–13 (imports through `const BATCH = 100;`) with:

```ts
import { HubSpotClient, HubSpotScopeError } from './client.js';
import { mapCompany, mapContact, mapDeal } from './mappers.js';
import { mapEngagement } from './engagementMappers.js';
import { upsertByHubspotId, upsertContactInteractionByHubspotId, upsertDealActivityByHubspotId, type ImportMode, type RecordUpsertResult } from './dedup.js';
import { escapeIlike } from './ilike.js';
import { loadLiveDealIndex, normaliseCompanyName, type DealMatch } from '../dealDuplicates.js';
import { linkDealContacts, loadOrgUsersByEmail, applyDealOwner, ownerLabel } from './dealRelations.js';
import { enqueueAttachments, drainFileQueue, skipWithReason, mergeNotes } from './fileQueue.js';
import type { EngagementType, HubSpotObjectType, HubSpotOwner, ImportCounters, ImportPhase } from './types.js';

/** HubSpot objects, in import order. Companies first: contacts and deals reference them. */
const HUBSPOT_ORDER: HubSpotObjectType[] = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks'];
/** Every phase of a job: the HubSpot objects, then downloading queued files. */
const PHASES: ImportPhase[] = [...HUBSPOT_ORDER, 'files'];
const BATCH = 100;
```

(`ENGAGEMENT_TYPES` was unused; drop it. If `tsc` says it's used, keep it.)

**3b. Owner cache.** Below `const stageLabelCache = ...`, add:

```ts
/** HubSpot owners per job (null = unavailable, e.g. missing scope). Same lifetime as stageLabelCache. */
const ownerCache = new Map<string, Map<string, HubSpotOwner> | null>();
```

Change `resetStageLabelCache` to clear both:

```ts
export function resetStageLabelCache(): void {
  stageLabelCache.clear();
  ownerCache.clear();
}
```

**3c. Counters type.** Replace the whole `interface Counters { ... }` block with:

```ts
type Counters = ImportCounters;
```

**3d. loadJob type.** Add `startedBy?: string | null;` to the object type returned by `loadJob`.

**3e. Cache cleanup.** In `runImportBatch`, change `if (!more) stageLabelCache.delete(jobId);` to:

```ts
  if (!more) { stageLabelCache.delete(jobId); ownerCache.delete(jobId); }
```

**3f. Batch setup** (inside `runImportBatchInner`):

- Change `ORDER.forEach((o) => { if (!counts[o]) counts[o] = emptyCounters(); });` to:

```ts
  PHASES.forEach((o) => { if (!counts[o]) counts[o] = emptyCounters(); });
  /** Messages for the job (missing scopes etc.), merged into ImportJob.error when saving. */
  const notes: string[] = [];
```

- After the `dealIdForHubspotIdCached` function, add:

```ts
  // HubSpot owners, once per job. A missing scope skips owner matching with a
  // note; the rest of the import carries on.
  async function ownersFor(): Promise<Map<string, HubSpotOwner>> {
    if (ownerCache.has(jobId)) return ownerCache.get(jobId) ?? new Map();
    try {
      const map = new Map((await client.listOwners()).map((o) => [o.id, o] as const));
      ownerCache.set(jobId, map);
      return map;
    } catch (err) {
      ownerCache.set(jobId, null);
      notes.push(err instanceof HubSpotScopeError
        ? `deal owners: skipped — your HubSpot token is missing the ${err.scopes} scope. Add it to the Private App to fill in Lead Partners.`
        : `deal owners: not loaded (${shortError(err)}).`);
      return new Map();
    }
  }

  // Avise users by email, once per batch, for owner → Lead Partner matching.
  let orgUsers: Promise<Map<string, string>> | null = null;
  function orgUsersFor(orgId: string) {
    orgUsers ??= loadOrgUsersByEmail(orgId);
    return orgUsers;
  }
```

- Change `const missingTotals = ORDER.filter(...)` to `const missingTotals = HUBSPOT_ORDER.filter(...)`. Leave the loop body unchanged. `files` gets its total from the queue, not HubSpot.

- Replace:

```ts
  const current = (job.currentObject as HubSpotObjectType) ?? ORDER[0];
  const objectIndex = ORDER.indexOf(current);
```

with:

```ts
  const current = (job.currentObject as ImportPhase) ?? PHASES[0];
  const objectIndex = PHASES.indexOf(current);

  // Final phase: download files queued during the engagement phases.
  if (current === 'files') {
    const { done, note } = await drainFileQueue({
      jobId, orgId: job.organizationId, client, uploadedBy: job.startedBy ?? null, counts: counts.files,
    });
    if (note) notes.push(note);
    const error = mergeNotes(job.error ?? null, notes);
    if (!done) {
      const { data: updated } = await supabase.from('ImportJob')
        .update({ objectCounts: counts, currentObject: 'files', cursor: null, status: 'running', error })
        .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
      return !!updated;
    }
    await supabase.from('ImportJob')
      .update({ objectCounts: counts, currentObject: null, cursor: null, status: 'completed', error, finishedAt: new Date().toISOString() })
      .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
    return false;
  }
```

- In the fetch-failure `catch`, change `const nextObject = ORDER[objectIndex + 1] ?? null;` to `const nextObject = PHASES[objectIndex + 1] ?? null;`. (After a failed `tasks` fetch, the job still advances to `files`.)

**3g. Deals branch.** Replace the deals branch's `upsertByHubspotId('Deal', ...)` call — from `const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {` through `}, { column: 'name', value: m.name, adoptId: candidate?.id ?? null }, mode);` — with:

```ts
        // Owner (readable) and the deal's other companies go on the HubSpot card.
        const owner = m.ownerHubspotId ? (await ownersFor()).get(m.ownerHubspotId) ?? null : null;
        const otherCompanyNames = await Promise.all(m.otherCompanyHubspotIds.map(async (hsId) =>
          (await companyNameForHubspotIdCached(job.organizationId, hsId)) ?? `HubSpot company ${hsId}`));
        const hubspotProperties = {
          ...m.hubspotProperties,
          ...(owner ? { hubspot_owner: ownerLabel(owner) } : {}),
          ...(otherCompanyNames.length ? { associated_companies: otherCompanyNames.join(', ') } : {}),
        };
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          // Omit when unmapped: Deal.stage is NOT NULL and a null would either
          // fail the write or reset the deal to the INITIAL_REVIEW default.
          ...(m.stage ? { stage: m.stage } : {}),
          customFields: m.customFields, hubspotProperties,
        }, { column: 'name', value: m.name, adoptId: candidate?.id ?? null }, mode);
```

After the existing `if (res === 'linked' && candidate) { ... }` block (still inside the deals branch), add:

```ts
        // Contacts on the deal and owner → Lead Partner. These need the Avise
        // deal id, and a failure here must not count the deal itself as failed.
        try {
          const dealId = await dealIdForHubspotId(job.organizationId, m.hubspotId);
          if (dealId) {
            const contactIds = (await Promise.all(
              m.contactHubspotIds.map((hsId) => contactIdForHubspotIdCached(job.organizationId, hsId)),
            )).filter((id): id is string => id !== null);
            const newLinks = await linkDealContacts(dealId, contactIds);
            if (newLinks > 0) counts.deals.contactLinks = (counts.deals.contactLinks ?? 0) + newLinks;

            const ownerUserId = owner?.email ? (await orgUsersFor(job.organizationId)).get(owner.email.toLowerCase()) ?? null : null;
            const ownerResult = await applyDealOwner({ dealId, ownerUserId, mode });
            if (ownerResult === 'set' || ownerResult === 'already') {
              counts.deals.ownersMatched = (counts.deals.ownersMatched ?? 0) + 1;
            }
          }
        } catch (err) {
          log.warn(`[hubspot] deal ${m.hubspotId}: contacts/owner not linked: ${(err as Error).message}`);
        }
```

**3h. Engagement branch.** In the engagement `else` branch, after the closing `}` of `if (resolvedContactIds.length > 0) { ... } else { ... }`, add:

```ts
        // Files attached to this activity go to the deal(s) it's on — whether
        // the activity itself landed on a contact or a deal above.
        if (m.attachmentIds.length > 0) {
          try {
            const attachmentDealIds = (await Promise.all(
              m.associatedDealHubspotIds.map((hsId) => dealIdForHubspotIdCached(job.organizationId, hsId)),
            )).filter((id): id is string => id !== null);
            if (attachmentDealIds.length === 0) {
              skipWithReason(counts.files, 'no_deal', m.attachmentIds.length);
            } else if (!(await enqueueAttachments({
              jobId, orgId: job.organizationId, dealIds: attachmentDealIds, fileIds: m.attachmentIds, engagementId: m.hubspotId,
            }))) {
              counts.files.failed += m.attachmentIds.length;
              counts.files.processed += m.attachmentIds.length;
            }
          } catch (err) {
            log.warn(`[hubspot] attachments on ${current} ${m.hubspotId} not queued: ${(err as Error).message}`);
            counts.files.failed += m.attachmentIds.length;
            counts.files.processed += m.attachmentIds.length;
          }
        }
```

**3i. Saving the batch.** In the three `ImportJob` updates after the record loop (the `page.nextCursor` branch, the `nextObject` branch and the final `completed` update):
- Add `error: mergeNotes(job.error ?? null, notes)` to each `.update({...})` payload.
- Change `const nextObject = ORDER[objectIndex + 1] ?? null;` to `const nextObject = PHASES[objectIndex + 1] ?? null;`.

- [ ] **Step 4: Run the new test — expect pass**

Run: `cd apps/api && npx vitest run tests/hubspot-engine-relationships.test.ts`
Expected: PASS.

- [ ] **Step 5: Run every HubSpot test + typecheck**

Run: `cd apps/api && npx vitest run tests/hubspot- tests/integrations && npx tsc --noEmit`
Expected: PASS and `tsc` clean. Older engine tests that assert the job **completes** after `tasks` must change: the job now advances to `files`, then completes on the next batch. Update those assertions to expect `currentObject: 'files'` with `status: 'running'`. Don't weaken any other assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/hubspot/importEngine.ts apps/api/tests/hubspot-engine-relationships.test.ts apps/api/tests/hubspot-*.test.ts
git commit -m "feat(hubspot): import deal contacts, owners, primary company and files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Required scopes

**Files:**
- Modify: `apps/api/src/routes/hubspot-import.ts:26-29`
- Test: `apps/api/tests/hubspot-routes.test.ts`

- [ ] **Step 1: Add the failing assertions**

In `apps/api/tests/hubspot-routes.test.ts`, in the test `POST /connect maps MISSING_SCOPES to a message listing the required scopes`, add after the last `expect(...)`:

```ts
    expect(res.body.error).toContain('crm.objects.owners.read');
    expect(res.body.error).toContain('files.ui_hidden.read');
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: FAIL on the two new assertions.

- [ ] **Step 3: Update `REQUIRED_SCOPES`**

```ts
// Owners (Lead Partner) and files (attachments) are optional: a token without
// them still imports everything else, and the import says which scope to add.
const REQUIRED_SCOPES =
  'crm.objects.companies.read, crm.objects.contacts.read, crm.objects.deals.read, '
  + 'crm.objects.notes.read, crm.objects.calls.read, crm.objects.meetings.read, crm.objects.emails.read, crm.objects.tasks.read, '
  + 'crm.schemas.companies.read, crm.schemas.contacts.read, crm.schemas.deals.read, '
  + 'crm.objects.owners.read, files, files.ui_hidden.read';
```

- [ ] **Step 4: Run — expect pass, then commit**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: PASS.

```bash
git add apps/api/src/routes/hubspot-import.ts apps/api/tests/hubspot-routes.test.ts
git commit -m "feat(hubspot): list owner and file scopes in connect help

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: API routes — deal contacts and "index pending documents"

**Files:**
- Create: `apps/api/src/routes/deals-contacts.ts`
- Create: `apps/api/src/routes/deals-documents-index.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/app-lite.ts`
- Test: `apps/api/tests/deals-contacts.test.ts`, `apps/api/tests/deals-documents-index.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/api/tests/deals-contacts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1', verifyDealAccess: (...a: unknown[]) => verifyDealAccess(...a) }));

import router from '../src/routes/deals-contacts.js';

const app = express();
app.use('/api/deals', router);

beforeEach(() => { chain.calls.length = 0; verifyDealAccess.mockReset(); });

describe('GET /api/deals/:dealId/contacts', () => {
  it('404s for a deal outside the org', async () => {
    verifyDealAccess.mockResolvedValue(false);
    const res = await request(app).get('/api/deals/d-x/contacts');
    expect(res.status).toBe(404);
    expect(chain.calls.some((c) => c.table === 'ContactDeal')).toBe(false);
  });

  it('returns linked contacts with their role', async () => {
    verifyDealAccess.mockResolvedValue(true);
    resolver = (op) => (op.table === 'ContactDeal' ? { data: [
      { role: 'BANKER', contact: { id: 'c1', firstName: 'Ann', lastName: 'Lee', email: 'a@x.com', title: 'MD', company: 'Bank' } },
      { role: 'OTHER', contact: null },
    ] } : undefined);
    const res = await request(app).get('/api/deals/d1/contacts');
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([
      { id: 'c1', firstName: 'Ann', lastName: 'Lee', email: 'a@x.com', title: 'MD', company: 'Bank', role: 'BANKER' },
    ]);
    expect(filterValue(chain.calls[0], 'dealId')).toBe('d1');
  });
});
```

`apps/api/tests/deals-documents-index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1', verifyDealAccess: (...a: unknown[]) => verifyDealAccess(...a) }));
const embedDocument = vi.fn();
vi.mock('../src/rag.js', () => ({ embedDocument: (...a: unknown[]) => embedDocument(...a) }));

import router from '../src/routes/deals-documents-index.js';

const app = express();
app.use(express.json());
app.use('/api/deals', router);

beforeEach(() => { chain.calls.length = 0; verifyDealAccess.mockReset().mockResolvedValue(true); embedDocument.mockReset(); });

describe('GET /api/deals/:dealId/documents/index-pending', () => {
  it('counts documents with text that are not indexed yet', async () => {
    resolver = (op) => (op.table === 'Document' ? { count: 3 } : undefined);
    const res = await request(app).get('/api/deals/d1/documents/index-pending');
    expect(res.body).toEqual({ pending: 3 });
    const op = chain.calls[0];
    expect(op.filters).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['dealId', 'd1'] },
      { method: 'is', args: ['embeddingStatus', null] },
    ]));
  });

  it('404s outside the org', async () => {
    verifyDealAccess.mockResolvedValue(false);
    expect((await request(app).get('/api/deals/d1/documents/index-pending')).status).toBe(404);
  });
});

describe('POST /api/deals/:dealId/documents/index-pending', () => {
  it('embeds pending documents and reports what is left', async () => {
    resolver = (op) => {
      if (op.table === 'Document' && op.selectOptions?.head) return { count: 0 };
      if (op.table === 'Document') return { data: [{ id: 'doc1', extractedText: 'a' }, { id: 'doc2', extractedText: 'b' }] };
      return undefined;
    };
    embedDocument.mockResolvedValueOnce({ success: true, chunkCount: 2 }).mockResolvedValueOnce({ success: false, chunkCount: 0, error: 'no model' });
    const res = await request(app).post('/api/deals/d1/documents/index-pending').send({});
    expect(res.body).toEqual({ indexed: 1, failed: 1, remaining: 0, error: 'no model' });
    expect(embedDocument).toHaveBeenCalledWith('doc1', 'd1', 'a');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/api && npx vitest run tests/deals-contacts.test.ts tests/deals-documents-index.test.ts`
Expected: FAIL (route modules missing).

- [ ] **Step 3: Create `apps/api/src/routes/deals-contacts.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

interface LinkRow {
  role: string;
  contact: { id: string; firstName: string; lastName: string; email: string | null; title: string | null; company: string | null } | null;
}

/**
 * GET /api/deals/:dealId/contacts — contacts linked to a deal (ContactDeal),
 * oldest link first. Org-scoped; another org's deal is a 404.
 */
router.get('/:dealId/contacts', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    const { data, error } = await supabase
      .from('ContactDeal')
      .select('role, createdAt, contact:Contact(id, firstName, lastName, email, title, company)')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: true });
    if (error) throw error;
    const contacts = ((data ?? []) as unknown as LinkRow[])
      .filter((r) => r.contact)
      .map((r) => ({ ...r.contact!, role: r.role }));
    res.json({ contacts });
  } catch (err) {
    log.error('GET deal contacts failed', err);
    res.status(500).json({ error: 'Could not load this deal\'s contacts' });
  }
});

export default router;
```

- [ ] **Step 4: Create `apps/api/src/routes/deals-documents-index.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';

const router = Router();

/** Stay well inside the 300s function limit; the client calls again for the rest. */
const INDEX_BUDGET_MS = 45_000;
const BATCH = 25;

/** Documents with extracted text that have never been indexed for chat (e.g. HubSpot imports). */
async function countPending(dealId: string): Promise<number> {
  const { count, error } = await supabase
    .from('Document').select('id', { count: 'exact', head: true })
    .eq('dealId', dealId).not('extractedText', 'is', null).is('embeddingStatus', null);
  if (error) throw error;
  return count ?? 0;
}

router.get('/:dealId/documents/index-pending', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    res.json({ pending: await countPending(dealId) });
  } catch (err) {
    log.error('GET index-pending failed', err);
    res.status(500).json({ error: 'Could not count documents waiting to be indexed' });
  }
});

/**
 * POST — index (embed) pending documents for Deal Chat. User-clicked AI, so it
 * runs regardless of AI_BACKGROUND_JOBS. Returns what's left; the client
 * repeats until `remaining` is 0.
 */
router.post('/:dealId/documents/index-pending', async (req: Request, res: Response) => {
  try {
    const { dealId } = req.params;
    if (!(await verifyDealAccess(dealId, getOrgId(req)))) return res.status(404).json({ error: 'Deal not found' });
    const { embedDocument } = await import('../rag.js');
    const { data, error } = await supabase
      .from('Document').select('id, extractedText')
      .eq('dealId', dealId).not('extractedText', 'is', null).is('embeddingStatus', null)
      .order('createdAt', { ascending: true }).limit(BATCH);
    if (error) throw error;

    const started = Date.now();
    let indexed = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const doc of (data ?? []) as Array<{ id: string; extractedText: string }>) {
      if (Date.now() - started > INDEX_BUDGET_MS) break;
      const r = await embedDocument(doc.id, dealId, doc.extractedText);
      if (r.success) indexed += 1;
      else { failed += 1; firstError ??= r.error ?? 'Indexing failed'; }
    }
    res.json({ indexed, failed, remaining: await countPending(dealId), error: firstError });
  } catch (err) {
    log.error('POST index-pending failed', err);
    res.status(500).json({ error: 'Could not index documents' });
  }
});

export default router;
```

- [ ] **Step 5: Mount both routers**

In **both** `apps/api/src/app.ts` and `apps/api/src/app-lite.ts`:
- Add the imports next to the other `./routes/deals-*` imports:

```ts
import dealsContactsRouter from './routes/deals-contacts.js';
import dealsDocumentsIndexRouter from './routes/deals-documents-index.js';
```

- Mount them **before** the line that mounts `dealsRouter` at `/api/deals` (`app.ts` ~line 445, `app-lite.ts` ~line 363), using the same middleware chain as the neighbouring `/api/deals` mounts:

```ts
app.use('/api/deals', authMiddleware, enforceApiKeyScope, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsContactsRouter);
app.use('/api/deals', authMiddleware, enforceApiKeyScope, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsDocumentsIndexRouter);
```

`pickBundle` (`apps/web-next/src/lib/api-routing.ts`) sends `/api/deals/:id/contacts` and `/api/deals/:id/documents/...` to `lite`, because neither suffix is in its AI list. No change is needed there.

- [ ] **Step 6: Run tests + bundle parity + typecheck**

Run: `cd apps/api && npx vitest run tests/deals-contacts.test.ts tests/deals-documents-index.test.ts tests/bundle-route-parity.test.ts && npx tsc --noEmit`
Expected: PASS and `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/deals-contacts.ts apps/api/src/routes/deals-documents-index.ts apps/api/src/app.ts apps/api/src/app-lite.ts apps/api/tests/deals-contacts.test.ts apps/api/tests/deals-documents-index.test.ts
git commit -m "feat(deals): API for a deal's contacts and on-demand document indexing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: HubSpot panel — real status state and scope help

**Files:**
- Create: `apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotStatus.tsx`
- Modify: `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`
- Test: `apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx`

- [ ] **Step 1: Add the failing tests**

Append to the `describe("HubSpotPanel", ...)` block in `HubSpotPanel.test.tsx`:

```tsx
  it("shows the real error and Retry when the status check fails — never the connect form", async () => {
    let fail = true;
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") {
        return fail ? Promise.reject(new Error("Service unavailable")) : Promise.resolve({ connected: true });
      }
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: null });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText(/Couldn.t check your HubSpot connection/i)).toBeInTheDocument();
    expect(screen.getByText(/Service unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Connect HubSpot")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/HubSpot connected/i)).toBeInTheDocument();
  });

  it("lists the owner and file scopes in the connect help", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: false });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: null });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    render(<HubSpotPanel onToast={() => {}} />);
    expect(await screen.findByText("crm.objects.owners.read")).toBeInTheDocument();
    expect(screen.getByText("files.ui_hidden.read")).toBeInTheDocument();
  });
```

Add `fireEvent` to the `@testing-library/react` import at the top of the file.

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/settings/HubSpotPanel.test.tsx"`
Expected: the two new tests FAIL.

- [ ] **Step 3: Create `IntegrationsSection.hubspotStatus.tsx`**

```tsx
"use client";

// Small pieces of the HubSpot panel, kept out of IntegrationsSection.tsx
// (already over the 500-line guideline).

/** Scopes the HubSpot Private App needs. Owners/files are optional but recommended. */
export const HUBSPOT_REQUIRED_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read",
  "crm.objects.notes.read",
  "crm.objects.calls.read",
  "crm.objects.meetings.read",
  "crm.objects.emails.read",
  "crm.objects.tasks.read",
  "crm.objects.owners.read",
  "files",
  "files.ui_hidden.read",
] as const;

export function HubSpotScopeHelp() {
  return (
    <p className="mt-1 text-xs text-text-muted">
      HubSpot → Settings → Integrations → Private Apps. Under Scopes, grant{" "}
      {HUBSPOT_REQUIRED_SCOPES.map((s, i) => (
        <span key={s}>
          <code className="text-xs bg-gray-100 px-1 rounded">{s}</code>
          {i < HUBSPOT_REQUIRED_SCOPES.length - 1 ? ", " : ""}
        </span>
      ))}
      , plus the matching <code className="text-xs bg-gray-100 px-1 rounded">crm.schemas.*</code> scopes for
      companies, contacts and deals (needed to import your custom fields). The owners scope fills in Lead Partners;
      the two file scopes bring over files attached to deals.
    </p>
  );
}

export function HubSpotStatusError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm" role="alert">
      <p className="font-semibold text-red-800">Couldn&apos;t check your HubSpot connection.</p>
      <p className="mt-0.5 text-red-700">
        {message || "The server didn't answer."} Your connection and imports are unchanged — this only affects what
        this page can show.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-800 hover:bg-red-100"
      >
        Retry
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Update `HubSpotPanel` in `IntegrationsSection.tsx`**

1. Add the import:

```tsx
import { HubSpotScopeHelp, HubSpotStatusError } from "./IntegrationsSection.hubspotStatus";
```

2. Replace `const [connected, setConnected] = useState(false);` with:

```tsx
  // "disconnected" only when the server SAYS so — a failed check is "error"
  // (audit B12: it used to fall back to the connect form and look disconnected).
  const [status, setStatus] = useState<"loading" | "connected" | "disconnected" | "error">("loading");
  const [statusError, setStatusError] = useState<string | null>(null);
  const connected = status === "connected";
```

3. Add below the `startPolling` callback:

```tsx
  const fetchStatus = useCallback(
    () =>
      api.get<{ connected: boolean }>("/integrations/hubspot/connect")
        .then((r) => setStatus(r.connected ? "connected" : "disconnected"))
        .catch((err) => {
          setStatusError(err instanceof Error && err.message ? err.message : null);
          setStatus("error");
        }),
    [],
  );

  function retryStatus() {
    setStatus("loading");
    setStatusError(null);
    void fetchStatus();
  }
```

4. In the mount `useEffect`, replace:

```tsx
    api.get<{ connected: boolean }>("/integrations/hubspot/connect")
      .then((r) => setConnected(r.connected))
      .catch(() => {});
```

with:

```tsx
    void fetchStatus();
```

5. In `connect()`, replace `setConnected(r.connected);` with `setStatus(r.connected ? "connected" : "disconnected");`.
   In `disconnect()`, replace `setConnected(false);` with `setStatus("disconnected");`.
   Then run `grep -n "setConnected" "src/app/(app)/settings/IntegrationsSection.tsx"`. It must print nothing.

6. In the JSX, replace `{!connected ? (` with:

```tsx
      {status === "loading" ? (
        <p className="text-sm text-text-muted">Checking your HubSpot connection…</p>
      ) : status === "error" ? (
        <HubSpotStatusError message={statusError} onRetry={retryStatus} />
      ) : status === "disconnected" ? (
```

The existing `) : (` before the connected block and the closing `)}` stay as they are. The chain now ends with the connected UI as its final branch.

7. Replace the whole `<p className="mt-1 text-xs text-text-muted"> HubSpot → Settings → ... </p>` scope paragraph inside the connect form with:

```tsx
            <HubSpotScopeHelp />
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/settings/" && npx tsc --noEmit && npx eslint "src/app/(app)/settings/IntegrationsSection.tsx" "src/app/(app)/settings/IntegrationsSection.hubspotStatus.tsx"`
Expected: PASS, `tsc` clean, no new lint errors.

- [ ] **Step 6: Commit**

```bash
git add "apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx" "apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotStatus.tsx" "apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx"
git commit -m "fix(hubspot): a failed status check shows the error, not 'disconnected'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Progress panel — files row, links, owners, skip reasons

**Files:**
- Modify: `apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotProgress.tsx`
- Test: `apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx`

- [ ] **Step 1: Add the failing test**

Append to `HubSpotPanel.test.tsx`'s describe:

```tsx
  it("shows deal links, owners and the files row with skip reasons", async () => {
    const job = {
      ...RUNNING_JOB,
      status: "completed",
      currentObject: null,
      objectCounts: {
        deals: { processed: 8, created: 8, updated: 0, failed: 0, total: 8, contactLinks: 12, ownersMatched: 5 },
        files: { processed: 6, created: 3, updated: 1, failed: 0, skipped: 2, total: 6, reasons: { no_deal: 1, too_large: 1 } },
      },
    };
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job });
      if (path === "/integrations/hubspot/import/history") return Promise.resolve({ jobs: [] });
      throw new Error(`unexpected GET ${path}`);
    });
    render(<HubSpotPanel onToast={() => {}} />);
    expect(await screen.findByTestId("hubspot-deals-relations")).toHaveTextContent("12 contacts linked · 5 owners matched as Lead Partner");
    expect(screen.getByText("4 of 6 imported · 0 failed")).toBeInTheDocument();
    expect(screen.getByTestId("hubspot-files-skipped")).toHaveTextContent("2 skipped: not on a deal (1), too large (1)");
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/settings/HubSpotPanel.test.tsx"`
Expected: the new test FAILS.

- [ ] **Step 3: Implement in `IntegrationsSection.hubspotProgress.tsx`**

1. Add to `HubSpotJobCounts`:

```ts
  /** Deals: new deal↔contact links. */
  contactLinks?: number;
  /** Deals: deals whose HubSpot owner is their Avise Lead Partner. */
  ownersMatched?: number;
  /** Why records were skipped, e.g. { no_deal: 2 }. */
  reasons?: Record<string, number>;
```

2. Change `HUBSPOT_OBJECTS`:

```ts
export const HUBSPOT_OBJECTS = ["companies", "contacts", "deals", "notes", "calls", "meetings", "emails", "tasks", "files"] as const;
```

3. Add below `fmt`:

```ts
const SKIP_REASON_LABELS: Record<string, string> = {
  no_deal: "not on a deal",
  too_large: "too large",
  missing_scope: "missing HubSpot scope",
  unsupported_type: "file type Avise doesn't accept",
  invalid_file: "failed file checks",
  not_found: "deleted in HubSpot",
};

function skipSummary(c: HubSpotJobCounts): string | null {
  const skipped = c.skipped ?? 0;
  if (skipped <= 0) return null;
  const parts = Object.entries(c.reasons ?? {})
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${SKIP_REASON_LABELS[r] ?? r} (${fmt(n)})`);
  return `${fmt(skipped)} skipped${parts.length ? `: ${parts.join(", ")}` : ""}`;
}
```

4. In the per-object map, after the existing `{obj === "deals" && (c?.matched ?? 0) > 0 && (...)}` block, add:

```tsx
            {obj === "deals" && ((c?.contactLinks ?? 0) > 0 || (c?.ownersMatched ?? 0) > 0) && (
              <p className="text-[11px] text-text-muted" data-testid="hubspot-deals-relations">
                {fmt(c?.contactLinks ?? 0)} contacts linked · {fmt(c?.ownersMatched ?? 0)} owners matched as Lead Partner
              </p>
            )}
            {obj === "files" && c && skipSummary(c) && (
              <p className="text-[11px] text-text-muted" data-testid="hubspot-files-skipped">{skipSummary(c)}</p>
            )}
```

- [ ] **Step 4: Run tests, typecheck — expect pass**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/settings/" && npx tsc --noEmit`
Expected: PASS. Older jobs have no `files` key, so their row renders "—", as before.

- [ ] **Step 5: Commit**

```bash
git add "apps/web-next/src/app/(app)/settings/IntegrationsSection.hubspotProgress.tsx" "apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx"
git commit -m "feat(hubspot): progress shows files, contact links and owners

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deal page — Contacts section

**Files:**
- Create: `apps/web-next/src/app/(app)/deals/[id]/deal-contacts.tsx`
- Modify: `apps/web-next/src/app/(app)/deals/[id]/deal-overview.tsx`
- Test: `apps/web-next/src/app/(app)/deals/[id]/deal-contacts.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web-next/src/app/(app)/deals/[id]/deal-contacts.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { DealContactsSection } from "./deal-contacts";

beforeEach(() => get.mockReset());

describe("DealContactsSection", () => {
  it("lists linked contacts with role and email", async () => {
    get.mockResolvedValue({ contacts: [
      { id: "c1", firstName: "Ann", lastName: "Lee", email: "ann@bank.com", title: "MD", company: "Bank Co", role: "BANKER" },
    ] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    expect(screen.getByText("Banker")).toBeInTheDocument();
    expect(screen.getByText("MD · Bank Co")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ann@bank.com" })).toHaveAttribute("href", "mailto:ann@bank.com");
    expect(get).toHaveBeenCalledWith("/deals/d1/contacts");
  });

  it("explains the empty state", async () => {
    get.mockResolvedValue({ contacts: [] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText(/No contacts linked to this deal yet/)).toBeInTheDocument();
  });

  it("shows why it failed and retries", async () => {
    get.mockRejectedValueOnce(new Error("Could not load this deal's contacts")).mockResolvedValueOnce({ contacts: [] });
    render(<DealContactsSection dealId="d1" />);
    expect(await screen.findByText("Could not load this deal's contacts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No contacts linked to this deal yet/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/deals/[id]/deal-contacts.test.tsx"`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `deal-contacts.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface DealContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  title: string | null;
  company: string | null;
  role: string;
}

const ROLE_LABELS: Record<string, string> = {
  BANKER: "Banker",
  ADVISOR: "Advisor",
  BOARD_MEMBER: "Board member",
  MANAGEMENT: "Management",
  OTHER: "Contact",
};

/** Contacts linked to a deal (from a contact's page, or the HubSpot import). */
export function DealContactsSection({ dealId }: { dealId: string }) {
  const [contacts, setContacts] = useState<DealContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = useCallback(
    () =>
      api.get<{ contacts: DealContact[] }>(`/deals/${dealId}/contacts`)
        .then((r) => { setContacts(r.contacts ?? []); setError(null); })
        .catch((err) => setError(err instanceof Error && err.message ? err.message : "The server didn't answer.")),
    [dealId],
  );

  useEffect(() => { void fetchContacts(); }, [fetchContacts]);

  return (
    <section className="rounded-lg border border-border-subtle bg-white p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-[#003366]">group</span>
        <h3 className="text-sm font-semibold text-text-main">
          Contacts{contacts && contacts.length > 0 ? ` (${contacts.length})` : ""}
        </h3>
      </div>

      {error ? (
        <div className="text-sm">
          <p className="text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => { setError(null); void fetchContacts(); }}
            className="mt-1 text-xs font-semibold text-[#003366] hover:underline"
          >
            Retry
          </button>
        </div>
      ) : contacts === null ? (
        <p className="text-sm text-text-muted">Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="text-sm text-text-muted">
          No contacts linked to this deal yet. Link one from a contact&apos;s page, or import them from HubSpot.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {contacts.map((c) => {
            const name = `${c.firstName} ${c.lastName}`.trim() || c.email || "Unnamed contact";
            const sub = [c.title, c.company].filter(Boolean).join(" · ");
            return (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">{name}</p>
                  {sub && <p className="truncate text-xs text-text-muted">{sub}</p>}
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="text-xs text-[#003366] hover:underline">{c.email}</a>
                  )}
                </div>
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-text-secondary">
                  {ROLE_LABELS[c.role] ?? c.role}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Render it on the Overview tab**

In `deal-overview.tsx`:
- Add the import: `import { DealContactsSection } from "./deal-contacts";`
- In `OverviewTab`, between `<HubSpotFieldsCard ... />` and `<DealAccessTimeline ... />`, add:

```tsx
      <DealContactsSection dealId={deal.id} />
```

- [ ] **Step 5: Run tests, typecheck, icon-font test — expect pass**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/deals/[id]/" src/lib/iconFont && npx tsc --noEmit`
Expected: PASS. `group` is already in `iconFont.ts`.

- [ ] **Step 6: Commit**

```bash
git add "apps/web-next/src/app/(app)/deals/[id]/deal-contacts.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-contacts.test.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-overview.tsx"
git commit -m "feat(deals): show a deal's linked contacts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Deal page — "Index N documents for AI"

**Files:**
- Create: `apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.tsx`
- Modify: `apps/web-next/src/app/(app)/deals/[id]/deal-page-left-panel.tsx`
- Test: `apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));

import { IndexDocumentsForAi } from "./deal-index-docs";

beforeEach(() => { get.mockReset(); post.mockReset(); });

describe("IndexDocumentsForAi", () => {
  it("renders nothing when every document is indexed", async () => {
    get.mockResolvedValue({ pending: 0 });
    const { container } = render(<IndexDocumentsForAi dealId="d1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("indexes in rounds until nothing is left", async () => {
    get.mockResolvedValue({ pending: 30 });
    post
      .mockResolvedValueOnce({ indexed: 25, failed: 0, remaining: 5, error: null })
      .mockResolvedValueOnce({ indexed: 5, failed: 0, remaining: 0, error: null });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 30 documents for AI" }));
    expect(await screen.findByText(/30 documents indexed/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith("/deals/d1/documents/index-pending", {});
  });

  it("stops and explains when nothing could be indexed", async () => {
    get.mockResolvedValue({ pending: 2 });
    post.mockResolvedValueOnce({ indexed: 0, failed: 2, remaining: 2, error: "AI provider out of credit" });
    render(<IndexDocumentsForAi dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Index 2 documents for AI" }));
    expect(await screen.findByText(/AI provider out of credit/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/deals/[id]/deal-index-docs.test.tsx"`
Expected: FAIL (module missing).

- [ ] **Step 3: Create `deal-index-docs.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface IndexRound { indexed: number; failed: number; remaining: number; error: string | null }

/**
 * Files added without AI (e.g. the HubSpot import) aren't searchable by Deal
 * Chat until indexed. Indexing uses AI credit, so it runs only on a click.
 */
export function IndexDocumentsForAi({ dealId }: { dealId: string }) {
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexedTotal, setIndexedTotal] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ pending: number }>(`/deals/${dealId}/documents/index-pending`)
      .then((r) => { if (!cancelled) setPending(r.pending ?? 0); })
      .catch((err) => console.warn("[deal/index-docs] pending count failed:", err));
    return () => { cancelled = true; };
  }, [dealId]);

  async function run() {
    setRunning(true);
    setError(null);
    let total = 0;
    try {
      for (;;) {
        const r = await api.post<IndexRound>(`/deals/${dealId}/documents/index-pending`, {});
        total += r.indexed;
        setPending(r.remaining);
        if (r.indexed === 0) {
          if (r.remaining > 0) setError(`Couldn't index ${r.remaining} documents: ${r.error ?? "unknown reason"}.`);
          break;
        }
        if (r.remaining === 0) break;
      }
      setIndexedTotal(total);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Indexing failed.");
    } finally {
      setRunning(false);
    }
  }

  if (pending === 0 && indexedTotal === null && !error) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-white p-3 text-sm">
      {pending > 0 && (
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[18px]">{running ? "progress_activity" : "auto_awesome"}</span>
          {running ? `Indexing… ${pending} left` : `Index ${pending} documents for AI`}
        </button>
      )}
      {!running && pending > 0 && (
        <span className="text-xs text-text-muted">These files aren&apos;t searchable by Deal Chat yet. Indexing uses AI credit.</span>
      )}
      {indexedTotal !== null && indexedTotal > 0 && (
        <span className="text-xs text-emerald-700">{indexedTotal} documents indexed for Deal Chat.</span>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Render it on the Documents tab**

In `deal-page-left-panel.tsx`:
- Import: `import { IndexDocumentsForAi } from "./deal-index-docs";`
- Directly above `<DocumentsTab`, add:

```tsx
              <IndexDocumentsForAi dealId={deal.id} />
```

- [ ] **Step 5: Run tests, typecheck — expect pass**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/deals/[id]/" src/lib/iconFont && npx tsc --noEmit`
Expected: PASS. `progress_activity` and `auto_awesome` are already registered.

- [ ] **Step 6: Commit**

```bash
git add "apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-index-docs.test.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-page-left-panel.tsx"
git commit -m "feat(deals): index imported documents for AI on click

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Full verification, docs, PR

**Files:**
- Modify: `PROGRESS.md`, `CONTEXT.md`

- [ ] **Step 1: Full suites**

Run:

```bash
cd apps/api && npx vitest run && npx tsc --noEmit
cd ../web-next && npx vitest run && npx tsc --noEmit && npm run lint
```

Expected: all green. Failures in files this PR didn't touch, which also fail on a clean `origin/main` (known full-suite load flakes, see `CONTEXT.md`), are pre-existing. Confirm them by running those files in isolation.

- [ ] **Step 2: Add a `PROGRESS.md` entry**

Insert a new session at the top of `PROGRESS.md`, after the `---` that follows the header. Number it one higher than the current top session, and timestamp it with `TZ=Asia/Kolkata date "+%B %d, %Y — %H:%M IST"`. Content:
- **Goal:** make the HubSpot import complete for deals.
- **What shipped:** contacts, owners → Lead Partner, primary company + other company names, files queue, status fix (B12), deal Contacts section, "Index N documents for AI".
- **Founder actions:**
  - Run `apps/api/hubspot-relationships-files-migration.sql`.
  - Add `crm.objects.owners.read`, `files` and `files.ui_hidden.read` to the HubSpot Private App.
  - Re-run the import.
- **Not done:** ongoing sync, contact/company-only files, emails scope correction, stage-mapping UI.

- [ ] **Step 3: Update `CONTEXT.md`**

- Under "Open PRs", add this PR.
- Under "Waiting on the founder / ops", add the migration and the three scopes.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add PROGRESS.md CONTEXT.md docs/superpowers/specs/2026-10-11-hubspot-relationships-and-files-design.md docs/superpowers/plans/2026-10-11-hubspot-relationships-and-files.md
git commit -m "docs(progress): HubSpot relationships, owners and files import

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/hubspot-relationships-files
gh pr create --title "feat(hubspot): import deal contacts, owners, primary company and files" --body "$(cat <<'EOF'
## Why
The 8 Oct production fact-check showed the import was exact for what it covered. But deal↔contact links, deal owners, files and extra companies never reached Avise, and a failed status check made HubSpot look disconnected (audit B12).

## What
- **Contacts on deals:** HubSpot deal↔contact associations become `ContactDeal` links. The deal page gets a **Contacts** section.
- **Owner → Lead Partner:** matched by email to your Avise team. Never replaces a Lead Partner set in Avise unless Overwrite is on. The HubSpot card always shows "HubSpot owner".
- **Primary company:** the deal links to HubSpot's *Primary* company, not just the first one. Other associated companies are listed on the HubSpot card.
- **Files:** attachments on notes, calls, meetings, emails and tasks tied to a deal are queued during the import. A final, time-boxed `files` step downloads them into that deal's data room.
  - De-duplicated by HubSpot file id and content hash.
  - Size/type limits match normal uploads.
  - **No AI during import.** A new "Index N documents for AI" button on the deal does it on click.
- **Missing scopes don't break anything:** owners and files each skip with a note naming the scope to add.
- **Status fix:** a failed connection check shows the real error and a Retry button.

## Founder actions
1. Run `apps/api/hubspot-relationships-files-migration.sql` (see `docs/PENDING-MIGRATIONS.md`). Until then, the files row says "migration pending" and nothing else is affected.
2. Add `crm.objects.owners.read`, `files`, `files.ui_hidden.read` to the HubSpot Private App.
3. Re-run the import.

## Tests
- New API tests: client, mappers, documentStore, dealRelations, fileQueue, engine wiring, routes.
- New web tests: panel status, progress rows, deal contacts, index button.
- Full suites green; `tsc` clean.

Spec: `docs/superpowers/specs/2026-10-11-hubspot-relationships-and-files-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Manual check on the PR preview (after the migration has run)**

Use a test HubSpot portal with:
- one deal with two companies (one Primary) and two contacts;
- an owner whose email is an Avise teammate;
- a note on the deal with a PDF attached;
- a 120MB file.

Run the import twice. Expected:
- Primary company linked; the other company is named on the card.
- Two contacts appear in the deal's Contacts section.
- Lead Partner is the teammate.
- The PDF is in the data room.
- The 120MB file shows as "too large".
- Second run: no duplicates, counts show updates only.
