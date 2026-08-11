# Per-Deal Access Timeline — Design Spec

> **Status:** Spec ready to build
> **Tracker:** [`docs/SECURITY-TRUST-MASTER-TODO.md`](../../SECURITY-TRUST-MASTER-TODO.md) → next after Priority 1
> **Builds on:** PR #30 (staff access log) + existing audit-log infrastructure

---

## The single sentence

On every deal detail page, a small card shows *"This deal has been viewed N times by M users in the last 30 days"* + a list of the last 5 viewers (name, last-viewed timestamp), so PE associates know who on their team has touched the deal — and who from outside their team should not have.

---

## Problem statement

Three intersecting needs that today's product cannot answer:

1. **Deal team visibility** — *"Has my partner reviewed this LOI yet?"* PE associates have to ask in Slack. The data exists; it's just not surfaced.
2. **Security forensics** — *"Wait — who from the firm has been looking at this confidential deal?"* Admin Dashboard audit feed shows the org-wide stream but doesn't easily filter to one deal.
3. **Demo gap** — every prospect's CTO asks *"can I see who in my team has accessed each deal?"* Today: indirectly, by filtering the global audit feed. Awkward. Undifferentiated.

This widget makes per-deal access a first-class surface. It also closes a logging gap — `DEAL_VIEWED` is currently a defined audit action that **nothing actually writes**, so the org-wide audit feed is missing a critical signal.

---

## What success looks like

**Demo:**

1. Sales opens any deal in the demo workspace
2. On the right side of the deal detail page, a small "Deal access" card shows:
   - **Count:** "Viewed 47 times by 5 users in the last 30 days"
   - **Top viewers:** Sarah Chen (Partner) — viewed 3 minutes ago · 12 times this week · John Doe (Associate) — viewed 2 hours ago · 8 times · ...
   - **"View full activity log →"** link to Admin Dashboard pre-filtered to this deal
3. Sales: *"Want to know who on your team has been on a deal? Click any deal — there it is, every view by every team member."*

**Internal use:**

- A PE associate opening their pipeline can scan deal cards and see "Partner Sarah viewed 3h ago" without asking
- An admin investigating an unusual access pattern (or a leak suspicion) sees the per-deal trail in seconds

---

## Non-goals

- **Per-document access timeline** — separate feature (queued; complements this with watermarking)
- **Email notifications** when someone views your deal — future enhancement (could spam)
- **Per-deal access controls** ("only Partners on the IC can see this deal") — separate Phase 2 feature
- **AI inference audit trail** — separate feature; this spec is just human views
- **External viewer tracking** (counsel, banker portals) — covered by the future "auto-expiring share links" spec

---

## How it works (3 pieces)

### 1. Capture the event (currently missing)

Add a `logFromRequest(req, AUDIT_ACTIONS.DEAL_VIEWED, …)` call inside the existing `GET /api/deals/:id` route handler. Best-effort — never blocks the response. Captures:

- `userId`, `userEmail`, `userRole`, `organizationId`
- `entityType: DEAL`, `entityId: dealId`, `entityName: deal.name`
- `description: "Viewed deal: <name>"`
- Severity: `INFO`

**Important:** also instrument the bulk list endpoint (`GET /api/deals`) — logged at `INFO` severity but with **no entity binding** (it's a list view, not a specific deal). Wait, that's not useful for the widget. So **only instrument the single-deal GET**, not the list. List views are too noisy and not meaningful for "who looked at this deal."

### 2. Aggregate the events

New endpoint: `GET /api/deals/:dealId/access-timeline`

Returns:

```json
{
  "dealId": "abc-123",
  "windowDays": 30,
  "totalViews": 47,
  "uniqueViewers": 5,
  "viewers": [
    {
      "userId": "u1",
      "userName": "Sarah Chen",
      "userEmail": "sarah@acme-fund.com",
      "userRole": "PARTNER",
      "lastViewedAt": "2026-05-07T15:30:00Z",
      "viewCount": 12
    },
    ...
  ]
}
```

- Org-scoped (uses `verifyDealAccess(dealId, orgId)` first)
- Returns up to 10 viewers, ordered by lastViewedAt DESC
- Window default 30 days, configurable via `?days=N` param (max 365)
- Reuses existing `getAuditLogs` filter by `resourceType: DEAL`, `resourceId: dealId`, `action: DEAL_VIEWED`
- Aggregates client-side in the route handler (in-memory groupBy on userId)

### 3. Surface the data

A new client component `DealAccessTimeline` rendered inside the deal detail page. Compact card:

- Header: small icon + "Deal access" title
- Stats row: bold count + "viewed by N users in last 30 days"
- Top 5 viewers: each row is name + role + relative timestamp + view count
- Footer: "View full activity log →" deep-link to Admin Dashboard pre-filtered

Empty state when count is 0: *"No views logged yet for this deal. Activity will appear here as your team reviews it."*

---

## Component design

### Backend

#### Modify `apps/api/src/routes/deals.ts`

Inside the existing `GET /:id` handler, after the deal is loaded and access verified, fire-and-forget an audit event:

```ts
import { logFromRequest } from '../services/auditLog.js';
// ...
logFromRequest(req, 'DEAL_VIEWED', {
  entityType: 'DEAL',
  entityId: deal.id,
  entityName: deal.name,
  description: `Viewed deal: ${deal.name}`,
}).catch((err) => log.warn('DEAL_VIEWED audit failed', { err, dealId: deal.id }));
```

Place after the response is sent (use `res.on('finish', ...)` or just before `return res.json(...)` with `.catch` swallowing errors). Best-effort.

#### New route file `apps/api/src/routes/deal-access-timeline.ts`

Express router with one endpoint:

```ts
GET /:dealId/access-timeline?days=30
```

- Calls `verifyDealAccess(dealId, getOrgId(req))` — returns 404 if not in this org
- Calls `getAuditLogs({ resourceType: 'DEAL', resourceId: dealId, action: 'DEAL_VIEWED', organizationId: orgId, startDate, limit: 1000 })`
- Aggregates by userId in-memory
- Sort descending by `lastViewedAt`
- Slice to top 10 viewers
- Return the JSON shape above

Mounted in `app.ts`:

```ts
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealAccessTimelineRouter);
```

(Mounted alongside the existing `dealsRouter`, before it so `/api/deals/:id/access-timeline` matches first.)

### Frontend (`apps/web-next`)

#### New component `apps/web-next/src/app/(app)/deals/[dealId]/DealAccessTimeline.tsx`

Server-or-client component (client, since it has interactive refresh and live data). Fetches `/api/deals/:dealId/access-timeline` on mount. States:

- **Loading:** small skeleton
- **Empty (count = 0):** muted *"No views logged yet"*
- **Populated:** stats line + viewer list

Style: compact card matching the existing deal page sidebar conventions. Uses `cn()` and Tailwind utilities. Banker Blue `#003366` for primary text/accents.

#### Wire into deal detail page

Locate the deal detail page (likely `apps/web-next/src/app/(app)/deals/[dealId]/page.tsx`). Add `<DealAccessTimeline dealId={deal.id} />` to the right sidebar / metadata column.

---

## User flows

### Flow A — Associate sees who's been on a deal

1. User logs in, opens `/deals/abc-123`
2. Right sidebar shows a "Deal access" card
3. Stats: "Viewed 12 times by 3 users in the last 30 days"
4. Top viewers: Partner Sarah (last viewed 4h ago, 5 times), Associate John (1d ago, 6 times), self (just now, 1 time)
5. User has the answer to "did Sarah see this yet" without asking

### Flow B — Admin investigates a confidential deal

1. Admin gets a tip that a deal that was supposed to be IC-only might have been seen by junior associates
2. Opens the deal page
3. "Deal access" card shows the actual list — admin can verify
4. Clicks "View full activity log →" → Admin Dashboard pre-filtered to this deal's audit events for full forensics

### Flow C — Demo

1. Sales clicks any deal in the demo workspace
2. "Deal access" card visible immediately on right sidebar
3. Sales: *"Pretty common question — can you tell who on your team has touched a deal? Yes. Right here. Every deal."*

---

## Acceptance criteria

- [ ] `GET /api/deals/abc-123` writes a `DEAL_VIEWED` audit event with `entityType=DEAL`, `entityId=abc-123`, `userId`, `organizationId`
- [ ] `GET /api/deals/abc-123/access-timeline` returns:
  - `totalViews: number` matching the `DEAL_VIEWED` event count for that deal in last 30 days
  - `uniqueViewers: number` matching distinct userIds
  - `viewers[]` sorted by `lastViewedAt` DESC, max 10 entries, with `userName` + `userEmail` + `userRole` + `viewCount`
- [ ] Cross-org access returns 404 (verifyDealAccess enforces)
- [ ] Frontend card on deal detail page renders the data with a clean empty state
- [ ] No regression on existing GET `/api/deals/:id` performance (audit-write is fire-and-forget)
- [ ] Vitest unit tests for the aggregation endpoint (mocked Supabase)

---

## Out of scope (intentional)

- Persisted view counts per (dealId, userId) — current design re-aggregates from audit log on each request. If perf becomes a concern at scale, add a materialized aggregation (Phase 2).
- Watermarking / per-document access — separate feature in the queue.
- Anomaly alerts ("user X viewed deal 500 times today") — separate feature.

---

## Demo line

> *"Want to know who on your team has been on a deal? Click any deal. Every view, every viewer, every timestamp — right there in the sidebar."*

---

## File-level changes (for the implementation step)

| File | Change |
|---|---|
| `apps/api/src/routes/deals.ts` | Modified — fire `DEAL_VIEWED` audit event in `GET /:id` |
| `apps/api/src/routes/deal-access-timeline.ts` | New — `GET /:dealId/access-timeline` endpoint |
| `apps/api/src/app.ts` | Modified — mount `dealAccessTimelineRouter` before `dealsRouter` |
| `apps/web-next/src/app/(app)/deals/[dealId]/DealAccessTimeline.tsx` | New — UI card |
| `apps/web-next/src/app/(app)/deals/[dealId]/page.tsx` | Modified — render `<DealAccessTimeline />` in sidebar |
| `apps/api/tests/deal-access-timeline.test.ts` | New — vitest unit tests |

No migration needed. Builds entirely on existing audit log infrastructure.

---

*Design reviewed by: Claude (Opus 4.7). Approved by: Ganesh (auto mode authorization).*
