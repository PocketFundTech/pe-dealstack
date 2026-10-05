# Data Room index v2 — "Room cards"

Approved by the founder on 2026-09-28. It uses the same visual language as the dashboard and Command Center (shared `src/components/dash/`).

## Goal
Show room status at a glance: **which rooms are in good shape, and which need attention?** It also stays a fast way to find and open a room.

## Data (frontend only, by founder decision)
- **Deal list:** `GET /deals?limit=200` provides the name, industry, stage and status, plus `lastDocument` and `lastDocumentUpdated` for each room's latest upload. First paint is instant.
- **Per-room stats** come from three light endpoints, none of which return document bodies:
  - `GET /deals/:id/folders`: folders with a `fileCount`, which give coverage and the document total.
  - `GET /deals/:id/doc-requests`: open requests with received/total counts.
  - `GET /deals/:id/shares`: live links and their views.
- **Loading behaviour:** at most 4 rooms fetch at a time, in on-screen order. Results are cached for the session and refreshed after 5 minutes. A 404 counts as "none". Each card has its own error state with a retry.
- **Known cost:** about 3 requests per room. A summary endpoint can replace `use-room-stats.ts` later without UI changes.

## Page
- **Masthead:** a date line, "Data Rooms", and a summary: *N active rooms · N documents · N open requests · N live share links* ("counting…" while stats arrive). **New room** opens a side sheet using the same `POST /deals` call and the same 403 message.
- **Toolbar:**
  - Tabs: Active (default) · Needs attention · Passed · All, with counts.
  - Search by room name or industry.
  - Sort: Latest upload · Coverage (unknown last) · Name.
- **Card:**
  - The name, with a brass dot when the room needs attention.
  - Industry, plus "created <date>" when the room name is duplicated.
  - A stage label with the 5-step marker.
  - A coverage meter with one segment per folder, and "X of Y folders · N documents".
  - The latest upload (file-type icon, name, age).
  - Signal chips for requests, shares and the first attention reason.
  - A footer with *Open room →* and *Deal page*. The whole card is clickable.
- **Needs attention:**
  - A live room at Diligence or later with under 50% folder coverage.
  - An open request that expires within 3 days, or that has received nothing after 7+ days.
  - A live share link that expires within 3 days.

## Deviation from the approved design
The approved design had a "Request documents" hover action. The deal page has no URL parameter for its Documents tab, so that link would land on Overview. It was replaced with a plain **Deal page** link, keeping the deal page out of scope.

## Tests
- `room-status.test.ts`: coverage, attention rules, tabs, search, sort and duplicate names.
- A visual check with mock data at 1600px and 390px, covering tabs, search, the New room sheet and the phone toolbar.
