# HubSpot Import — Lossless Custom Fields (Phase 1.5)

**Date:** 2026-06-29
**Status:** Approved (design), pending plan
**Builds on:** `2026-06-29-hubspot-import-design.md` (Phase 1, merged PR #67)

## Problem

Phase 1 requests only a hardcoded ~5 properties per object from HubSpot. Any **client-created custom property** (e.g. `fund_vintage`, `sector_focus`, custom deal stages) is silently dropped. For a client delivery this is unacceptable — silently losing their data is worse than a visible error.

There is **no hallucination risk** anywhere: mapping is deterministic code, not AI. This is purely a *coverage* gap, not a *correctness* one. This phase closes the coverage gap.

## Goal

Make the import **lossless for any HubSpot schema**: discover every property the client's account actually has, and preserve all client-created custom properties verbatim in the existing `hubspotProperties` JSONB column. Standard fields continue mapping to first-class PE OS columns exactly as today.

## Scope decision (locked)

**Preserve "custom + meaningful" only** — keep the client's custom properties + our known standard fields; **skip HubSpot internal/system properties** (`hs_*`, owner ids, scores, lifecycle timestamps). Rule is deterministic:

> Keep a property if it is one of our known standard mapped fields **OR** HubSpot marks it `hubspotDefined: false` (= client-created). Drop everything else.

## Non-goals

- Mapping custom fields into dedicated PE OS columns / a field-mapping UI — that is **Option B**, a separate phase. Custom data lands in `hubspotProperties` JSONB (viewable, queryable), not promoted to typed columns.
- Importing HubSpot internal/system fields.
- Any change to dedup, job/engine orchestration, or the UI.

## Design

Deterministic, no AI. Three small changes inside `apps/api/src/services/hubspot/`:

### 1. `client.ts` — discover + request all kept properties
- New method `listPropertyNames(object): Promise<string[]>` → `GET /crm/v3/properties/{object}`. Returns each property's `name` + `hubspotDefined`. Filter to: `hubspotDefined === false` **OR** name ∈ the object's standard set. Reuses the existing 429-backoff request path.
- `listPage(object, opts)` gains an optional `properties?: string[]` param. When provided, it sends that list as the `properties` query param instead of the hardcoded `PROPERTIES[object]`. (Falls back to the hardcoded list when omitted — preserves Phase 1 behavior / existing tests.)
- **URL-length guard:** if the kept-property list is large, the comma-joined `properties` query could approach URL limits. Cap defensively: if > 250 properties, log a warning and request the first 250 (custom properties prioritized ahead of standard). 250 is far above any realistic PE-firm HubSpot config; the cap only exists so a pathological account can't 414 the request. Surface the truncation in logs.

### 2. `importEngine.ts` — fetch property names once per object, pass to listPage
- Before paginating an object type, call `client.listPropertyNames(object)` once and thread the result into each `listPage` call for that object. (Property discovery is per-object, not per-page.)
- Because the mappers already stash any non-standard returned property into `hubspotProperties` (the `rest()` helper), **no mapper change is needed** — once custom properties are *requested*, they flow into the JSONB automatically.

### 3. No schema change
- `hubspotProperties` JSONB already exists on Contact/Company/Deal (Phase 1 migration). This phase just starts populating it meaningfully.

## Reliability properties (the client-delivery answer)

- **Deterministic:** no LLM in the path → zero hallucination. What is imported is copied byte-for-byte from HubSpot.
- **Lossless for custom data:** every client-created property is captured.
- **Re-runnable:** unchanged — merge-blank-only dedup; `hubspotProperties` refreshed on every import.
- **Bounded:** per-object property discovery is one extra API call; the 250-property cap prevents URL blowups (logged if ever hit).

## Testing

- `listPropertyNames` filtering: fixture properties payload (mix of custom `hubspotDefined:false`, standard, and `hs_*` system) → asserts kept = custom + standard, dropped = system.
- `listPage` honors a passed `properties` list (query param assertion) and falls back to the hardcoded list when omitted.
- Mapper test (already exists) confirms custom keys land in `hubspotProperties` — extend with one case proving a discovered custom property is preserved.
- URL-length cap: > 250 properties → truncates + logs, does not throw.

## Rollout

No migration. Ships as a code change; live on next Vercel deploy. Backward-compatible — a re-import after deploy backfills `hubspotProperties` for already-imported records (merge refreshes it).
