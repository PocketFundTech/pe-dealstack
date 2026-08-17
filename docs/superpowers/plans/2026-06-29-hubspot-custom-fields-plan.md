# HubSpot Import — Lossless Custom Fields (Phase 1.5) — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Discover every property in the client's HubSpot account and preserve all client-created custom properties verbatim in the existing `hubspotProperties` JSONB column. Deterministic, no AI, no schema change.

**Spec:** `docs/superpowers/specs/2026-06-29-hubspot-custom-fields-design.md`

**Base:** branch `feature/hubspot-custom-fields` off `main` (Phase 1 merged).

## File Structure

| File | Change |
|---|---|
| `apps/api/src/services/hubspot/client.ts` | add `listPropertyNames(object)`; extend `listPage` to accept optional `properties[]`; export `STANDARD_PROPERTIES` |
| `apps/api/src/services/hubspot/importEngine.ts` | fetch property names per object, pass to `listPage` |
| `apps/api/tests/hubspot-client.test.ts` | add `listPropertyNames` filter tests + `listPage` properties-override test |
| `apps/api/tests/hubspot-mappers.test.ts` | add one case: discovered custom property preserved in `hubspotProperties` |

---

## Task 1: client.ts — property discovery + filtering + listPage override

**Files:** Modify `apps/api/src/services/hubspot/client.ts`; Test `apps/api/tests/hubspot-client.test.ts`

Current relevant code (for reference — confirm before editing):
```typescript
const PROPERTIES: Record<HubSpotObjectType, string[]> = {
  companies: ['name', 'industry', 'domain', 'description'],
  contacts: ['firstname', 'lastname', 'email', 'phone', 'jobtitle', 'associatedcompanyid'],
  deals: ['dealname', 'amount', 'dealstage', 'pipeline', 'description'],
};
// listPage(object, opts: { limit?: number; after?: string }) sets params 'properties' = PROPERTIES[object].join(',')
```

- [ ] **Step 1: Write failing tests** (append to `hubspot-client.test.ts`)

```typescript
import { HubSpotClient, MAX_PROPERTIES } from '../src/services/hubspot/client.js';

describe('HubSpotClient.listPropertyNames', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps custom (hubspotDefined=false) + standard, drops system hs_* / hubspotDefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: [
      { name: 'name', hubspotDefined: true },
      { name: 'fund_vintage', hubspotDefined: false },
      { name: 'sector_focus', hubspotDefined: false },
      { name: 'hs_object_id', hubspotDefined: true },
      { name: 'hubspot_owner_id', hubspotDefined: true },
    ] })));
    const names = await new HubSpotClient('tok').listPropertyNames('companies');
    expect(names).toContain('fund_vintage');
    expect(names).toContain('sector_focus');
    expect(names).toContain('name');            // standard kept
    expect(names).not.toContain('hs_object_id'); // system dropped
    expect(names).not.toContain('hubspot_owner_id');
  });

  it('caps the list at MAX_PROPERTIES (custom prioritized), without throwing', async () => {
    const many = Array.from({ length: MAX_PROPERTIES + 50 }, (_, i) => ({ name: `custom_${i}`, hubspotDefined: false }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: many })));
    const names = await new HubSpotClient('tok').listPropertyNames('contacts');
    expect(names.length).toBe(MAX_PROPERTIES);
  });
});

describe('HubSpotClient.listPage properties override', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('sends the supplied properties list in the query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    await new HubSpotClient('tok').listPage('companies', { limit: 20, properties: ['name', 'fund_vintage'] });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('properties=name%2Cfund_vintage');
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL** — `cd apps/api && npx vitest run tests/hubspot-client.test.ts` → fail (MAX_PROPERTIES / listPropertyNames undefined).

- [ ] **Step 3: Implement.** In `client.ts`:
  - Export `export const MAX_PROPERTIES = 250;`
  - Export the standard sets: rename the existing `PROPERTIES` const to `export const STANDARD_PROPERTIES` (update its internal uses in `listPage`).
  - Add the method:

```typescript
async listPropertyNames(object: HubSpotObjectType): Promise<string[]> {
  const res = await this.requestWithBackoff(`${BASE}/crm/v3/properties/${object}`);
  if (!res.ok) {
    // Non-fatal: fall back to the standard set so import still runs.
    log.warn(`[hubspot] property discovery failed for ${object}: ${res.status}`);
    return [...STANDARD_PROPERTIES[object]];
  }
  const data = (await res.json()) as { results?: Array<{ name: string; hubspotDefined?: boolean }> };
  const std = new Set(STANDARD_PROPERTIES[object]);
  const all = (data.results ?? []).filter((p) => p.hubspotDefined === false || std.has(p.name)).map((p) => p.name);
  // Ensure every standard field is present even if the account hid it.
  for (const s of STANDARD_PROPERTIES[object]) if (!all.includes(s)) all.push(s);
  if (all.length > MAX_PROPERTIES) {
    // Prioritize custom (non-standard) names, then standard, up to the cap.
    const custom = all.filter((n) => !std.has(n));
    const standard = all.filter((n) => std.has(n));
    const capped = [...custom, ...standard].slice(0, MAX_PROPERTIES);
    log.warn(`[hubspot] ${object} has ${all.length} kept properties; capping at ${MAX_PROPERTIES}`);
    return capped;
  }
  return all;
}
```
  - Extend `listPage` signature to `opts: { limit?: number; after?: string; properties?: string[] }` and set the query from `opts.properties ?? STANDARD_PROPERTIES[object]`:

```typescript
const props = opts.properties && opts.properties.length ? opts.properties : STANDARD_PROPERTIES[object];
params.set('properties', props.join(','));
```

- [ ] **Step 4: Run tests, verify PASS** (new + existing client tests all green).

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit` → no new errors in client.ts.

- [ ] **Step 6: Commit** — `git add apps/api/src/services/hubspot/client.ts apps/api/tests/hubspot-client.test.ts && git commit -m "feat(hubspot): discover + request custom properties (lossless import)"`

---

## Task 2: importEngine.ts — thread discovered properties into pagination

**Files:** Modify `apps/api/src/services/hubspot/importEngine.ts`

Current: `page = await client.listPage(current, { limit: BATCH, after: job.cursor ?? undefined });`

- [ ] **Step 1: Implement.** Before the `listPage` call in `runImportBatch`, discover the current object's properties once for this batch and pass them in:

```typescript
const properties = await client.listPropertyNames(current);
let page;
try {
  page = await client.listPage(current, { limit: BATCH, after: job.cursor ?? undefined, properties });
} catch (err) { /* unchanged failure handling */ }
```

No other change — the mappers' existing `rest()` helper already stashes any non-standard returned property into `hubspotProperties`, so discovered custom fields now flow into the JSONB automatically.

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → no new errors in importEngine.ts.

- [ ] **Step 3: Commit** — `git add apps/api/src/services/hubspot/importEngine.ts && git commit -m "feat(hubspot): import all discovered custom properties per object"`

---

## Task 3: Mapper test — prove custom property preserved

**Files:** Modify `apps/api/tests/hubspot-mappers.test.ts`

- [ ] **Step 1: Add a test** asserting a discovered custom property lands in `hubspotProperties`:

```typescript
it('preserves a client custom property verbatim in hubspotProperties', () => {
  const out = mapCompany({ id: '1', properties: { name: 'Acme', fund_vintage: '2021', sector_focus: 'SaaS' } });
  expect(out.hubspotProperties).toEqual({ fund_vintage: '2021', sector_focus: 'SaaS' });
  expect(out.name).toBe('Acme'); // standard still promoted
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/hubspot-mappers.test.ts` → all pass (the mapper already behaves this way; this locks it in).

- [ ] **Step 3: Commit** — `git add apps/api/tests/hubspot-mappers.test.ts && git commit -m "test(hubspot): lock custom-property preservation in mapper"`

---

## Task 4: Full verification

- [ ] **Step 1:** `cd apps/api && npx vitest run tests/hubspot-*.test.ts` → all hubspot suites pass.
- [ ] **Step 2:** `npx tsc --noEmit` → no new errors in hubspot files.
- [ ] **Step 3:** Confirm no regression vs baseline failures (db-optimizations, financial-validator, org-isolation, trackedLLM, plus flaky syncEngine/langextract under parallelism — all pre-existing).

---

## Self-Review

- **Spec coverage:** discovery (T1), filtering custom+standard / drop system (T1), request-all + listPage override (T1), engine threading (T2), URL cap (T1), preservation proof (T3). No mapper code change needed (intentional — `rest()` already handles it). No schema change (column exists). ✓
- **Backward compat:** `listPage` `properties` is optional → Phase 1 callers/tests unaffected. `PROPERTIES`→`STANDARD_PROPERTIES` rename is internal; update all references. ✓
- **Type consistency:** `listPropertyNames(object): Promise<string[]>`, `MAX_PROPERTIES` exported, `listPage` opts extended — consistent across T1/T2. ✓
