# HubSpot Engagement History Import (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing HubSpot import (Companies/Contacts/Deals) to also import Notes, Calls, Meetings, Emails, and Tasks as `ContactInteraction` rows on their associated local contacts.

**Architecture:** Reuses the existing import engine (`apps/api/src/services/hubspot/`) unchanged in shape. Adds a new object-type family (`notes|calls|meetings|emails|tasks`) to the same batching/cursor/dedup machinery already built for Companies/Contacts/Deals. A new `engagementMappers.ts` handles the 5 types' field extraction (kept separate from the existing Company/Contact/Deal `mappers.ts`); a new small function in `dedup.ts` upserts `ContactInteraction` rows (which are scoped by `contactId`, not `organizationId`, so it can't reuse the existing `upsertByHubspotId` unchanged).

**Tech Stack:** Node/Express (`apps/api`), Supabase/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-hubspot-engagement-import-design.md`

---

## Before you start

This plan assumes you're in the worktree at `/Users/ganesh/AI CRM/.worktrees/hubspot-engagements`, on branch `feat/hubspot-engagement-import` (already created, already has one commit — the spec doc). This branch is stacked on `fix/hubspot-import-robustness` (PR #89, open, not yet merged) — so it already contains all of Phase 1 + the robustness fixes. All file paths below are relative to `apps/api/` unless stated otherwise.

Run all commands from `/Users/ganesh/AI CRM/.worktrees/hubspot-engagements/apps/api` unless a step says otherwise.

---

### Task 1: Schema migration + type definitions

**Files:**
- Create: `apps/api/hubspot-engagement-import-migration.sql`
- Modify: `apps/api/src/services/hubspot/types.ts`

No tests in this task — it's pure type/schema scaffolding with no runtime logic of its own. It's exercised by every later task's tests.

- [ ] **Step 1: Create the migration file**

```sql
-- ============================================================
-- HubSpot Engagement Import Migration (Phase 2)
-- Column: hubspotId on ContactInteraction
-- ============================================================

ALTER TABLE public."ContactInteraction" ADD COLUMN IF NOT EXISTS "hubspotId" text;

-- Compound, not a plain hubspotId unique index: one HubSpot engagement can
-- produce multiple ContactInteraction rows (one per associated local contact),
-- and ContactInteraction has no organizationId column of its own — it's
-- scoped transitively via contactId.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactinteraction_hubspot
  ON public."ContactInteraction" ("contactId", "hubspotId") WHERE "hubspotId" IS NOT NULL;
```

This is **not auto-run by Vercel** — per the standing project gotcha, someone must run this manually in the Supabase SQL editor after merge. Note this in the PR description (Task 6 covers that).

- [ ] **Step 2: Extend `types.ts`**

Open `apps/api/src/services/hubspot/types.ts`. Replace the whole file with:

```typescript
// Raw record shape returned by HubSpot CRM v3 list endpoints.
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: {
    companies?: { results: Array<{ id: string }> };
    contacts?: { results: Array<{ id: string }> };
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

/** Mirrors the Deal.stage enum in apps/api/src/routes/deals-schemas.ts. */
export type DealStage =
  | 'INITIAL_REVIEW' | 'DUE_DILIGENCE' | 'IOI_SUBMITTED' | 'LOI_SUBMITTED'
  | 'NEGOTIATION' | 'CLOSING' | 'PASSED' | 'CLOSED_WON' | 'CLOSED_LOST';

export interface MappedDeal {
  hubspotId: string;
  name: string;
  dealSize: number | null;
  /** null when the HubSpot stage has no PE OS equivalent — leave the deal alone. */
  stage: DealStage | null;
  description: string | null;
  associatedCompanyHubspotId: string | null;
  customFields: Record<string, unknown>;
  hubspotProperties: Record<string, string | null>;
}

/** HubSpot's five engagement ("activity") object types. */
export type EngagementType = 'notes' | 'calls' | 'meetings' | 'emails' | 'tasks';

/** Mirrors the ContactInteraction.type CHECK constraint in contacts-migration.sql. */
export type InteractionType = 'NOTE' | 'MEETING' | 'CALL' | 'EMAIL' | 'OTHER';

export interface MappedEngagement {
  hubspotId: string;
  interactionType: InteractionType;
  title: string | null;
  description: string | null;
  /** ISO timestamp, or null if HubSpot returned no usable timestamp. */
  date: string | null;
  /** HubSpot contact ids this engagement is associated with — may be empty. */
  associatedContactHubspotIds: string[];
}

export type HubSpotObjectType = 'companies' | 'contacts' | 'deals' | EngagementType;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: the same pre-existing errors as before this change (unrelated `marked`/`sanitize-html`/`pdf-lib` missing-module errors), nothing new. `HubSpotObjectType` now includes 5 more members, so anywhere that switches/maps over it exhaustively will show a new error until later tasks fill those in — that's expected and gets fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add hubspot-engagement-import-migration.sql src/services/hubspot/types.ts
git commit -m "feat(hubspot): schema + types for engagement import"
```

---

### Task 2: `engagementMappers.ts` — pure mapping logic

**Files:**
- Create: `apps/api/src/services/hubspot/engagementMappers.ts`
- Test: `apps/api/tests/hubspot-engagement-mappers.test.ts`

This is the field-extraction logic for all 5 engagement types, verified against HubSpot's actual property names (`docs/superpowers/specs/2026-08-05-hubspot-engagement-import-design.md`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/hubspot-engagement-mappers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapEngagement } from '../src/services/hubspot/engagementMappers.js';
import type { HubSpotRecord } from '../src/services/hubspot/types.js';

function rec(properties: Record<string, string | null>, contactIds: string[] = []): HubSpotRecord {
  return {
    id: 'hs-1',
    properties,
    associations: contactIds.length ? { contacts: { results: contactIds.map((id) => ({ id })) } } : undefined,
  };
}

describe('mapEngagement — notes', () => {
  it('maps hs_note_body and hs_timestamp, with no title', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'Called about term sheet', hs_timestamp: '1721000000000' }));
    expect(out).toMatchObject({
      hubspotId: 'hs-1',
      interactionType: 'NOTE',
      title: null,
      description: 'Called about term sheet',
      date: new Date(1721000000000).toISOString(),
    });
  });
});

describe('mapEngagement — calls', () => {
  it('maps title, body, duration, and direction into description', () => {
    const out = mapEngagement('calls', rec({
      hs_call_title: 'Intro call', hs_call_body: 'Discussed valuation',
      hs_call_duration: '332000', hs_call_direction: 'OUTBOUND', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('CALL');
    expect(out.title).toBe('Intro call');
    expect(out.description).toContain('Discussed valuation');
    expect(out.description).toContain('5m 32s');
    expect(out.description).toContain('OUTBOUND');
    expect(out.date).toBe(new Date(1721000000000).toISOString());
  });

  it('omits duration/direction from description when absent', () => {
    const out = mapEngagement('calls', rec({ hs_call_body: 'Quick chat', hs_timestamp: '1721000000000' }));
    expect(out.description).toBe('Quick chat');
  });
});

describe('mapEngagement — meetings', () => {
  it('prefers hs_meeting_start_time over hs_timestamp for the date', () => {
    const out = mapEngagement('meetings', rec({
      hs_meeting_title: 'Diligence session', hs_meeting_body: 'Reviewed financials',
      hs_meeting_outcome: 'COMPLETED', hs_meeting_start_time: '1721000000000', hs_timestamp: '1720000000000',
    }));
    expect(out.interactionType).toBe('MEETING');
    expect(out.title).toBe('Diligence session');
    expect(out.description).toContain('Reviewed financials');
    expect(out.description).toContain('COMPLETED');
    expect(out.date).toBe(new Date(1721000000000).toISOString());
  });

  it('falls back to hs_timestamp when hs_meeting_start_time is absent', () => {
    const out = mapEngagement('meetings', rec({ hs_meeting_title: 'Follow-up', hs_timestamp: '1720000000000' }));
    expect(out.date).toBe(new Date(1720000000000).toISOString());
  });
});

describe('mapEngagement — emails', () => {
  it('maps subject and text', () => {
    const out = mapEngagement('emails', rec({
      hs_email_subject: 'Re: Data room access', hs_email_text: 'Here is the link', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('EMAIL');
    expect(out.title).toBe('Re: Data room access');
    expect(out.description).toBe('Here is the link');
  });
});

describe('mapEngagement — tasks', () => {
  it('prefixes the title with [Task] and folds status/priority into description', () => {
    const out = mapEngagement('tasks', rec({
      hs_task_subject: 'Send NDA', hs_task_body: 'Standard NDA template',
      hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('OTHER');
    expect(out.title).toBe('[Task] Send NDA');
    expect(out.description).toContain('Standard NDA template');
    expect(out.description).toContain('NOT_STARTED');
    expect(out.description).toContain('HIGH');
  });

  it('falls back to "Untitled Task" when hs_task_subject is blank', () => {
    const out = mapEngagement('tasks', rec({ hs_timestamp: '1721000000000' }));
    expect(out.title).toBe('[Task] Untitled Task');
  });
});

describe('mapEngagement — associations and missing timestamps', () => {
  it('collects associated contact hubspot ids', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'x' }, ['contact-1', 'contact-2']));
    expect(out.associatedContactHubspotIds).toEqual(['contact-1', 'contact-2']);
  });

  it('returns an empty array when there are no contact associations', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'x' }));
    expect(out.associatedContactHubspotIds).toEqual([]);
  });

  it('returns a null date when hs_timestamp is missing or unparseable', () => {
    expect(mapEngagement('notes', rec({ hs_note_body: 'x' })).date).toBeNull();
    expect(mapEngagement('notes', rec({ hs_note_body: 'x', hs_timestamp: 'not-a-number' })).date).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hubspot-engagement-mappers.test.ts`
Expected: FAIL — `Cannot find module '../src/services/hubspot/engagementMappers.js'` (or similar resolution error), since the file doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/hubspot/engagementMappers.ts`:

```typescript
import type { EngagementType, HubSpotRecord, InteractionType, MappedEngagement } from './types.js';

const INTERACTION_TYPE: Record<EngagementType, InteractionType> = {
  notes: 'NOTE', calls: 'CALL', meetings: 'MEETING', emails: 'EMAIL', tasks: 'OTHER',
};

/** HubSpot returns date/datetime properties as epoch-millisecond strings. */
function fromEpochMs(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** hs_call_duration is milliseconds, e.g. "332000" -> "5m 32s". */
function formatDuration(msValue: string | null | undefined): string | null {
  if (!msValue) return null;
  const totalMs = Number(msValue);
  if (!Number.isFinite(totalMs)) return null;
  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function joinParts(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? kept.join(' · ') : null;
}

export function mapEngagement(type: EngagementType, r: HubSpotRecord): MappedEngagement {
  const p = r.properties;
  const associatedContactHubspotIds = r.associations?.contacts?.results?.map((c) => c.id) ?? [];
  const base = { hubspotId: r.id, interactionType: INTERACTION_TYPE[type], associatedContactHubspotIds };

  if (type === 'notes') {
    return { ...base, title: null, description: p.hs_note_body || null, date: fromEpochMs(p.hs_timestamp) };
  }

  if (type === 'calls') {
    const duration = formatDuration(p.hs_call_duration);
    return {
      ...base,
      title: p.hs_call_title || null,
      description: joinParts([p.hs_call_body, duration ? `Duration: ${duration}` : null, p.hs_call_direction ? `Direction: ${p.hs_call_direction}` : null]),
      date: fromEpochMs(p.hs_timestamp),
    };
  }

  if (type === 'meetings') {
    return {
      ...base,
      title: p.hs_meeting_title || null,
      description: joinParts([p.hs_meeting_body, p.hs_meeting_outcome ? `Outcome: ${p.hs_meeting_outcome}` : null]),
      date: fromEpochMs(p.hs_meeting_start_time || p.hs_timestamp),
    };
  }

  if (type === 'emails') {
    return { ...base, title: p.hs_email_subject || null, description: p.hs_email_text || null, date: fromEpochMs(p.hs_timestamp) };
  }

  // tasks
  return {
    ...base,
    title: `[Task] ${p.hs_task_subject?.trim() || 'Untitled Task'}`,
    description: joinParts([p.hs_task_body, p.hs_task_status ? `Status: ${p.hs_task_status}` : null, p.hs_task_priority ? `Priority: ${p.hs_task_priority}` : null]),
    date: fromEpochMs(p.hs_timestamp),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hubspot-engagement-mappers.test.ts`
Expected: PASS — all 14 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/hubspot/engagementMappers.ts tests/hubspot-engagement-mappers.test.ts
git commit -m "feat(hubspot): add engagementMappers for notes/calls/meetings/emails/tasks"
```

---

### Task 3: `client.ts` — standard properties + contact associations

**Files:**
- Modify: `apps/api/src/services/hubspot/client.ts`
- Test: `apps/api/tests/hubspot-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `apps/api/tests/hubspot-client.test.ts`. Add this new `describe` block anywhere after the existing `import` statements (e.g. right before the final `describe('HubSpotClient.listPage properties override', ...)` block):

```typescript
describe('STANDARD_PROPERTIES — engagement types', () => {
  it('requests the note body and timestamp', () => {
    expect(STANDARD_PROPERTIES.notes).toEqual(expect.arrayContaining(['hs_note_body', 'hs_timestamp']));
  });

  it('requests call title, body, duration, and direction', () => {
    expect(STANDARD_PROPERTIES.calls).toEqual(
      expect.arrayContaining(['hs_call_title', 'hs_call_body', 'hs_call_duration', 'hs_call_direction', 'hs_timestamp']),
    );
  });

  it('requests meeting title, body, start/end time, and outcome', () => {
    expect(STANDARD_PROPERTIES.meetings).toEqual(
      expect.arrayContaining(['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome']),
    );
  });

  it('requests email subject, text, and direction', () => {
    expect(STANDARD_PROPERTIES.emails).toEqual(
      expect.arrayContaining(['hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_timestamp']),
    );
  });

  it('requests task subject, body, status, and priority', () => {
    expect(STANDARD_PROPERTIES.tasks).toEqual(
      expect.arrayContaining(['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_timestamp']),
    );
  });
});

describe('HubSpotClient.listPage — engagement contact associations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(['notes', 'calls', 'meetings', 'emails', 'tasks'] as const)(
    'requests contact associations for %s',
    async (type) => {
      const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
      vi.stubGlobal('fetch', fetchMock);
      await new HubSpotClient('tok').listPage(type, { limit: 20 });
      expect(fetchMock.mock.calls[0][0] as string).toContain('associations=contacts');
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hubspot-client.test.ts`
Expected: FAIL. The `STANDARD_PROPERTIES.notes` (etc.) tests fail with a TypeError (`Cannot read properties of undefined`) since those keys don't exist yet. The `listPage` tests fail because the URL won't contain `associations=contacts`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/hubspot/client.ts`, replace the `STANDARD_PROPERTIES` block and the `COMPANY_ASSOCIATED` line with:

```typescript
/**
 * Standard HubSpot properties we always request, on top of the client's custom
 * ones. HubSpot only returns properties you ask for by name, so anything absent
 * here is silently missing from the import — keep this list generous.
 */
export const STANDARD_PROPERTIES: Record<HubSpotObjectType, string[]> = {
  companies: [
    'name', 'industry', 'domain', 'website', 'description', 'phone',
    'address', 'city', 'state', 'zip', 'country',
    'numberofemployees', 'annualrevenue', 'type', 'lifecyclestage',
    'linkedin_company_page', 'founded_year',
  ],
  contacts: [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle',
    'company', 'associatedcompanyid', 'website',
    'address', 'city', 'state', 'zip', 'country',
    'lifecyclestage', 'hs_lead_status',
  ],
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline', 'description',
    'closedate', 'createdate', 'dealtype', 'hs_deal_stage_probability',
  ],
  notes: ['hs_note_body', 'hs_timestamp'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_timestamp', 'hs_call_duration', 'hs_call_direction'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_timestamp'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_timestamp', 'hs_email_direction'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_timestamp', 'hs_task_status', 'hs_task_priority'],
};

/** Object types whose company association we resolve via the associations API. */
const COMPANY_ASSOCIATED: HubSpotObjectType[] = ['deals', 'contacts'];
/** Engagement types whose contact association we resolve via the associations API. */
const CONTACT_ASSOCIATED: HubSpotObjectType[] = ['notes', 'calls', 'meetings', 'emails', 'tasks'];
```

Then in `listPage`, change:

```typescript
    if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');
```

to:

```typescript
    if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');
    if (CONTACT_ASSOCIATED.includes(object)) params.set('associations', 'contacts');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hubspot-client.test.ts`
Expected: PASS — all tests green (existing + 10 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/hubspot/client.ts tests/hubspot-client.test.ts
git commit -m "feat(hubspot): request engagement properties + contact associations"
```

---

### Task 4: `dedup.ts` — `upsertContactInteractionByHubspotId`

**Files:**
- Modify: `apps/api/src/services/hubspot/dedup.ts`
- Test: `apps/api/tests/hubspot-dedup.test.ts`

`ContactInteraction` has no `organizationId` column (it's scoped via `contactId` → `Contact` → org), and has no meaningful natural-key fallback the way Company name or Contact email do — so this needs its own small function rather than reusing `upsertByHubspotId`.

- [ ] **Step 1: Write the failing tests**

Open `apps/api/tests/hubspot-dedup.test.ts`. Add this at the end of the file (after the closing `});` of the `describe('upsertByHubspotId', ...)` block):

```typescript
describe('upsertContactInteractionByHubspotId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new ContactInteraction when no existing row matches (contactId, hubspotId)', async () => {
    const noMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const insertChain = makeChain();
    mockFrom.mockReturnValueOnce(noMatch).mockReturnValueOnce(insertChain);

    const result = await upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', {
      type: 'NOTE', title: null, description: 'Called about term sheet', date: '2026-08-01T00:00:00.000Z',
    }, 'fill');

    expect(result).toBe('created');
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-1', hubspotId: 'hs-note-1', type: 'NOTE', description: 'Called about term sheet',
    }));
  });

  it('updates the existing row when (contactId, hubspotId) already matches', async () => {
    const match = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ci-1', description: 'Old text' } }),
    });
    const updateChain = makeChain();
    mockFrom.mockReturnValueOnce(match).mockReturnValueOnce(updateChain);

    const result = await upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', {
      type: 'NOTE', title: null, description: 'Corrected text', date: '2026-08-01T00:00:00.000Z',
    }, 'refresh');

    expect(result).toBe('updated');
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ description: 'Corrected text' }));
  });

  it('throws instead of silently swallowing a Supabase error on insert', async () => {
    const noMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const insertChain = makeChain({ error: { message: 'null value in column "contactId"' } });
    mockFrom.mockReturnValueOnce(noMatch).mockReturnValueOnce(insertChain);

    await expect(
      upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', { type: 'NOTE', title: null, description: 'x', date: null }, 'fill'),
    ).rejects.toThrow(/contactId/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hubspot-dedup.test.ts`
Expected: FAIL — `upsertContactInteractionByHubspotId is not a function` (it isn't exported yet).

- [ ] **Step 3: Implement**

In `apps/api/src/services/hubspot/dedup.ts`, add this after the existing `upsertByHubspotId` function (at the end of the file):

```typescript
/**
 * Upsert a HubSpot-imported ContactInteraction. Scoped by contactId, not
 * organizationId — ContactInteraction has no organizationId column of its
 * own (it's scoped transitively via Contact). No natural-key fallback:
 * unlike a Company name or Contact email, there's no meaningful fuzzy match
 * for an interaction — (contactId, hubspotId) IS the identity.
 */
export async function upsertContactInteractionByHubspotId(
  contactId: string,
  hubspotId: string,
  row: Record<string, unknown>,
  mode: ImportMode,
): Promise<UpsertResult> {
  const { data: existing } = await supabase
    .from('ContactInteraction').select('*')
    .eq('contactId', contactId).eq('hubspotId', hubspotId).maybeSingle();

  if (existing) {
    const merged = mergeForImport(existing as Record<string, unknown>, row, mode);
    merged.hubspotId = hubspotId;
    const { error } = await supabase.from('ContactInteraction').update(merged).eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`HubSpot ContactInteraction update failed: ${error.message}`);
    return 'updated';
  }

  const { error } = await supabase.from('ContactInteraction').insert({ ...row, contactId, hubspotId });
  if (error) throw new Error(`HubSpot ContactInteraction insert failed: ${error.message}`);
  return 'created';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hubspot-dedup.test.ts`
Expected: PASS — all tests green (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/services/hubspot/dedup.ts tests/hubspot-dedup.test.ts
git commit -m "feat(hubspot): add upsertContactInteractionByHubspotId"
```

---

### Task 5: `importEngine.ts` — wire engagements into the batch pipeline

**Files:**
- Modify: `apps/api/src/services/hubspot/importEngine.ts`
- Test: `apps/api/tests/hubspot-engine-engagements.test.ts`

This is the biggest task: extend `ORDER`, resolve HubSpot contact ids to local `contactId`s (cached per batch, mirroring the existing company-resolution cache), and branch the per-record loop to call `mapEngagement` + `upsertContactInteractionByHubspotId` once per associated local contact.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/hubspot-engine-engagements.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listDealStageLabels, upsertContactInteractionByHubspotId } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listDealStageLabels: vi.fn().mockResolvedValue({}),
  upsertContactInteractionByHubspotId: vi.fn().mockResolvedValue('created'),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage, listPropertyNames: vi.fn().mockResolvedValue(['hs_note_body']), listDealStageLabels };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
  upsertContactInteractionByHubspotId,
}));
vi.mock('../src/services/hubspot/mappers.js', () => ({ mapCompany: vi.fn(), mapContact: vi.fn(), mapDeal: vi.fn() }));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

function runningNotesJob(jobId: string) {
  return makeChain({
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: jobId, organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'notes', cursor: null },
    }),
  });
}

describe('runImportBatch — engagement import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
  });

  it('resolves the associated HubSpot contact to a local contactId and upserts one ContactInteraction', async () => {
    const jobChain = runningNotesJob('job-1');
    const contactLookupChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'local-contact-1' } }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain; // 'Contact'
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-note-1',
        properties: { hs_note_body: 'Called about term sheet', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-1' }] } },
      }],
      nextCursor: null,
    });

    await runImportBatch('job-1', 'tok');

    expect(contactLookupChain.eq).toHaveBeenCalledWith('hubspotId', 'hs-contact-1');
    expect(upsertContactInteractionByHubspotId).toHaveBeenCalledWith(
      'local-contact-1', 'hs-note-1',
      expect.objectContaining({ type: 'NOTE', description: 'Called about term sheet' }),
      'fill',
    );
  });

  it('creates one ContactInteraction per associated contact for a multi-contact engagement', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-2', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'meetings', cursor: null },
      }),
    });
    const contactLookupChain = makeChain({
      maybeSingle: vi.fn()
        .mockResolvedValueOnce({ data: { id: 'local-contact-1' } })
        .mockResolvedValueOnce({ data: { id: 'local-contact-2' } }),
    });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-2' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain;
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-meeting-1',
        properties: { hs_meeting_title: 'Kickoff', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-1' }, { id: 'hs-contact-2' }] } },
      }],
      nextCursor: null,
    });

    await runImportBatch('job-2', 'tok');

    expect(upsertContactInteractionByHubspotId).toHaveBeenCalledTimes(2);
    expect(upsertContactInteractionByHubspotId).toHaveBeenNthCalledWith(1, 'local-contact-1', 'hs-meeting-1', expect.anything(), 'fill');
    expect(upsertContactInteractionByHubspotId).toHaveBeenNthCalledWith(2, 'local-contact-2', 'hs-meeting-1', expect.anything(), 'fill');
  });

  it('skips an engagement with no resolvable local contact, without throwing', async () => {
    const jobChain = runningNotesJob('job-3');
    const noContactMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-3' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return noContactMatch;
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-note-1', properties: { hs_note_body: 'x', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-unmatched' }] } },
      }],
      nextCursor: null,
    });

    const result = await runImportBatch('job-3', 'tok');

    expect(result).toBe(false); // job completes normally, doesn't crash
    expect(upsertContactInteractionByHubspotId).not.toHaveBeenCalled();
    // Verify the job update reflects processed=1, created=0 (skipped, not failed)
    const finalUpdateCall = (finalUpdateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as { objectCounts: Record<string, { processed: number; created: number; failed: number }> };
    expect(finalUpdateCall.objectCounts.notes).toMatchObject({ processed: 1, created: 0, failed: 0 });
  });

  it('resolves the same HubSpot contact id only once across multiple engagements in a batch', async () => {
    const jobChain = runningNotesJob('job-4');
    const contactLookupChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'local-contact-1' } }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-4' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain;
    });

    listPage.mockResolvedValue({
      results: [
        { id: 'hs-note-1', properties: { hs_note_body: 'a', hs_timestamp: '1721000000000' }, associations: { contacts: { results: [{ id: 'hs-contact-1' }] } } },
        { id: 'hs-note-2', properties: { hs_note_body: 'b', hs_timestamp: '1721000000000' }, associations: { contacts: { results: [{ id: 'hs-contact-1' }] } } },
      ],
      nextCursor: null,
    });

    await runImportBatch('job-4', 'tok');

    const contactCalls = mockFrom.mock.calls.filter((c) => c[0] === 'Contact').length;
    expect(contactCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hubspot-engine-engagements.test.ts`
Expected: FAIL. `ORDER` doesn't include `'notes'`/`'meetings'` yet, so `currentObject: 'notes'` falls through to the existing `else` branch (which currently assumes deals) — tests fail with assertion errors like `upsertContactInteractionByHubspotId` never called, or a thrown error from `mapDeal` being called with a note-shaped record.

- [ ] **Step 3: Implement**

In `apps/api/src/services/hubspot/importEngine.ts`:

**3a.** Update the imports at the top of the file:

```typescript
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { HubSpotClient } from './client.js';
import { mapCompany, mapContact, mapDeal } from './mappers.js';
import { mapEngagement } from './engagementMappers.js';
import { upsertByHubspotId, upsertContactInteractionByHubspotId, type ImportMode } from './dedup.js';
import type { EngagementType, HubSpotObjectType } from './types.js';
```

**3b.** Update `ORDER` and add `ENGAGEMENT_TYPES`:

```typescript
const ORDER: HubSpotObjectType[] = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks'];
const ENGAGEMENT_TYPES: EngagementType[] = ['notes', 'calls', 'meetings', 'emails', 'tasks'];
const BATCH = 100;
```

**3c.** Add a `contactIdForHubspotId` helper right after the existing `companyNameForHubspotId` function:

```typescript
/**
 * Resolve a HubSpot contact id → the local Contact's id. Engagements
 * reference contacts by HubSpot id via the associations API.
 */
async function contactIdForHubspotId(orgId: string, hubspotContactId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Contact').select('id')
    .eq('organizationId', orgId).eq('hubspotId', hubspotContactId).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}
```

**3d.** Inside `runImportBatchInner`, right after the existing `resolveCompanyIdCached` function definition, add a cached wrapper for contact resolution (same per-batch caching pattern):

```typescript
  const contactIdCache = new Map<string, string | null>();
  async function contactIdForHubspotIdCached(orgId: string, hubspotContactId: string) {
    if (contactIdCache.has(hubspotContactId)) return contactIdCache.get(hubspotContactId) ?? null;
    const id = await contactIdForHubspotId(orgId, hubspotContactId);
    contactIdCache.set(hubspotContactId, id);
    return id;
  }
```

**3e.** In the per-record `for` loop, change the final `else` branch (currently the implicit "deals" branch) to an explicit `else if (current === 'deals')`, and add a new `else if` for engagement types after it:

Find this:

```typescript
      } else {
        const m = mapDeal(rec, stageLabels[rec.properties.dealstage ?? ''] ?? null);
        const companyName = await companyNameForHubspotIdCached(job.organizationId, m.associatedCompanyHubspotId);
        // Deal requires a companyId — resolve or create the Company row.
        const companyId = await resolveCompanyIdCached(job.organizationId, companyName);
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          // Omit when unmapped: Deal.stage is NOT NULL and a null would either
          // fail the write or reset the deal to the INITIAL_REVIEW default.
          ...(m.stage ? { stage: m.stage } : {}),
          customFields: m.customFields, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name }, mode);
        counts.deals[res] += 1;
      }
```

Replace it with:

```typescript
      } else if (current === 'deals') {
        const m = mapDeal(rec, stageLabels[rec.properties.dealstage ?? ''] ?? null);
        const companyName = await companyNameForHubspotIdCached(job.organizationId, m.associatedCompanyHubspotId);
        // Deal requires a companyId — resolve or create the Company row.
        const companyId = await resolveCompanyIdCached(job.organizationId, companyName);
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          // Omit when unmapped: Deal.stage is NOT NULL and a null would either
          // fail the write or reset the deal to the INITIAL_REVIEW default.
          ...(m.stage ? { stage: m.stage } : {}),
          customFields: m.customFields, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name }, mode);
        counts.deals[res] += 1;
      } else {
        // One of the 5 engagement types (notes/calls/meetings/emails/tasks).
        const m = mapEngagement(current as EngagementType, rec);
        const resolvedContactIds = (await Promise.all(
          m.associatedContactHubspotIds.map((hsId) => contactIdForHubspotIdCached(job.organizationId, hsId)),
        )).filter((id): id is string => id !== null);

        if (resolvedContactIds.length > 0) {
          // Fan out: one HubSpot engagement can be associated with several
          // local contacts (e.g. a multi-person meeting) — write one row each.
          let anyCreated = false;
          for (const contactId of resolvedContactIds) {
            const res = await upsertContactInteractionByHubspotId(contactId, m.hubspotId, {
              type: m.interactionType, title: m.title, description: m.description,
              date: m.date ?? new Date().toISOString(),
            }, mode);
            if (res === 'created') anyCreated = true;
          }
          counts[current][anyCreated ? 'created' : 'updated'] += 1;
        }
        // No resolvable local contact: this phase is contact-scoped only
        // (per spec) — skip silently. `processed` still increments below;
        // this record contributes to neither created/updated/failed.
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hubspot-engine-engagements.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run the full HubSpot suite to check for regressions**

Run: `npx vitest run tests/hubspot-*.test.ts`
Expected: PASS — all tests green (existing ~74 + the new ones from this plan).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: same pre-existing unrelated errors as Task 1 Step 3, nothing new.

- [ ] **Step 7: Commit**

```bash
git add src/services/hubspot/importEngine.ts tests/hubspot-engine-engagements.test.ts
git commit -m "feat(hubspot): wire engagement import into the batch pipeline"
```

---

### Task 5.5: Per-object-type fetch failures must not fail the whole job

**Files:**
- Modify: `apps/api/src/services/hubspot/importEngine.ts`
- Test: `apps/api/tests/hubspot-engine-fetch-failure.test.ts`

**Why this task exists:** Code review of Task 5 found that HubSpot's engagement objects (notes/calls/meetings/emails/tasks) require their own distinct read scopes, separate from the existing `crm.objects.companies.read`/`contacts.read`/`deals.read`. Per HubSpot's own community forum, some portals can't even grant these scopes — they don't appear in the Private App scope picker for every account. Every client who already connected HubSpot before this feature shipped has a token scoped only for companies/contacts/deals. As built in Task 5, the very next "Import from HubSpot" click would succeed on companies → contacts → deals, then hit `notes`, get a 403, and — because `runImportBatchInner`'s fetch `try/catch` treats ANY object type's fetch failure as fatal to the whole job — flip the **entire job** to `'failed'`, discarding the user's visibility into the fact that 3 of 8 object types actually succeeded.

The user explicitly chose to fix this by making a fetch failure non-fatal per object type: skip the failed type, advance to the next one, and only mark the whole job `'failed'` if there's no next object type left to try. This is a deliberate behavior change to the existing (already-shipped) fetch-failure path, not just new code for engagement types — it also means a Companies/Contacts/Deals fetch failure would now skip-and-continue rather than fail-fast. No existing test asserts on the old fail-whole-job-on-any-fetch-error behavior (confirmed by grep across `hubspot-engine-*.test.ts` before writing this task), so this is safe to change without updating other tests.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/hubspot-engine-fetch-failure.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listPropertyNames } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listPropertyNames: vi.fn(),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage, listPropertyNames, listDealStageLabels: vi.fn().mockResolvedValue({}) };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
  upsertContactInteractionByHubspotId: vi.fn().mockResolvedValue('created'),
}));
vi.mock('../src/services/hubspot/mappers.js', () => ({ mapCompany: vi.fn(), mapContact: vi.fn(), mapDeal: vi.fn() }));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

describe('runImportBatch — per-object-type fetch failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
    listPropertyNames.mockResolvedValue(['hs_note_body']);
  });

  it('advances to the next object type instead of failing the whole job when a fetch fails', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'notes', cursor: null },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : advanceChain;
    });

    listPage.mockRejectedValue(new Error('HubSpot notes list failed: 403 MISSING_SCOPES'));

    const result = await runImportBatch('job-1', 'tok');

    expect(result).toBe(true); // more work remains — advanced, didn't stop
    expect(advanceChain.update).toHaveBeenCalledWith(expect.objectContaining({
      currentObject: 'calls', status: 'running',
    }));
    // Must NOT have set status: 'failed'.
    expect(advanceChain.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('still fails the job when the LAST object type fetch fails, with nowhere left to advance', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-2', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'tasks', cursor: null },
      }),
    });
    const failChain = makeChain();

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : failChain;
    });

    listPage.mockRejectedValue(new Error('HubSpot tasks list failed: 403 MISSING_SCOPES'));

    const result = await runImportBatch('job-2', 'tok');

    expect(result).toBe(false);
    expect(failChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('preserves already-accumulated counts for prior object types when skipping', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-3', organizationId: 'org-A', status: 'running',
          objectCounts: { companies: { processed: 5, created: 5, updated: 0, failed: 0 } },
          currentObject: 'notes', cursor: null,
        },
      }),
    });
    const advanceChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-3' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation(() => {
      importJobCalls += 1;
      return importJobCalls === 1 ? jobChain : advanceChain;
    });

    listPage.mockRejectedValue(new Error('403 MISSING_SCOPES'));

    await runImportBatch('job-3', 'tok');

    const updateCall = (advanceChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as { objectCounts: Record<string, unknown> };
    expect(updateCall.objectCounts.companies).toEqual({ processed: 5, created: 5, updated: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hubspot-engine-fetch-failure.test.ts` (from `apps/api/`)
Expected: FAIL. All 3 tests fail because the current `catch` block always calls `saveJob(jobId, { status: 'failed', ... })` and returns `false`, regardless of whether a next object type exists.

- [ ] **Step 3: Implement**

In `apps/api/src/services/hubspot/importEngine.ts`, find this (the fetch `try/catch`):

```typescript
  } catch (err) {
    log.error(`[hubspot] batch fetch failed for ${current}: ${(err as Error).message}`);
    await saveJob(jobId, { status: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() });
    return false;
  }
```

Replace it with:

```typescript
  } catch (err) {
    log.error(`[hubspot] batch fetch failed for ${current}: ${(err as Error).message}`);
    // A fetch failure for ONE object type (e.g. a missing HubSpot scope for
    // engagement objects — some portals can't even grant those scopes) must
    // not discard records already imported for prior object types. Skip this
    // object type and advance to the next one, mirroring the same
    // cancel-guarded advance used below for a normally-drained page. Only
    // fail the whole job if there's no next object type left to try.
    const nextObject = ORDER[objectIndex + 1] ?? null;
    if (nextObject) {
      const { data: updated } = await supabase.from('ImportJob')
        .update({ objectCounts: counts, currentObject: nextObject, cursor: null, status: 'running' })
        .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
      if (!updated) return false; // cancelled mid-batch
      return true;
    }
    await saveJob(jobId, { status: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() });
    return false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hubspot-engine-fetch-failure.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run the full HubSpot suite to check for regressions**

Run: `npx vitest run tests/hubspot-*.test.ts`
Expected: PASS — all tests green, no regressions (this change only affects the fetch-error path, which no other existing test exercises).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: only the pre-existing unrelated `marked`/`sanitize-html`/`pdf-lib` errors, nothing new.

- [ ] **Step 7: Commit**

```bash
git add src/services/hubspot/importEngine.ts tests/hubspot-engine-fetch-failure.test.ts
git commit -m "fix(hubspot): don't fail the whole import job when one object type's fetch fails"
```

---

### Task 6: Full regression, push, and PR

**Files:** none (verification + git only)

- [ ] **Step 1: Full API test suite**

Run: `npx vitest run`
Expected: same pre-existing failures as the `fix/hubspot-import-robustness` baseline (17 failures across `agent-nodes.test.ts`, `db-optimizations.test.ts`, `financial-validator.test.ts`, `org-isolation.test.ts`, `usage/trackedLLM.test.ts` — none in files this plan touches). If you see failures in files this plan touched, stop and fix before continuing — do not proceed with a red suite.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "marked\|sanitize-html\|pdf-lib"`
Expected: no output (clean).

- [ ] **Step 3: Check for accidental unrelated changes**

Run (from the worktree root, `/Users/ganesh/AI CRM/.worktrees/hubspot-engagements`): `git status --short`
Expected: only files from Tasks 1-5 show as committed (already staged/committed per-task); nothing unexpected untracked. If `package-lock.json` shows as modified, do not commit it — that's `npm install` environment churn, not part of this feature (same as the prior two HubSpot PRs).

- [ ] **Step 4: Push the branch**

```bash
cd "/Users/ganesh/AI CRM/.worktrees/hubspot-engagements"
git push -u origin feat/hubspot-engagement-import
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --title "feat(hubspot): import engagement history (notes/calls/meetings/emails/tasks)" --body "$(cat <<'EOF'
## Summary

Phase 2 of the HubSpot import (see `docs/superpowers/specs/2026-08-05-hubspot-engagement-import-design.md`, and the original phasing in `docs/superpowers/specs/2026-06-29-hubspot-import-design.md`). Extends the existing Companies/Contacts/Deals import (#88, #89) to also pull Notes, Calls, Meetings, Emails, and Tasks, landing them as `ContactInteraction` rows on their associated local contacts.

- All 5 HubSpot engagement types import, always as part of the existing "Import from HubSpot" button (no new toggle)
- Property names verified against HubSpot's CRM v3 docs, not guessed (the Phase 1 postmortem found a real bug from an unverified assumption)
- Tasks have no local equivalent — folded into `ContactInteraction` as `type='OTHER'`, with due date/status/priority in the description text (explicit scope decision, not a full Task entity)
- One `ContactInteraction` row per associated local contact (multi-contact meetings fan out correctly)
- Engagements with no resolvable local contact are skipped, not force-fit elsewhere (contact-scoped only, per spec)
- Reuses the existing batching/cursor/cap-hit-handling engine unchanged — no new architecture
- New `hubspotId` column on `ContactInteraction` (migration included, **must be run manually in Supabase** — Vercel doesn't auto-run SQL, per the standing project gotcha)

## Test plan

- [x] Every step written test-first: RED confirmed for the right reason, then GREEN
- [x] New tests: `hubspot-engagement-mappers.test.ts` (all 5 types' field extraction), `hubspot-client.test.ts` additions (properties + associations), `hubspot-dedup.test.ts` additions (`upsertContactInteractionByHubspotId`), `hubspot-engine-engagements.test.ts` (multi-contact fan-out, skip-with-no-contact, per-batch contact-resolution caching)
- [x] Full API suite: same pre-existing failures as the `fix/hubspot-import-robustness` baseline, none in touched files
- [x] `tsc --noEmit` clean on all touched files

## Deploy step required

**Run `apps/api/hubspot-engagement-import-migration.sql` manually in the Supabase SQL editor after merge** — Vercel ships code but does not run migrations.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Plan self-review notes

- **Spec coverage:** all 5 engagement types (Task 2/3), contact-scoped association resolution + skip rule (Task 5), fan-out for multi-contact engagements (Task 5), dedup via `(contactId, hubspotId)` (Task 4), migration (Task 1), reuse of existing engine/no new UI (implicit — no web-next task exists in this plan, matching the spec's "no new UI" call).
- **Deviation flagged in the spec, carried through here:** engagements with no contact association are skipped, not routed to `Activity` — consistent with the spec's explicit note that this deviates from the original Phase 1 placeholder mapping.
- **Counters:** no new `skipped` counter was added — a skipped engagement increments `processed` only (via the existing unconditional line at the end of the per-record loop), leaving `created`/`updated`/`failed` untouched. This is implicit rather than an explicit visible count; acceptable for this phase since Task 5's test suite verifies the exact counter shape (`processed: 1, created: 0, failed: 0`) for the skip case.
