# HubSpot Import — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a firm paste a HubSpot Private App token and bulk-import their Companies, Contacts, and Deals into the PE OS as a resumable background job with live progress, merging into existing records rather than duplicating.

**Architecture:** A new isolated `apps/api/src/services/hubspot/` module (REST client, pure mappers, dedup/merge upserts, chunked import engine) driven by `apps/api/src/routes/hubspot-import.ts`, backed by two new tables (`HubSpotConnection`, `ImportJob`) plus `hubspotId`/`hubspotProperties` columns on `Contact`/`Company`/`Deal`. A new "Integrations" section in the Next.js settings page connects the account, starts the import, and polls job status.

**Tech Stack:** Express + TypeScript (ESM, `.js` import suffixes), Supabase service client, Zod, vitest + supertest, `services/encryption.ts` (AES-256-GCM), Next.js App Router + `lib/api.ts` client.

**Spec:** `docs/superpowers/specs/2026-06-29-hubspot-import-design.md`

**Scope (Phase 1 only):** Private App token auth; Companies + Contacts + Deals; background job + progress UI. **Out of scope:** activities/notes/tasks (Phase 2), OAuth (Phase 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/hubspot-import-migration.sql` | Create `HubSpotConnection`, `ImportJob`; add `hubspotId`/`hubspotProperties` to Contact/Company/Deal |
| `apps/api/src/services/hubspot/types.ts` | Shared types: `HubSpotRecord`, `MappedCompany`, `MappedContact`, `MappedDeal` |
| `apps/api/src/services/hubspot/client.ts` | HubSpot REST wrapper: auth header, pagination, 429 backoff, token validation |
| `apps/api/src/services/hubspot/mappers.ts` | Pure HubSpot→row mapping functions (no I/O) |
| `apps/api/src/services/hubspot/dedup.ts` | Match + merge-blank-only upsert helpers against Supabase |
| `apps/api/src/services/hubspot/importEngine.ts` | Chunked, resumable orchestration; updates `ImportJob` |
| `apps/api/src/routes/hubspot-import.ts` | connect / disconnect / start import / status / cancel endpoints |
| `apps/api/src/app.ts` | Mount the new router (modify) |
| `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx` | Connect + import + live progress UI |
| `apps/web-next/src/app/(app)/settings/page.tsx` | Add "Integrations" nav entry + render section (modify) |
| `apps/api/tests/hubspot-mappers.test.ts` | Mapper unit tests |
| `apps/api/tests/hubspot-dedup.test.ts` | Dedup/merge unit tests |
| `apps/api/tests/hubspot-client.test.ts` | Client pagination + backoff tests |
| `apps/api/tests/hubspot-routes.test.ts` | Route tests via supertest |

---

## Task 1: Database migration

**Files:**
- Create: `apps/api/hubspot-import-migration.sql`

> NOTE: Supabase migrations are run manually (Vercel ships code but does not run `apps/api/*.sql`). After merge, run this SQL in the Supabase SQL editor.

- [ ] **Step 1: Write the migration SQL**

```sql
-- ============================================================
-- HubSpot Import Migration
-- Tables: HubSpotConnection, ImportJob
-- Columns: hubspotId / hubspotProperties on Contact, Company, Deal
-- ============================================================

CREATE TABLE IF NOT EXISTS public."HubSpotConnection" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL UNIQUE,
  "authType" text NOT NULL DEFAULT 'private_app'
    CHECK ("authType" IN ('private_app','oauth')),
  "accessToken" text NOT NULL,           -- encrypted (AES-256-GCM)
  "refreshToken" text,                   -- encrypted (oauth only)
  "tokenExpiresAt" timestamptz,
  "portalId" text,
  "connectedBy" uuid REFERENCES public."User"(id),
  "createdAt" timestamptz DEFAULT now() NOT NULL,
  "updatedAt" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public."ImportJob" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL,
  source text NOT NULL DEFAULT 'hubspot',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  "objectCounts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "currentObject" text,
  cursor text,
  error text,
  "startedBy" uuid REFERENCES public."User"(id),
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  "createdAt" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_importjob_org ON public."ImportJob" ("organizationId");
CREATE INDEX IF NOT EXISTS idx_importjob_status ON public."ImportJob" (status);

ALTER TABLE public."Contact" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Contact" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;
ALTER TABLE public."Company" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Company" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "hubspotId" text;
ALTER TABLE public."Deal" ADD COLUMN IF NOT EXISTS "hubspotProperties" jsonb;

-- One imported row per (org, hubspotId) per object type → idempotent re-import.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_hubspot
  ON public."Contact" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_hubspot
  ON public."Company" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hubspot
  ON public."Deal" ("organizationId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
```

> ASSUMPTION: `Company` and `Deal` already carry `organizationId` (added by `organization-migration.sql`, per project memory). If a target table lacks it, add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS "organizationId" uuid;` above the unique index for that table.

- [ ] **Step 2: Verify SQL parses (dry syntax check)**

Run: `cd "apps/api" && npx --yes sql-formatter hubspot-import-migration.sql > /dev/null && echo OK`
Expected: `OK` (formatter parses without error). If `sql-formatter` is unavailable, visually confirm balanced parentheses and quoted identifiers.

- [ ] **Step 3: Commit**

```bash
git add apps/api/hubspot-import-migration.sql
git commit -m "feat(hubspot): add import migration (connection, job, external-id columns)"
```

---

## Task 2: Shared types

**Files:**
- Create: `apps/api/src/services/hubspot/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// Raw record shape returned by HubSpot CRM v3 list endpoints.
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: {
    companies?: { results: Array<{ id: string }> };
  };
}

export interface MappedCompany {
  hubspotId: string;
  name: string;
  industry: string | null;
  website: string | null;
  description: string | null;
  hubspotProperties: Record<string, string | null>;
}

export interface MappedContact {
  hubspotId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company: string | null; // free-text company name (matches Contact schema)
  hubspotProperties: Record<string, string | null>;
}

export interface MappedDeal {
  hubspotId: string;
  name: string;
  dealSize: number | null;
  description: string | null;
  associatedCompanyHubspotId: string | null;
  customFields: Record<string, unknown>;
  hubspotProperties: Record<string, string | null>;
}

export type HubSpotObjectType = 'companies' | 'contacts' | 'deals';
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/hubspot/types.ts
git commit -m "feat(hubspot): shared mapping types"
```

---

## Task 3: Mappers (pure functions, TDD)

**Files:**
- Create: `apps/api/src/services/hubspot/mappers.ts`
- Test: `apps/api/tests/hubspot-mappers.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mapCompany, mapContact, mapDeal } from '../src/services/hubspot/mappers.js';

describe('mapCompany', () => {
  it('maps standard properties and stashes the rest', () => {
    const out = mapCompany({
      id: '101',
      properties: {
        name: 'Acme Corp', industry: 'Manufacturing',
        domain: 'acme.com', description: 'Widgets',
        custom_field_x: 'keep-me',
      },
    });
    expect(out).toEqual({
      hubspotId: '101',
      name: 'Acme Corp',
      industry: 'Manufacturing',
      website: 'acme.com',
      description: 'Widgets',
      hubspotProperties: { custom_field_x: 'keep-me' },
    });
  });

  it('falls back to "Unknown Company" when name missing', () => {
    expect(mapCompany({ id: '1', properties: {} }).name).toBe('Unknown Company');
  });
});

describe('mapContact', () => {
  it('maps name/email/title and associated company', () => {
    const out = mapContact(
      { id: '5', properties: { firstname: 'Jane', lastname: 'Doe', email: 'j@x.com', jobtitle: 'CFO', phone: '123' } },
      'Acme Corp',
    );
    expect(out).toMatchObject({
      hubspotId: '5', firstName: 'Jane', lastName: 'Doe',
      email: 'j@x.com', title: 'CFO', phone: '123', company: 'Acme Corp',
    });
  });

  it('defaults blank names to empty string, not null', () => {
    const out = mapContact({ id: '6', properties: {} }, null);
    expect(out.firstName).toBe('');
    expect(out.lastName).toBe('');
    expect(out.company).toBeNull();
  });
});

describe('mapDeal', () => {
  it('maps amount to dealSize and tags source as hubspot', () => {
    const out = mapDeal({
      id: '9',
      properties: { dealname: 'Big Deal', amount: '50000', dealstage: 'qualified', pipeline: 'default' },
      associations: { companies: { results: [{ id: '101' }] } },
    });
    expect(out.name).toBe('Big Deal');
    expect(out.dealSize).toBe(50000);
    expect(out.associatedCompanyHubspotId).toBe('101');
    expect(out.customFields).toMatchObject({ source: 'hubspot', dealstage: 'qualified', pipeline: 'default' });
  });

  it('handles missing amount as null dealSize', () => {
    expect(mapDeal({ id: '9', properties: { dealname: 'X' } }).dealSize).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/hubspot-mappers.test.ts`
Expected: FAIL — `mapCompany is not a function` / module not found.

- [ ] **Step 3: Implement the mappers**

```typescript
import type { HubSpotRecord, MappedCompany, MappedContact, MappedDeal } from './types.js';

// Property keys we promote to first-class columns; everything else → hubspotProperties.
const COMPANY_STD = new Set(['name', 'industry', 'domain', 'description']);
const CONTACT_STD = new Set(['firstname', 'lastname', 'email', 'phone', 'jobtitle']);
const DEAL_STD = new Set(['dealname', 'amount']);

function rest(properties: Record<string, string | null>, std: Set<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!std.has(k)) out[k] = v;
  }
  return out;
}

export function mapCompany(r: HubSpotRecord): MappedCompany {
  const p = r.properties;
  return {
    hubspotId: r.id,
    name: p.name?.trim() || 'Unknown Company',
    industry: p.industry || null,
    website: p.domain || null,
    description: p.description || null,
    hubspotProperties: rest(p, COMPANY_STD),
  };
}

export function mapContact(r: HubSpotRecord, companyName: string | null): MappedContact {
  const p = r.properties;
  return {
    hubspotId: r.id,
    firstName: p.firstname?.trim() || '',
    lastName: p.lastname?.trim() || '',
    email: p.email || null,
    phone: p.phone || null,
    title: p.jobtitle || null,
    company: companyName,
    hubspotProperties: rest(p, CONTACT_STD),
  };
}

export function mapDeal(r: HubSpotRecord): MappedDeal {
  const p = r.properties;
  const amount = p.amount != null && p.amount !== '' ? Number(p.amount) : null;
  const customFields: Record<string, unknown> = { source: 'hubspot' };
  if (p.dealstage) customFields.dealstage = p.dealstage;
  if (p.pipeline) customFields.pipeline = p.pipeline;
  return {
    hubspotId: r.id,
    name: p.dealname?.trim() || 'Untitled HubSpot Deal',
    dealSize: amount != null && Number.isFinite(amount) ? amount : null,
    description: p.description || null,
    associatedCompanyHubspotId: r.associations?.companies?.results?.[0]?.id ?? null,
    customFields,
    hubspotProperties: rest(p, DEAL_STD),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/hubspot-mappers.test.ts`
Expected: PASS (8 assertions across 3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hubspot/mappers.ts apps/api/tests/hubspot-mappers.test.ts
git commit -m "feat(hubspot): pure mappers for company/contact/deal"
```

---

## Task 4: HubSpot REST client (TDD)

**Files:**
- Create: `apps/api/src/services/hubspot/client.ts`
- Test: `apps/api/tests/hubspot-client.test.ts`

The client wraps `fetch`. It exposes: `validateToken`, `listPage` (one paginated page), and an internal `requestWithBackoff` that honors HTTP 429 `Retry-After`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HubSpotClient } from '../src/services/hubspot/client.js';

const mkRes = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('HubSpotClient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('validateToken returns true on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { total: 3 })));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toBe(true);
  });

  it('validateToken returns false on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(401, { message: 'bad' })));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toBe(false);
  });

  it('listPage returns results and next cursor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mkRes(200, { results: [{ id: '1', properties: {} }], paging: { next: { after: '20' } } }),
    ));
    const c = new HubSpotClient('tok');
    const page = await c.listPage('companies', { limit: 20 });
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBe('20');
  });

  it('retries once after a 429 with Retry-After, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mkRes(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new HubSpotClient('tok');
    const page = await c.listPage('contacts', { limit: 20 });
    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/hubspot-client.test.ts`
Expected: FAIL — module `client.js` not found.

- [ ] **Step 3: Implement the client**

```typescript
import type { HubSpotRecord, HubSpotObjectType } from './types.js';
import { log } from '../../utils/logger.js';

const BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 5;

const PROPERTIES: Record<HubSpotObjectType, string[]> = {
  companies: ['name', 'industry', 'domain', 'description'],
  contacts: ['firstname', 'lastname', 'email', 'phone', 'jobtitle', 'associatedcompanyid'],
  deals: ['dealname', 'amount', 'dealstage', 'pipeline', 'description'],
};

export interface ListPage {
  results: HubSpotRecord[];
  nextCursor: string | null;
}

export class HubSpotClient {
  constructor(private token: string) {}

  private async requestWithBackoff(url: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      });
      if (res.status !== 429) return res as unknown as Response;
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
      const waitMs = Math.max(0, retryAfter) * 1000 || 2 ** attempt * 250;
      log.warn(`[hubspot] 429 rate-limited, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new Error('HubSpot rate limit: exceeded max retries');
  }

  async validateToken(): Promise<boolean> {
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/objects/companies?limit=1`);
    return res.ok;
  }

  async listPage(
    object: HubSpotObjectType,
    opts: { limit?: number; after?: string },
  ): Promise<ListPage> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    params.set('properties', PROPERTIES[object].join(','));
    if (object === 'deals') params.set('associations', 'companies');
    if (opts.after) params.set('after', opts.after);
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/objects/${object}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot ${object} list failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { results?: HubSpotRecord[]; paging?: { next?: { after?: string } } };
    return {
      results: data.results ?? [],
      nextCursor: data.paging?.next?.after ?? null,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/hubspot-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hubspot/client.ts apps/api/tests/hubspot-client.test.ts
git commit -m "feat(hubspot): REST client with pagination and 429 backoff"
```

---

## Task 5: Dedup / merge upserts (TDD)

**Files:**
- Create: `apps/api/src/services/hubspot/dedup.ts`
- Test: `apps/api/tests/hubspot-dedup.test.ts`

`mergeBlankOnly` is a pure helper (easy to test); the upsert functions use it. We unit-test the pure merge logic exhaustively and the upsert wiring with a mocked supabase.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mergeBlankOnly } from '../src/services/hubspot/dedup.js';

describe('mergeBlankOnly', () => {
  it('fills only blank/null fields on the existing row', () => {
    const existing = { name: 'Acme', industry: null, website: '' };
    const incoming = { name: 'Acme Corp', industry: 'Mfg', website: 'acme.com' };
    expect(mergeBlankOnly(existing, incoming)).toEqual({
      name: 'Acme',          // non-empty existing preserved
      industry: 'Mfg',       // null filled
      website: 'acme.com',   // empty-string filled
    });
  });

  it('never introduces keys absent from incoming', () => {
    expect(mergeBlankOnly({ a: 'x' }, { a: '', b: 'y' })).toEqual({ a: 'x', b: 'y' });
  });

  it('ignores incoming null/empty so it cannot blank a populated field', () => {
    expect(mergeBlankOnly({ a: 'keep' }, { a: null })).toEqual({ a: 'keep' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/hubspot-dedup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement dedup helpers**

```typescript
import { supabase } from '../../supabase.js';

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** Returns a copy of `existing` with only its blank fields filled from `incoming`. */
export function mergeBlankOnly<T extends Record<string, unknown>>(existing: T, incoming: Partial<T>): T {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (isBlank(v)) continue;            // never overwrite with a blank incoming value
    if (isBlank(out[k])) out[k] = v;     // fill only when existing is blank
  }
  return out as T;
}

export type UpsertResult = 'created' | 'updated';

/**
 * Upsert a mapped row into `table`, scoped to org.
 * Match priority: hubspotId, then a natural key column (`matchColumn`).
 * `row` must include hubspotId, organizationId, and hubspotProperties.
 */
export async function upsertByHubspotId(
  table: 'Company' | 'Contact' | 'Deal',
  orgId: string,
  hubspotId: string,
  row: Record<string, unknown>,
  match?: { column: string; value: string | null },
): Promise<UpsertResult> {
  // 1. Match by hubspotId first.
  let { data: existing } = await supabase
    .from(table).select('*')
    .eq('organizationId', orgId).eq('hubspotId', hubspotId).maybeSingle();

  // 2. Fall back to natural key (case-insensitive) when provided.
  if (!existing && match?.value) {
    const res = await supabase
      .from(table).select('*')
      .eq('organizationId', orgId).ilike(match.column, match.value).maybeSingle();
    existing = res.data ?? null;
  }

  if (existing) {
    const merged = mergeBlankOnly(existing as Record<string, unknown>, row);
    merged.hubspotId = hubspotId;
    merged.hubspotProperties = row.hubspotProperties;
    await supabase.from(table).update(merged).eq('id', (existing as { id: string }).id);
    return 'updated';
  }

  await supabase.from(table).insert({ ...row, organizationId: orgId, hubspotId });
  return 'created';
}
```

> NOTE: `maybeSingle()` returns `{ data: null }` (not an error) when no row matches — add it to the test setup mock chain in Task 8 prep if a route test exercises it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/hubspot-dedup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/hubspot/dedup.ts apps/api/tests/hubspot-dedup.test.ts
git commit -m "feat(hubspot): merge-blank-only dedup upserts"
```

---

## Task 6: Import engine (chunked, resumable)

**Files:**
- Create: `apps/api/src/services/hubspot/importEngine.ts`

The engine runs one bounded batch per object type per call, persists progress to `ImportJob`, and returns whether more work remains. The route layer (Task 7) drives the loop via repeated self-calls so no single request exceeds Vercel's time limit.

- [ ] **Step 1: Implement the engine**

```typescript
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { HubSpotClient } from './client.js';
import { mapCompany, mapContact, mapDeal } from './mappers.js';
import { upsertByHubspotId } from './dedup.js';
import type { HubSpotObjectType } from './types.js';

const ORDER: HubSpotObjectType[] = ['companies', 'contacts', 'deals'];
const BATCH = 100;

interface Counters { total: number; processed: number; created: number; updated: number; skipped: number; failed: number; }
const emptyCounters = (): Counters => ({ total: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 });

async function loadJob(jobId: string) {
  const { data } = await supabase.from('ImportJob').select('*').eq('id', jobId).maybeSingle();
  return data as null | {
    id: string; organizationId: string; status: string;
    objectCounts: Record<string, Counters>; currentObject: string | null; cursor: string | null;
  };
}

async function saveJob(jobId: string, patch: Record<string, unknown>) {
  await supabase.from('ImportJob').update(patch).eq('id', jobId);
}

/**
 * Resolve a HubSpot company id → the local Company name we imported for it.
 * Contacts/Deals reference companies by HubSpot id; we store the name as free text.
 */
async function companyNameForHubspotId(orgId: string, hubspotCompanyId: string | null): Promise<string | null> {
  if (!hubspotCompanyId) return null;
  const { data } = await supabase
    .from('Company').select('name')
    .eq('organizationId', orgId).eq('hubspotId', hubspotCompanyId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/**
 * Process ONE batch for the job's current object. Returns true if more work remains.
 */
export async function runImportBatch(jobId: string, token: string): Promise<boolean> {
  const job = await loadJob(jobId);
  if (!job) return false;
  if (job.status === 'cancelled') return false;

  const client = new HubSpotClient(token);
  const counts = { ...job.objectCounts };
  ORDER.forEach((o) => { if (!counts[o]) counts[o] = emptyCounters(); });

  // Pick the current object (first not-yet-finished in ORDER).
  const current = (job.currentObject as HubSpotObjectType) ?? ORDER[0];
  const objectIndex = ORDER.indexOf(current);

  let page;
  try {
    page = await client.listPage(current, { limit: BATCH, after: job.cursor ?? undefined });
  } catch (err) {
    log.error(`[hubspot] batch fetch failed for ${current}: ${(err as Error).message}`);
    await saveJob(jobId, { status: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() });
    return false;
  }

  for (const rec of page.results) {
    try {
      if (current === 'companies') {
        const m = mapCompany(rec);
        const res = await upsertByHubspotId('Company', job.organizationId, m.hubspotId, {
          name: m.name, industry: m.industry, website: m.website,
          description: m.description, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name });
        counts.companies[res] += 1;
      } else if (current === 'contacts') {
        const companyName = await companyNameForHubspotId(
          job.organizationId, rec.properties.associatedcompanyid ?? null,
        );
        const m = mapContact(rec, companyName);
        const res = await upsertByHubspotId('Contact', job.organizationId, m.hubspotId, {
          firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone,
          title: m.title, company: m.company, hubspotProperties: m.hubspotProperties,
        }, { column: 'email', value: m.email });
        counts.contacts[res] += 1;
      } else {
        const m = mapDeal(rec);
        const companyName = await companyNameForHubspotId(job.organizationId, m.associatedCompanyHubspotId);
        // Deal requires a companyId — resolve or create the Company row.
        const companyId = await resolveCompanyId(job.organizationId, companyName);
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          customFields: m.customFields, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name });
        counts.deals[res] += 1;
      }
    } catch (err) {
      counts[current].failed += 1;
      log.warn(`[hubspot] record ${rec.id} (${current}) failed: ${(err as Error).message}`);
    }
    counts[current].processed += 1;
  }

  // Advance cursor or move to the next object.
  if (page.nextCursor) {
    await saveJob(jobId, { objectCounts: counts, currentObject: current, cursor: page.nextCursor, status: 'running' });
    return true;
  }
  const nextObject = ORDER[objectIndex + 1] ?? null;
  if (nextObject) {
    await saveJob(jobId, { objectCounts: counts, currentObject: nextObject, cursor: null, status: 'running' });
    return true;
  }
  await saveJob(jobId, { objectCounts: counts, currentObject: null, cursor: null, status: 'completed', finishedAt: new Date().toISOString() });
  return false;
}

/** Find the local Company by name (case-insensitive); create a stub if absent. */
async function resolveCompanyId(orgId: string, name: string | null): Promise<string | null> {
  const target = name ?? 'Unknown Company';
  const { data: found } = await supabase
    .from('Company').select('id').eq('organizationId', orgId).ilike('name', target).maybeSingle();
  if (found) return (found as { id: string }).id;
  const { data: created } = await supabase
    .from('Company').insert({ name: target, organizationId: orgId }).select('id').maybeSingle();
  return (created as { id?: string } | null)?.id ?? null;
}
```

> NOTE: `runImportBatch` is intentionally driven externally so each Vercel invocation does bounded work. Persisting `cursor`+`objectCounts` after every batch makes it resumable and cancel-safe.

- [ ] **Step 2: Typecheck the module**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors referencing `importEngine.ts`. (Pre-existing unrelated errors, if any, are out of scope — confirm none mention `hubspot/`.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/hubspot/importEngine.ts
git commit -m "feat(hubspot): chunked resumable import engine"
```

---

## Task 7: Routes + registration (TDD via supertest)

**Files:**
- Create: `apps/api/src/routes/hubspot-import.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/hubspot-routes.test.ts`

Endpoints (mounted at `/api/integrations/hubspot`):
- `POST /connect` — `{ token }` → validate via `HubSpotClient.validateToken`, store encrypted, upsert `HubSpotConnection`.
- `DELETE /connect` — remove connection.
- `GET /connect` — `{ connected: boolean }`.
- `POST /import` — create `ImportJob` (status `queued`), kick first batch, return `{ jobId }`.
- `GET /import/:id` — job status + counts.
- `POST /import/:id/cancel` — set status `cancelled`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));
vi.mock('../src/services/encryption.js', () => ({
  encryptField: (v: string) => `enc:${v}`, decryptField: (v: string) => v.replace(/^enc:/, ''),
}));
const validateToken = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(() => ({ validateToken })),
}));
vi.mock('../src/services/hubspot/importEngine.js', () => ({ runImportBatch: vi.fn().mockResolvedValue(false) }));

const buildApp = async () => {
  const { default: router } = await import('../src/routes/hubspot-import.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'u1' }; next(); });
  app.use('/api/integrations/hubspot', router);
  return app;
};

const chain = (overrides: Record<string, any> = {}) => ({
  select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }), ...overrides,
});

describe('hubspot-import routes', () => {
  beforeEach(() => { vi.clearAllMocks(); validateToken.mockResolvedValue(true); });

  it('POST /connect rejects an invalid token', async () => {
    validateToken.mockResolvedValue(false);
    mockSupabase.from.mockReturnValue(chain());
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'bad' });
    expect(res.status).toBe(400);
  });

  it('POST /connect stores an encrypted token and returns connected', async () => {
    mockSupabase.from.mockReturnValue(chain());
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'good-token' });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  it('POST /import creates a job and returns jobId', async () => {
    mockSupabase.from.mockReturnValue(chain({
      maybeSingle: vi.fn()
        .mockResolvedValueOnce({ data: { accessToken: 'enc:tok' } }) // connection lookup
        .mockResolvedValueOnce({ data: { id: 'job-1' } }),           // created job
    }));
    const res = await request(await buildApp()).post('/api/integrations/hubspot/import').send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('job-1');
  });

  it('GET /import/:id returns status', async () => {
    mockSupabase.from.mockReturnValue(chain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1', status: 'running', objectCounts: {} } }),
    }));
    const res = await request(await buildApp()).get('/api/integrations/hubspot/import/job-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: FAIL — module `hubspot-import.js` not found.

- [ ] **Step 3: Implement the router**

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { encryptField, decryptField } from '../services/encryption.js';
import { HubSpotClient } from '../services/hubspot/client.js';
import { runImportBatch } from '../services/hubspot/importEngine.js';

const router = Router();
const connectSchema = z.object({ token: z.string().min(10) });
const MAX_BATCHES = 1000; // safety bound on the drive loop

// GET /connect → { connected }
router.get('/connect', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data } = await supabase.from('HubSpotConnection').select('id').eq('organizationId', orgId).maybeSingle();
  res.json({ connected: !!data });
});

// POST /connect → validate + store encrypted token
router.post('/connect', async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A HubSpot token is required' });
  const orgId = getOrgId(req);

  const ok = await new HubSpotClient(parsed.data.token).validateToken();
  if (!ok) return res.status(400).json({ error: 'HubSpot rejected this token. Check the Private App scopes (crm.objects.read).' });

  await supabase.from('HubSpotConnection').upsert({
    organizationId: orgId,
    authType: 'private_app',
    accessToken: encryptField(parsed.data.token),
    connectedBy: (req as any).user?.id ?? null,
    updatedAt: new Date().toISOString(),
  }, { onConflict: 'organizationId' });

  res.json({ connected: true });
});

// DELETE /connect
router.delete('/connect', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  await supabase.from('HubSpotConnection').delete().eq('organizationId', orgId);
  res.json({ connected: false });
});

// POST /import → create job + drive batches
router.post('/import', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data: conn } = await supabase
    .from('HubSpotConnection').select('accessToken').eq('organizationId', orgId).maybeSingle();
  if (!conn) return res.status(400).json({ error: 'Connect HubSpot before importing' });
  const token = decryptField((conn as { accessToken: string }).accessToken)!;

  const { data: job } = await supabase.from('ImportJob').insert({
    organizationId: orgId, source: 'hubspot', status: 'running',
    objectCounts: {}, startedBy: (req as any).user?.id ?? null, startedAt: new Date().toISOString(),
  }).select('id').maybeSingle();
  const jobId = (job as { id: string }).id;

  // Respond immediately; drive the batches without blocking the response.
  res.status(202).json({ jobId });

  void (async () => {
    try {
      let more = true; let i = 0;
      while (more && i < MAX_BATCHES) { more = await runImportBatch(jobId, token); i += 1; }
    } catch (err) {
      log.error(`[hubspot] import loop crashed: ${(err as Error).message}`);
      await supabase.from('ImportJob').update({ status: 'failed', error: (err as Error).message }).eq('id', jobId);
    }
  })();
});

// GET /import/:id → status
router.get('/import/:id', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data } = await supabase
    .from('ImportJob').select('*').eq('id', req.params.id).eq('organizationId', orgId).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Import job not found' });
  res.json(data);
});

// POST /import/:id/cancel
router.post('/import/:id/cancel', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  await supabase.from('ImportJob').update({ status: 'cancelled', finishedAt: new Date().toISOString() })
    .eq('id', req.params.id).eq('organizationId', orgId);
  res.json({ cancelled: true });
});

export default router;
```

> NOTE on Vercel: the `void (async () => …)` drive loop works for the token-auth Phase 1 within one function lifetime for small/medium portals. If a portal is large enough to exceed the function's max duration, the job simply stops mid-way with a persisted cursor; a follow-up `POST /import/:id/resume` (Phase 2 hardening) re-enters `runImportBatch`. Document this limitation; do not over-engineer a queue in Phase 1.

- [ ] **Step 4: Register the router in `app.ts`**

Add the import near the other route imports (after line 35, `internalRouter`):

```typescript
import hubspotImportRouter from './routes/hubspot-import.js';
```

Add the mount alongside the other org-scoped routes (next to the `deal-import` mount, ~line 283):

```typescript
app.use('/api/integrations/hubspot', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, hubspotImportRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors mentioning `hubspot-import.ts` or `app.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/hubspot-import.ts apps/api/src/app.ts apps/api/tests/hubspot-routes.test.ts
git commit -m "feat(hubspot): connect/import/status/cancel routes"
```

---

## Task 8: Frontend — Integrations settings section

**Files:**
- Create: `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`
- Modify: `apps/web-next/src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Implement the section component**

```tsx
"use client";

import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";

interface JobCounts { total: number; processed: number; created: number; updated: number; skipped: number; failed: number; }
interface ImportJob { id: string; status: string; currentObject: string | null; objectCounts: Record<string, JobCounts>; error?: string | null; }

const OBJECTS = ["companies", "contacts", "deals"] as const;

export function IntegrationsSection() {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.get<{ connected: boolean }>("/integrations/hubspot/connect")
      .then((r) => setConnected(r.connected)).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ connected: boolean }>("/integrations/hubspot/connect", { token });
      setConnected(r.connected); setToken("");
    } catch (e) { setError((e as Error).message || "Failed to connect"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try { await api.delete("/integrations/hubspot/connect"); setConnected(false); }
    finally { setBusy(false); }
  }

  async function startImport() {
    setBusy(true); setError(null);
    try {
      const { jobId } = await api.post<{ jobId: string }>("/integrations/hubspot/import", {});
      pollRef.current = setInterval(async () => {
        const j = await api.get<ImportJob>(`/integrations/hubspot/import/${jobId}`);
        setJob(j);
        if (["completed", "failed", "cancelled"].includes(j.status) && pollRef.current) {
          clearInterval(pollRef.current); pollRef.current = null;
        }
      }, 2000);
    } catch (e) { setError((e as Error).message || "Failed to start import"); }
    finally { setBusy(false); }
  }

  return (
    <section id="integrations" className="scroll-mt-6">
      <h2 className="text-lg font-semibold text-[#003366]">Integrations</h2>
      <p className="mt-1 text-sm text-slate-500">Import your existing CRM data from HubSpot.</p>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {!connected ? (
          <>
            <label className="block text-sm font-medium text-slate-700">HubSpot Private App token</label>
            <input
              type="password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder="pat-na1-..."
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-slate-400">
              HubSpot → Settings → Integrations → Private Apps. Needs <code>crm.objects.read</code> scopes.
            </p>
            <button
              onClick={connect} disabled={busy || token.length < 10}
              className="mt-3 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              {busy ? "Connecting…" : "Connect HubSpot"}
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-600">● HubSpot connected</span>
              <button onClick={disconnect} disabled={busy} className="text-sm text-slate-500 hover:text-red-600">Disconnect</button>
            </div>
            <button
              onClick={startImport} disabled={busy || job?.status === "running"}
              className="mt-4 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              {job?.status === "running" ? "Importing…" : "Import from HubSpot"}
            </button>

            {job && (
              <div className="mt-4 space-y-1 text-sm">
                {OBJECTS.map((o) => {
                  const c = job.objectCounts?.[o];
                  return (
                    <div key={o} className="flex justify-between text-slate-600">
                      <span className="capitalize">{o}</span>
                      <span>{c ? `${c.created + c.updated} imported · ${c.failed} failed` : "—"}</span>
                    </div>
                  );
                })}
                <div className="pt-1 text-xs text-slate-400">Status: {job.status}{job.error ? ` — ${job.error}` : ""}</div>
              </div>
            )}
          </>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Wire the section into `page.tsx`**

Add to the `sections` array (after the `ai-usage` entry, ~line 25):

```tsx
{ id: "integrations", label: "Integrations", icon: "extension" },
```

Add the import (with the other section imports, ~line 15):

```tsx
import { IntegrationsSection } from "./IntegrationsSection";
```

Render it after `<AiUsageSection />` (~line 328):

```tsx
<IntegrationsSection />
```

- [ ] **Step 3: Build the web app to verify it compiles**

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: no errors referencing `IntegrationsSection.tsx` or `page.tsx`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx" "apps/web-next/src/app/(app)/settings/page.tsx"
git commit -m "feat(hubspot): Integrations settings section with connect + import progress"
```

---

## Task 9: Full suite + manual smoke

- [ ] **Step 1: Run the whole API test suite**

Run: `cd apps/api && npm test`
Expected: all tests pass, including the 4 new HubSpot test files (mappers, dedup, client, routes).

- [ ] **Step 2: Manual smoke (requires a real HubSpot Private App token)**

1. Run the migration SQL in Supabase.
2. `npm run dev` (api + web).
3. Settings → Integrations → paste a Private App token → Connect (expect green "connected").
4. Click "Import from HubSpot" → watch counts climb for companies → contacts → deals.
5. Re-run import → verify counts show `updated` (not duplicated) and no new duplicate rows appear in the CRM.

- [ ] **Step 3: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "chore(hubspot): phase 1 import end-to-end"
```

---

## Self-Review Notes (completed)

- **Spec coverage:** token auth (Task 7), Companies/Contacts/Deals import (Tasks 3,5,6), background job + progress (Tasks 6,7,8), merge-blank-only dedup (Task 5), `hubspotId`/`hubspotProperties` + tables (Task 1), deal source-tagging (`customFields.source='hubspot'`, Task 3), org-scoping (every supabase query filters `organizationId`). Activities + OAuth correctly deferred to Phase 2/3 per spec.
- **Type consistency:** `MappedCompany/Contact/Deal`, `HubSpotRecord`, `HubSpotObjectType` defined in Task 2 and used unchanged in Tasks 3–6; `upsertByHubspotId`/`mergeBlankOnly` signatures match between Task 5 definition and Task 6 usage; `runImportBatch(jobId, token)` signature matches between Task 6 and Task 7.
- **Placeholders:** none — every code step is complete.
- **Known Phase-1 limitation (documented, not a gap):** the in-request drive loop is bounded by Vercel function duration; cursor persistence makes a future `resume` trivial (Phase 2).
