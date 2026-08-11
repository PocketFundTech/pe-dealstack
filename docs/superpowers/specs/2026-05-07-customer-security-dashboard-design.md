# Customer Security Dashboard — Design Spec

> **Status:** Spec ready to build
> **Tracker:** [`docs/SECURITY-TRUST-MASTER-TODO.md`](../../SECURITY-TRUST-MASTER-TODO.md)
> **Builds on:** PR #30 (staff access log) + PR #31 (per-deal timeline) + existing audit-log infra

---

## The single sentence

A single dashboard, accessible to admins, that summarizes the org's security posture in 6 metric cards — active sessions, MFA enrollment %, Pocket Fund staff accesses, failed logins, recent admin actions, top-accessed deals — so a compliance officer can verify trust in 30 seconds.

---

## Why

Each of the trust features we've shipped so far surfaces ONE signal in ONE place:
- Activity feed lives on Admin Dashboard
- Staff access log lives in Settings → Security
- Per-deal access timeline lives on each deal page
- MFA toggle lives in Settings → Team
- Active sessions list lives in Settings → Security (per-user)

A compliance officer asking *"how secure is our usage?"* has to click through 5 surfaces. This dashboard rolls all of it into one page.

**Demo line:**

> *"Want to show your compliance officer your org's security state in one screenshot? Here. Six metrics, one page."*

---

## Non-goals

- IP-geolocation-based anomaly alerts (needs a geo IP service; defer)
- Real-time live updates via WebSocket (poll-on-load + manual refresh is enough for v1)
- AI inference / model audit metrics (separate feature)
- Per-user drill-down dashboards (admins look at the org-level summary; per-user is the activity feed's job)
- Exportable PDF compliance report (separate feature)

---

## What ships

### Backend: `GET /api/admin/security/dashboard`

Returns aggregated metrics. **All queries org-scoped.** Admin/partner/principal-only (returns 403 otherwise).

```json
{
  "windowDays": 30,
  "activeSessions": 7,
  "members": {
    "total": 12,
    "mfaEnrolled": 9,
    "mfaPercent": 75,
    "requireMFA": false
  },
  "staffAccess": {
    "windowDays": 90,
    "count": 0
  },
  "failedLogins": {
    "windowDays": 7,
    "count": 2
  },
  "adminActions": {
    "windowDays": 30,
    "total": 14,
    "recent": [
      { "action": "USER_INVITED", "userName": "Sarah Chen", "createdAt": "..." },
      ...
    ]
  },
  "topDeals": [
    { "dealId": "abc", "dealName": "Acme Hardware", "views": 47, "uniqueViewers": 5 },
    ...
  ]
}
```

#### Implementation

- New file `apps/api/src/routes/admin-security-dashboard.ts`, mounted alongside existing `adminSecurityRouter` at `/api/admin/security`
- Single handler `GET /dashboard` that runs ~6 queries in parallel via `Promise.all`:
  1. **Active sessions:** Count rows in `auth.sessions` joined to `User` for this org (graceful degradation if `auth` schema not exposed — return `null`, frontend shows "Unknown")
  2. **Members + MFA:** Count `User` where `organizationId = X`. For MFA, can't easily query Supabase Auth admin API in bulk — for v1 return total count + skip MFA stat (set `mfaEnrolled: null`, `mfaPercent: null`); admins can check individual users via existing flows. Document as v1 limitation.
  3. **Staff access:** `getAuditLogs({ organizationId, action: STAFF_ACCESS, startDate: 90d })`, return `count`.
  4. **Failed logins:** `getAuditLogs({ organizationId, action: LOGIN_FAILED, startDate: 7d })`, return `count`.
  5. **Admin actions:** `getAuditLogs({ organizationId, action: USER_INVITED|USER_ROLE_CHANGED|SETTINGS_CHANGED|ORG_DATA_EXPORTED|ORG_MFA_REQUIRED, startDate: 30d })`. Aggregate count + return top 5 most recent with action + userName + createdAt.
  6. **Top deals:** `getAuditLogs({ organizationId, action: DEAL_VIEWED, resourceType: DEAL, startDate: 30d, limit: 1000 })` then aggregate by entityId, sort by view count, return top 5 with entityName + count + uniqueViewers.

- Also fetch `Organization.requireMFA` from a lightweight Supabase query.

- Best-effort: if any individual sub-query errors, return that field as `null` and log a warn — don't 500 the whole dashboard.

### Frontend: new component `apps/web-next/src/app/(app)/admin/SecurityDashboard.tsx`

Server-or-client component (client, since it has refresh + interactive metric cards). Fetched from a new tab/section in admin-dashboard page. 6-card grid (3x2 on desktop, 1-col on mobile):

| Card | Visual |
|---|---|
| **Active sessions** | Big number + small caption "across your team right now" |
| **MFA enrollment** | "9 / 12 members" + percent ring + "Required org-wide ✓ / Optional" pill |
| **Pocket Fund staff access** | Big number + "0 in last 90 days" green-check style if zero |
| **Failed logins (7d)** | Big number + "across your org last 7 days"; red border if > some threshold (e.g., 10) |
| **Admin actions (30d)** | Count + small list of top 3 (action, who, when) |
| **Most-viewed deals (30d)** | Top 3 with deal name + view count |

Each card has a deep-link to the underlying detail (e.g., MFA card → Settings/Team; Staff access → Settings/Security; Failed logins → Activity Feed filtered to LOGIN_FAILED).

**Empty/null states:** when a metric is `null`, show a neutral placeholder *"Unavailable"* with a small info icon explaining the limitation (e.g., "Active sessions require Supabase auth schema to be exposed").

**Refresh button** at the top right: re-fetches all metrics.

### Wire into admin dashboard

Approach: simplest is a **new top-level section** in the admin dashboard layout, above the existing Activity Feed. No tab switcher needed; just additional content.

If the admin dashboard already has a tab system, add a "Security" tab. Otherwise, render `<SecurityDashboard />` in a clearly-titled section.

### Tests

`apps/api/tests/admin-security-dashboard.test.ts` covering:
- Returns 403 for non-admin role
- Returns aggregated structure with all 6 fields
- Gracefully degrades when individual sub-queries fail (returns nulls, not 500)

---

## Acceptance criteria

- [ ] `GET /api/admin/security/dashboard` returns the JSON shape above
- [ ] Non-admin gets 403
- [ ] When called for an org with 0 staff accesses, 0 failed logins, the response shows zero counts (not nulls)
- [ ] When `auth` schema not exposed, `activeSessions` is `null` and the rest of the response is unchanged
- [ ] Frontend dashboard renders all 6 cards with their values
- [ ] "Most-viewed deals" card links to the deal detail page (clickable deal name)
- [ ] Refresh button re-fetches and updates the cards

---

## Demo line

> *"One screenshot you can hand to your compliance officer. Active sessions, MFA enrollment, staff access, failed logins, admin actions, and the deals getting the most attention. All filtered to your org. All updated in real time."*

---

## File-level changes

| File | Change |
|---|---|
| `apps/api/src/routes/admin-security-dashboard.ts` | New — `GET /dashboard` endpoint |
| `apps/api/src/app.ts` | Modified — mount on `/api/admin/security` (alongside existing `adminSecurityRouter`) |
| `apps/web-next/src/app/(app)/admin/SecurityDashboard.tsx` | New — 6-card grid |
| `apps/web-next/src/app/(app)/admin/page.tsx` | Modified — render `<SecurityDashboard />` above Activity Feed (or in a new tab) |
| `apps/api/tests/admin-security-dashboard.test.ts` | New — vitest tests |

No migration needed. No new env var. Aggregates entirely on existing data.

---

*Design reviewed by: Claude (Opus 4.7). Approved by: Ganesh (auto mode authorization).*
