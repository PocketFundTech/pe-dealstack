# KA Analysis Portal V2 — Design Spec

**Date:** 2026-04-21
**Project:** KA Analysis Portal (Base44 app)
**Owner:** Ganesh Jagtap
**Demo:** 2026-04-22 (tomorrow)
**Status:** Design approved, ready for implementation

## Problem

The current KA (Knowledge Agent) analysis workflow outputs to Google Sheets via n8n. Account managers receive flat spreadsheets that are hard to interpret. Maanas has requested rich visualizations via Base44, replacing the spreadsheet output with a client-facing portal.

## Goal

Upgrade the existing Base44 "KA Analysis Portal" app to:
1. Accept input (XLSX file uploads) directly inside the portal
2. Process data via n8n (backend)
3. Display results as rich, interactive visualizations
4. Replace the Google Sheets output entirely

## Non-goals

- Replacing the hardcoded mock SQL data (ClickHouse API access coming later)
- Authentication/access control (open for now)
- Sparkline trends, radar charts, word clouds (unnecessary complexity)
- PDF/Excel export from the portal (view-only for V1)

## Architecture

### Data Flow: Approach A (Base44 → Webhook → n8n → Base44 API)

```
User uploads XLSX in Base44 Upload page
  → Base44 creates Report record (status: "processing")
  → Base44 sends files + reportId to n8n webhook
  → n8n processes:
      1. Parse XLSX files
      2. Merge with mock SQL data (hardcoded)
      3. Calculate All KPIs
      4. AI: Generate Insights (GPT-4o)
      5. AI: Categorize Questions (GPT-4o-mini)
      6. Build output
  → n8n POSTs results back to Base44 API:
      - Update Report record (KPIs + insights + status: "ready")
      - Create AgentMetrics records
      - Create Questions records
      - Create ActionLinks records
      - Create QuestionCategories records
  → Base44 Upload page polls for status change
  → Auto-redirects to Dashboard with new report selected
```

### Entity Changes

**Reports entity — add 1 field:**
```json
"status": { "type": "string", "default": "processing" }
```
Values: `"processing"`, `"ready"`, `"error"`

All other entities (AgentMetrics, Questions, ActionLinks, QuestionCategories) remain unchanged.

## Pages

### Page 1: Upload Report (NEW — 6th sidebar item, top of nav)

**Sidebar:** Upload icon (lucide `Upload`), positioned above Dashboard.

**Form fields:**
- Report Week (text input, placeholder: "e.g. 2026-W15 (Apr 7 - Apr 14)")
- Page Metrics (file upload, .xlsx only)
- Chat History (file upload, .xlsx only)
- [Submit Report] button (indigo, disabled until all 3 fields filled)

**States:**
- **Default:** Form visible, button enabled
- **Processing:** Button replaced with spinner + "Processing report... this may take up to 60 seconds"
- **Ready:** Green banner "Report generated successfully!" → auto-redirect to Dashboard after 2 seconds
- **Error:** Red banner "Something went wrong. Please try again." → button re-enabled

**Below the form:** "Recent Reports" table showing all past reports:
- Columns: Report Week | Status (green badge = Ready, amber = Processing, red = Error) | Actions ([View] button)
- [View] navigates to Dashboard with that report selected
- Sorted by created_date descending

### Page 2: Dashboard (existing — enhanced)

**Existing features (keep):**
- Report selector dropdown
- 8 KPI stat cards (2 rows of 4)
- 3 AI Insight cards with indigo left border
- Top Categories as pills + Top Questions as numbered list

**Enhancements:**
- Add donut chart next to Top Categories showing question distribution by category
- KPI cards get subtle color tint: green for rates above 50%, amber for 20-50%, neutral below

### Page 3: Agent Performance (existing — enhanced)

**Existing features (keep):**
- Report selector
- Overall Engagement bar chart + table
- Loyalty table
- Time Spent chart + table
- Question Performance table
- Feedback table
- Color-coded section headers (yellow, green, purple, blue, red)

**Enhancements:**
- Add funnel chart at the top: Agent Loads → Agent Views → Engagement → Action Takes (conversion drop-off visualization)
- Time Spent section: add prominent green "X% increase" badge next to the chart

### Page 4: Action Data (existing — enhanced)

**Existing features (keep):**
- Report selector
- 4 summary cards
- Action Links table with sortable columns

**Enhancements:**
- Add "Click Rate" column to table (clickCount/viewCount as %)
- Color-code rows: green tint for clicked URLs, neutral for unclicked
- URLs with high views but 0 clicks get amber "Low conversion" badge

### Page 5: Q&A Explorer (existing — enhanced)

**Existing features (keep):**
- Report selector
- Search input + category filter dropdown
- Paginated table (20 rows/page)

**Enhancements:**
- Answer quality badges per row: green "With Source" (has references), amber "No Source", red "Fallback"
- Expandable rows: click a question to see full answer + references inline (instead of cramming into narrow table columns)

### Page 6: Categories (existing — no changes)

Already clean — horizontal bar chart + detail table. Keep as-is.

## Sidebar Navigation (updated order)

1. Upload Report (Upload icon) — `/UploadReport`
2. Dashboard (LayoutDashboard icon) — `/`
3. Agent Performance (Users icon) — `/AgentPerformance`
4. Action Data (Link icon) — `/ActionData`
5. Q&A Explorer (MessageSquare icon) — `/QandA`
6. Categories (PieChart icon) — `/Categories`

## n8n Workflow Changes

Replace the 5 Google Sheets write nodes with 5 Base44 API POST calls:
1. Update Report record (PATCH with KPIs + insights + status: "ready")
2. Create AgentMetrics records (POST, one per agent)
3. Create Questions records (POST, one per question)
4. Create ActionLinks records (POST, one per URL)
5. Create QuestionCategories records (POST, one per category)

Replace the form trigger with a webhook trigger that receives:
- reportId (from Base44)
- files (Page Metrics XLSX + Chat History XLSX as binary)
- reportWeek (text)

Keep the hardcoded mock SQL data node as-is.

## Implementation Order

1. Add `status` field to Reports entity
2. Build Upload Report page in Base44
3. Create webhook endpoint in n8n (replacing form trigger)
4. Wire n8n output to Base44 API (replacing Google Sheets writes)
5. Add visualization enhancements to existing pages
6. End-to-end test: upload → process → view results

## Success Criteria

- User can upload 2 XLSX files + report week from within the portal
- Processing happens in n8n (< 60 seconds)
- Results appear automatically on Dashboard after processing
- All 5 visualization pages render correctly with real processed data
- Past reports accessible via dropdown on any page
- Upload page shows history of all past reports with status
- Demo-ready by 2026-04-22
