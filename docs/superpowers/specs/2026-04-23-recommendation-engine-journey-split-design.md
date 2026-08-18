# Recommendation Engine — Journey Type Dashboard Split

**Date:** 2026-04-23
**Project:** Recommendation Engine (Base44 app)
**Asana:** AIWO-37 — "v2 - Base44 69c13f50777aaf9be37c7cf7"
**Owner:** Ganesh Jagtap
**Deadline:** End of week (2026-04-25)
**Status:** Design approved, ready for implementation

## Problem

The Base44 Recommendation Engine app has a single "Personalize Journey" endpoint (742 submissions) that mixes 3 journey types: sponsors, attendees, and awards. Kushal manually downloaded and cleaned the sponsor data into a Google Sheet. The team wants this separation built into the Base44 dashboard so it's always up-to-date and interactive.

## Goal

Add 3 new pages to the Base44 app — Sponsors, Attendees, Awards — each showing a filtered, cleaned table of submissions for that journey type, with summary cards for quick aggregation.

## Acceptance Criteria

1. Submissions are divided by type: sponsors vs attendees vs awards
2. Each type shows a clean table matching Kushal's cleaned Sheet format (type-specific columns only)
3. Dashboard aggregates data per type (summary cards with counts and top values)

## Non-Goals

- Creating new Base44 endpoints (the single Personalize Journey endpoint stays as-is)
- Modifying how forms on client websites submit data
- Data migration or cleanup of existing records
- Export functionality (the existing Export button on Submissions page already handles this)

## Data Source

**Endpoint:** Personalize Journey
- **Endpoint ID:** `69c16e16c3bc910dce0a4c9f`
- **Secret:** `sk_pj_a3f8c2e1d94b760f5a2c318e47d09b6f`
- **Fetch URL:** `https://preview--recommendation-engine-bridged.base44.app/functions/fetchSubmissions?endpoint_id=69c16e16c3bc910dce0a4c9f&secret=sk_pj_a3f8c2e1d94b760f5a2c318e47d09b6f&limit=5000`

## Type Classification Logic

Each submission has a `fields[]` array. Classification rules:

| Type | Rule | Example |
|------|------|---------|
| **Sponsor** | `fields` contains entry with `title: "Journey type"` and `value: "sponsor"` | Grab, ACME, DMG Events |
| **Awards** | `fields` contains entry with `title: "Journey type"` and `value: "awards"` | emap Awards Director |
| **Attendee** | No `Journey type` field present in `fields` array | IT Manager at Ford, military personnel |

## Pages

### Page: Sponsors

**Summary cards (top row):**
- Total Sponsors (count)
- Top Industry (most common value)
- Top Primary Goal (most common value)
- Most Common Budget Range

**Table columns:**
| Column | Source field | Notes |
|--------|------------|-------|
| Received | `created_date` | Formatted as "DD/MM/YYYY, HH:MM:SS" to match Sheet |
| Company name | `fields[title="Company name"].value` | |
| Industry | `fields[title="Industry"].value` | |
| Primary goals | `fields[title="Primary goals"].value` | Multiselect, show comma-separated |
| Target buyers | `fields[title="Target buyers"].value` | Multiselect, show comma-separated |
| Budget range | `fields[title="Budget range"].value` | |
| Summary | `fields[title="Summary"].value` | |
| Domain | `domain` | Client website domain |

Sorted by Received descending.

### Page: Awards

**Summary cards (top row):**
- Total Awards (count)
- Top Award Focus Area (most common)
- Top Role (most common)

**Table columns:**
| Column | Source field | Notes |
|--------|------------|-------|
| Received | `created_date` | |
| Organisation name | `fields[title="Organisation name"].value` | |
| Your role | `fields[title="Your role"].value` | |
| Award focus area | `fields[title="Award focus area"].value` | Multiselect, show comma-separated |
| Project scale | `fields[title="Project scale"].value` | |
| Project description | `fields[title="Project description"].value` | |
| Summary | `fields[title="Summary"].value` | |
| Domain | `domain` | |

Sorted by Received descending.

### Page: Attendees

**Summary cards (top row):**
- Total Attendees (count)
- Top Domain (most common client website)
- Top Interest (most common from Interests/Areas of interest)

**Table columns:**
| Column | Source field | Notes |
|--------|------------|-------|
| Received | `created_date` | |
| Job Title | `fields[title="Job Title"].value` | May be blank for military campaigns |
| Company | `fields[title="Company"].value` | May be blank for military campaigns |
| Interests | `fields[title="Interests"].value` OR `fields[title="Areas of interest"].value` | Whichever exists; multiselect |
| Summary | `fields[title="Summary"].value` | |
| Domain | `domain` | |

Sorted by Received descending. Military-field submissions (Military rank, MOS, Categories) show in the same table — blank cells where civilian fields don't apply.

## Sidebar Navigation (updated)

1. Submissions (existing)
2. Endpoints (existing)
3. **Sponsors** (new) — Users icon or Building icon
4. **Attendees** (new) — UserCheck icon
5. **Awards** (new) — Trophy icon

## Implementation Approach

All 3 pages follow the same pattern:
1. Fetch all Personalize Journey submissions via API (single call, cache/share across pages)
2. Filter by journey type using classification logic above
3. Extract relevant fields from `fields[]` array into flat table rows
4. Compute summary card values from the filtered data
5. Render summary cards + sortable table

This is purely frontend work within the Base44 app — no n8n workflows, no new endpoints, no backend changes.

## Open Questions

- Should pages auto-refresh on an interval, or only on page load? (Defaulting to page load only)
- The `limit=5000` param may not fetch all 742+ submissions if the count grows significantly. Pagination may be needed later.
