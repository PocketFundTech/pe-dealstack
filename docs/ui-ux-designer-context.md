# Avise — UI/UX Designer Context Document

> Product: AI-powered CRM for Private Equity deal management
> Stack: Vanilla JS frontend + React (VDR only) | Tailwind CSS | Material Symbols icons
> This doc covers the 3 core pages you'll be working on: **Dashboard**, **Deal Pipeline**, and **Virtual Data Room (VDR)**.

---

## Design System

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| **Primary (Banker Blue)** | `#003366` | Primary buttons, active nav, links, brand accent |
| **Primary Hover** | `#002855` | Hover state for primary elements |
| **Primary Light** | `#E6EEF5` | Hover backgrounds, selected states, subtle fills |
| **Secondary (Emerald)** | `#059669` | Success states, AI features, secondary actions |
| **Secondary Light** | `#D1FAE5` | AI feature backgrounds, success fills |
| **Background** | `#F8F9FA` | Page body background |
| **Surface** | `#FFFFFF` | Cards, panels, modals |
| **Border Subtle** | `#E5E7EB` | Card borders, input borders, dividers |
| **Border Focus** | `#CBD5E1` | Focus ring borders |
| **Text Main** | `#111827` | Headings, labels, primary content |
| **Text Secondary** | `#4B5563` | Descriptions, metadata |
| **Text Muted** | `#9CA3AF` | Placeholders, hints, disabled text |

**Semantic Colors:**
- **Critical/Error:** bg `#FEF2F2`, border `#FECACA`, text `#991B1B`
- **Warning:** bg `#FFFBEB`, border `#FDE68A`, text `#92400E`
- **Success:** bg `#ECFDF5`, border `#A7F3D0`, text `#065F46`
- **Info:** bg `#F3F4F6`, border `#D1D5DB`, text `#374151`

### Typography

- **Font:** Inter (400, 500, 600, 700)
- **Headings:** Inter 600-700, `#111827`
- **Body:** Inter 400-500, `#4B5563`
- **Captions/Labels:** Inter 500-600, uppercase `text-xs` for table headers

### Spacing

- Container padding: `24px` (p-6)
- Section gaps: `24px` (gap-6)
- Card internal padding: `16-24px` (p-4 to p-6)
- Component gaps: `8-12px` (gap-2 to gap-3)

### Border Radius

- Inputs/small elements: `6px`
- Cards/panels: `8px`
- Modals: `12px`
- Pills/badges: `9999px` (full)

### Shadows

- **Card (resting):** `0 1px 3px rgba(0,0,0,0.05), 0 1px 2px -1px rgba(0,0,0,0.05)`
- **Card (hover):** `0 10px 15px -3px rgba(0,0,0,0.05), 0 4px 6px -4px rgba(0,0,0,0.05)`
- **Glow (brand):** `0 0 15px rgba(0,51,102,0.1)`

### Icons

- **Library:** Google Material Symbols Outlined
- **Sizes:** 14px (inline), 16-18px (buttons), 20px (nav/header), 24px+ (display)
- **Common:** `dashboard`, `work`, `folder_open`, `groups`, `auto_awesome` (AI), `notifications`, `search`, `add`, `edit`, `delete`, `chevron_right`, `close`

### Animations

- Default transitions: `0.2s ease` for colors, shadows
- Card hover lift: `translateY(-1px)` + shadow increase
- Modal entry: `fadeIn 0.2s` + backdrop blur
- Slide-in: `0.3s` from right/top with opacity

---

## Shared Layout

### Sidebar (256px wide)

```
+---------------------------+
| [icon] Avise        [<<]  |  64px header
+---------------------------+
| [icon] Dashboard          |
| [icon] Deals              |
| [icon] Data Room          |
| [icon] Contacts           |
|                           |
| AI TOOLS                  |  section label
| [icon] Deal Chat          |
| [icon] Portfolio AI       |
|                           |
| ~~~~~~~~~~~~~~~~~~~~~~~~~ |  spacer
| [avatar] User Name        |
|   Role                    |
| [Invite Team] [Settings]  |
+---------------------------+
```

- Active item: `bg-primary`, white text
- Hover: `bg-primary-light`, primary text
- AI section items: `bg-secondary-light` hover
- Collapsible on mobile (hamburger menu)

### Header (64px)

```
[Menu] [Breadcrumb: Dashboard > Page] [Search ⌘K] ............. [+ Action] [Bell] [Avatar ▾]
```

- Sticky top
- Search bar: CMD+K shortcut, rounded input
- Notification bell with unread dot
- User dropdown: profile, settings, help, logout

---

## Page 1: Dashboard

**URL:** `/dashboard.html`
**Purpose:** Morning command center — see priorities, tasks, AI signals, portfolio at a glance.

### Layout Structure

```
+------------------------------------------------------------------+
| Good [Morning/Afternoon], [Name]                                  |
| Here is your deal flow update and AI market analysis for [Date]   |
+------------------------------------------------------------------+

+------------+  +------------+  +------------+  +------------+
| Sourcing   |  | Due Dili.  |  | LOI/Offer  |  | Closed     |  <- Pipeline Stats (4 cards)
| 5 deals    |  | 3 deals    |  | 2 deals    |  | 1 deal     |     Count + % bar
+------------+  +------------+  +------------+  +------------+

+------------------------------------------------------------------+
| Active Priorities                                    [View All]   |  <- Full-width table
|------------------------------------------------------------------|
| DEAL NAME         | STAGE      | VALUE  | NEXT ACTION  | TEAM   |
| Project Cedar     | LOI/OFFER  | $160M  | Negotiate    | [@@]   |
| Apex Precision    | DUE DILI.  | $42M   | QoE analysis | [@]    |
+------------------------------------------------------------------+

+--------------------+  +--------------------+  +--------------------+
| My Tasks       [0] |  | AI Deal Signals    |  | Portfolio          |
| [checkbox] Task 1  |  | [Scan Signals]     |  | Allocation         |
| [checkbox] Task 2  |  |                    |  | [Pie Chart]        |
| [checkbox] Task 3  |  | Signal cards...    |  | [Legend]           |
| [View All Tasks]   |  |                    |  |                    |
+--------------------+  +--------------------+  +--------------------+
```

### Key Components

**1. Pipeline Stats Cards** (4-column grid)
- Each card: deal count + colored percentage bar
- Stages: Sourcing, Due Diligence, LOI/Offer, Closed
- Data from active deals API

**2. Active Priorities Table** (full-width, spans all columns)
- Sortable by priority (HIGH > MEDIUM > LOW)
- Stage badges: color-coded pills
- Value: formatted currency ($XXM)
- Team: avatar stack (max 3 shown, +N overflow)
- Click row → navigate to deal page
- Empty state when no active deals

**3. My Tasks Widget**
- Checkbox toggle (complete/incomplete with strikethrough)
- Priority indicators: HIGH = red dot, LOW = gray dot
- Due dates: "Today", "Tomorrow", "2d", "Overdue" (red)
- Max 5 visible, "View All Tasks" opens modal
- Badge shows pending task count

**4. AI Deal Signals Widget**
- "Scan Signals" button triggers GPT-4o portfolio analysis
- Signal types: leadership_change, financial_event, market_shift, competitive_threat, regulatory_change, growth_opportunity, risk_escalation
- Severity cards: critical (red), warning (amber), info (blue)
- Empty state before first scan

**5. Portfolio Allocation Widget**
- CSS conic-gradient pie chart (not Chart.js)
- Top 4 industries colored, rest as "Others"
- Horizontal legend with percentages
- Dynamic from deal industry data

**6. Expansion Widgets** (12 optional, user opt-in via "Customize Dashboard")

All hidden by default. User enables them via the "Customize Dashboard" panel. Preferences saved per user (localStorage + API). Drag-to-reorder supported.

| Widget | What It Shows | Why It Exists | Interactions |
|--------|--------------|---------------|--------------|
| **Quick Actions** | 4-button grid: New Deal, Upload Doc, Add Contact, Create Task | Fast shortcuts to common workflows. "Create Task" only visible to admin/partner roles. | Click → navigates to relevant page or opens modal |
| **Deal Funnel** | Horizontal bars per stage (Sourcing → Closed) with deal counts and % of total | Visualizes pipeline conversion at a glance — how many deals survive each stage. | Read-only visualization |
| **Recent Activity** | Top 10 audit log entries grouped by day — who did what, when | Keeps the team aware of deal activity without checking each deal individually. | Read-only timeline with avatars and timestamps |
| **Upcoming Deadlines** | Next 14 days of tasks with due dates, color-coded by urgency | Prevents missed deadlines — red=overdue, orange=today/1-2d, blue=3-7d, gray=7-14d. | Read-only, shows deal associations |
| **Quick Notes** | Persistent text scratchpad with auto-save | Personal scratch space for quick thoughts — saves to localStorage per user. No formatting, just raw text. | Type freely, auto-saves on blur, shows last save time |
| **Key Contacts** | Top 5 contacts ranked by relationship score (0-100) | Quick access to most important relationships. Score = recency + frequency + deal involvement. Color badges: Strong (green >75), Active (emerald), Warm (amber), Cold (blue ≤25). | Click → navigates to contacts page |
| **Team Performance** | Top 6 team members with active deal count, pending tasks, capacity bar | Manager view — who's overloaded vs. underutilized. Capacity bar: red=80%+, orange=50%+, blue=<50%. | Read-only |
| **Document Alerts** | Top 8 documents needing action — "Pending" or "Ready for AI" status | Surfaces documents that need review or AI analysis before they get lost. | Click → navigates to deal's document section |
| **Calendar** | Next 7 days of tasks and deal milestones grouped by date | Simple timeline view — tasks and target close dates in one place. | Read-only |
| **Watchlist** | Companies being monitored but not in active pipeline | Track companies before creating a deal — early-stage interest list. | Add companies via modal, hover-delete to remove |
| **Market Multiples** | Static reference table of EV/EBITDA and EV/Revenue by sector (8 sectors) | Quick valuation reference for deal screening. Illustrative data (Q1 2026). | Read-only, horizontal-scrollable table |
| **Capital Deployed** | *(Coming soon)* | Portfolio-level capital tracking. | — |

**Customize Dashboard Panel:**
- Opened via "Customize Dashboard" button at page bottom
- Modal with categorized widget list (Core, AI-Powered, Productivity, Deal Flow, Portfolio, Market, Team, Documents)
- Checkboxes to show/hide each widget
- "Soon" badges on unimplemented widgets
- Search filtering within the panel
- **Drag-to-reorder:** When editing, drag handles appear on widget title bars. Dashed outlines show drop targets. "Done" button or Esc exits edit mode.

### AI Search (Command Palette)

Triggered by **Cmd+K** or clicking the search bar in the header. Available on all pages.

- **What it does:** Natural language search across the entire portfolio. Powered by GPT-4o.
- **Suggestions dropdown on focus:** Recent searches (last 5) + quick action shortcuts (Create New Deal, View AI Reports)
- **Search flow:** User types → presses Enter → modal opens with AI response including formatted text, related deals with links, and context (active deals analyzed, avg IRR)
- **Navigation:** Arrow keys to browse, Enter to select, Esc to close

### Notifications Dropdown

Bell icon in header with red unread badge.

- **Types:** DEAL_UPDATE (blue), DOCUMENT_UPLOADED (green), MENTION (purple), AI_INSIGHT (amber), TASK_ASSIGNED (orange), COMMENT (sky), SYSTEM (gray)
- **Each notification:** Icon badge + title + unread dot + message + relative timestamp + deal link
- **Actions:** Click to mark read, "Mark all read" button, "View All" link
- Latest 20 shown, auto-fetches unread count on page load

### Task Modal ("View All Tasks")

Opens from the My Tasks widget when clicking "View All Tasks."

- Full scrollable list of all user tasks
- Each task: checkbox, title, priority badge (HIGH=red), due date (formatted: "Overdue (2d)", "Due Today", "Due in 3 days"), deal link
- Sorted: incomplete first → by priority (HIGH→MED→LOW) → by due date
- Completed tasks show strikethrough

### Responsive Behavior
- Stats: 4 cols desktop → 2 tablet → 1 mobile
- Widget grid: 3 cols desktop → 2 tablet → 1 mobile
- Sidebar collapses on mobile

---

## Page 2: Deal Pipeline (CRM)

**URL:** `/crm.html`
**Purpose:** See all deals, filter/sort, switch views, bulk actions, import/ingest new deals.

### Layout Structure

```
+------------------------------------------------------------------+
| Deal Pipeline                                                     |
| * 13 Active Opportunities               [Import Deals]           |
+------------------------------------------------------------------+

+-----------------------------------------------------------------+
| Stage: All | Industry: All | Deal Size: All | Priority: All     |  <- Filter bar
| [Clear]                         [Sort] [Metrics] [List|Kanban]  |
+-----------------------------------------------------------------+

+-- LIST VIEW (default) ------------------------------------------+
| +---------------+  +---------------+  +---------------+          |
| | [icon] Company|  | [icon] Company|  | [icon] Company|          |
| | Name  [STAGE] |  | Name  [STAGE] |  | Name  [STAGE] |          |
| |               |  |               |  |               |          |
| | Revenue  EBIT |  | Revenue  EBIT |  | Revenue  EBIT |          |
| | $19Cr  $9Cr   |  | $19Cr  $9Cr   |  | $900K  $900K  |          |
| |               |  |               |  |               |          |
| | [AI Thesis... ]  | [AI Thesis... ]  | [AI Thesis... ]          |
| | Doc info  1d  |  | Doc info  3d  |  | Doc info  5d  |          |
| +---------------+  +---------------+  +---------------+          |
+------------------------------------------------------------------+

+-- KANBAN VIEW (toggle) -----------------------------------------+
| INITIAL REVIEW | DUE DILIGENCE | IOI SUBMITTED | LOI | NEG | CL |
| [card]         | [card]        | [card]        |     |     |    |
| [card]         | [card]        |               |     |     |    |
| [card]         |               |               |     |     |    |
| [drop zone]   | [drop zone]   | [drop zone]   |     |     |    |
+------------------------------------------------------------------+
```

### Key Components

**1. Page Header**
- "Deal Pipeline" title
- Active deal count with green pulse dot
- "Import Deals" button (secondary style, white bg + border)
- Header also has "Ingest Deal Data" primary button (in nav header)

**2. Filter Bar** (flex-wrap row)
- **Dropdowns:** Stage (7 stages), Industry (dynamic), Deal Size (4 ranges), Priority (4 levels with colored dots)
- "Clear Filters" appears only when filters are active
- **Sort dropdown:** Recent Activity, Newest/Oldest, Deal Size, IRR, Revenue, Priority, Name
- **Metrics button:** Opens checkbox panel to customize visible card metrics
- **View toggle:** List (grid icon) | Kanban (columns icon) — persisted to localStorage

**3. Deal Card (List/Grid View)**
```
+-------------------------------+
| [checkbox]  [Company]  [STAGE]|  <- checkbox visible on hover
| Deal Name                     |
| Industry                      |
+-------------------------------+
| Revenue    | EBITDA           |  <- customizable metrics (2-4 cols)
| $19.0Cr    | $9.0Cr           |
+-------------------------------+
| [risk icon] AI Thesis text... |  <- orange if risk, green if positive
+-------------------------------+
| [doc icon] CIM.pdf  VDR  1d  |  <- last document + relative time
+-------------------------------+
```
- Hover: elevate shadow, show checkbox + 3-dot menu
- 3-dot menu: Open Deal, Open VDR, Delete
- Click card body → navigate to deal detail page
- Grid: 1 col mobile, 2 tablet, 3 desktop, 4 wide screens

**4. Kanban Board**
- 6 columns: INITIAL_REVIEW → DUE_DILIGENCE → IOI_SUBMITTED → LOI_SUBMITTED → NEGOTIATION → CLOSING
- Drag-and-drop cards between columns → updates deal stage via API
- Compact card variant (smaller than list card)
- Drop zone at bottom of each column (min 100px)

**5. Bulk Actions Bar** (slides in when deals selected)
```
[X] 3 deals selected    [Change Stage] [Export CSV] [Mark Passed] [Delete]
```
- Navy blue background, white text
- Appears with slide animation
- Stage change opens modal with 9 options
- Export generates CSV download

**6. Ingest Deal Data Modal** (triggered from "Ingest Deal Data" button in header)

AI-powered deal creation — upload a document and the AI extracts company info, financials, and creates a deal automatically.

- **Two modes:**
  - **Create New Deal** (default) — extracts from doc and creates a brand-new deal
  - **Update Existing Deal** — search + select an existing deal, then add new data from a doc
- **Three input methods:**
  - **File Upload tab:** Drag-and-drop zone, max 50MB. Accepts PDF, Word, Excel, Text, CSV
  - **Paste Text tab:** Large textarea for pasting a deal summary or CIM excerpt. Character counter shown
  - **Company URL tab:** Enter a website URL to scrape public company data
- **Optional context section** (collapsible): How was this sourced? (Proprietary, Broker, Inbound), Company name, Initial assessment
- **Extraction preview** after AI processes:
  - Shows extracted fields: Company Name, Industry, Revenue, EBITDA
  - Each field has a **confidence bar** (0-100%) — green >=80%, amber 50-79%, red <50%
  - Overall confidence badge
  - "Needs Review" badge if confidence is low
  - **AI Follow-Up Questions** section (generated asynchronously — the AI asks clarifying questions about the deal)
  - Actions: "View Deal" (navigate), "Add Another" (reset modal)
- **Why it matters:** This is the primary way deals enter the system. A PE analyst uploads a CIM PDF and gets a structured deal in seconds instead of manual data entry.

**7. Import Deals Modal** (triggered from "Import Deals" button)

Bulk import for firms migrating from spreadsheets or other CRMs.

- **Step 1 — Upload:** Drag-and-drop CSV/Excel or paste tabular data. Two tabs (Upload File vs Paste Data). Max 5MB, 500 deals per import.
- **Step 2 — AI Column Mapping:** GPT-4o analyzes source columns and suggests mappings to Avise fields. Each mapping shows confidence score — green (>=80%) = auto-matched, amber (<80%) = needs review. Unmapped columns shown as "Custom Field" (orange badge) — stored in deal's `customFields` JSONB. User can override any mapping via dropdown.
- **Step 3 — Preview:** Table showing mapped data (max 50 rows). Valid/invalid row counts. Shows data transformations: `$5M` → 5, `15%` → 0.15, `3.5x` → 3.5. "Import N Deals" button.
- **Step 4 — Results:** Success/failure summary. Green check = "X deals imported successfully!" Shows: deals created, new companies auto-created, failed rows with reasons (e.g., "Row 12: Missing company name").
- **Why it matters:** Firms switching from Excel tracking can import their entire pipeline in one shot with AI mapping — no manual column matching.

### Stage Badge Colors
| Stage | Color |
|-------|-------|
| SCREENING | Blue |
| INITIAL_REVIEW | Blue |
| DUE_DILIGENCE | Primary (navy) |
| IOI_SUBMITTED | Amber |
| LOI_SUBMITTED | Purple |
| NEGOTIATION | Orange |
| CLOSING | Teal |
| PASSED | Gray |
| CLOSED_WON | Green |
| CLOSED_LOST | Red |

### Metrics Configuration
Default visible: IRR (Proj), MoM, EBITDA, Revenue, Deal Size
- User can customize via metrics panel
- Saved to localStorage + user API

---

## Page 3: Virtual Data Room (VDR)

**URL:** `/vdr.html` (React app)
**Purpose:** Secure document storage per deal, with AI-powered analysis and insights.

### Two Views

#### View A: All Data Rooms (no dealId in URL)

```
+------------------------------------------------------------------+
| All Data Rooms                                                    |
| 13 active deals                          [+ Create Data Room]    |
+------------------------------------------------------------------+

+---------------+  +---------------+  +---------------+  +--------+
| [folder icon] |  | [folder icon] |  | [folder icon] |  | ...    |
| Project Z     |  | Nino Burgers  |  | Nino + Franc. |  |        |
| N/A           |  | Food & Bev    |  | Food & Bev    |  |        |
| SCREENING     |  | INITIAL REV.  |  | INITIAL REV.  |  |        |
| 4/18/2026     |  | 4/18/2026     |  | 4/18/2026     |  |        |
+---------------+  +---------------+  +---------------+  +--------+
```

- Card grid: deal name, industry, stage badge, last updated date
- Click card → opens individual data room
- "Create Data Room" button opens modal
- Grid: 1-4 columns responsive

#### View B: Individual Data Room (with dealId)

```
+------------------------------------------------------------------+
| < All Data Rooms > [Deal Name] > Data Room > [Folder]   [Upload] |
+------------------------------------------------------------------+

+-- LEFT SIDEBAR --+-- MAIN CONTENT --------------------------+-- RIGHT PANEL --+
| 280px            |                                           | 320px            |
|                  | Search files...                    [⌘K]  |                  |
| 100 Financials   | SMART FILTERS: [PDFs] [Sheets] [Warn]    | AI QUICK INSIGHTS|
|   Reviewing  0   |              [30 Days] [+ Custom]        | Analysis for     |
|                  |                                           | [folder name]    |
| 200 Legal        | +--+------------------+--------+----+---+|                  |
|   Reviewing  0   | |  | Name             | AI     | By |Dt || Completeness: 75%|
|                  | +--+------------------+--------+----+---+| [==========---]  |
| 300 Commercial   | |  | CIM_v2.pdf       | Key    | GJ |4d ||                  |
|   Reviewing  0   | |  | Financials.xlsx   | Ready  | AK |7d || RED FLAGS         |
|                  | |  | NDA_signed.pdf    | Done   | GJ |2w || - Missing audited |
| 400 HR & Data    | +--+------------------+--------+----+---+|   financials     |
|   Reviewing  0   |                                           || - Incomplete NDA  |
|                  | [Empty state: "No files in this folder"]  ||                  |
| 500 Intellectual |                                           || MISSING DOCS      |
|   Reviewing  0   |                                           || - Audited FS [Req]|
|                  |                                           || - Tax returns[Req]|
+------------------+-------------------------------------------+|                  |
                                                                | [Generate Report]|
                                                                +------------------+
```

### Key Components

**1. Folder Tree (Left Sidebar, 280px)**
- Default folders: 100 Financials, 200 Legal, 300 Commercial, 400 HR & Data, 500 Intellectual Property
- Each folder shows: name, status badge, file count
- Status badges: `ready` (green), `attention` (amber), `reviewing` (blue), `restricted` (gray + lock icon)
- Active folder: highlighted with primary ring
- 3-dot menu per folder: Rename, Delete
- Keyboard nav: Enter/Space to select, Escape to close menu

**2. Filters Bar (Sticky top of main content)**
- **Search:** Cross-folder search — searches ALL folders, shows blue banner with result count + clear button
- **Smart Filters (4 default toggles):**
  - PDFs Only
  - Spreadsheets
  - AI Warnings
  - Last 30 Days
- **Custom Filters (via "+ Custom" dropdown, 8 presets):**
  - Word Documents, Large Files (>5MB), Small Files (<1MB), Last 7/90 Days, AI Analyzed, Ready for AI, Pending Analysis
- Active filters shown as chips with "x" to remove
- Filters combine with AND logic

**3. File Table (Main content area)**

| Column | Content |
|--------|---------|
| **Checkbox** | Multi-select for bulk actions |
| **Name** | File icon (color by type: red=PDF, green=Excel, blue=Word) + name + file size |
| **AI Analysis** | Badge + short description. Badges: "Key Insight" (green), "Warning" (red), "Analysis Complete" (blue), "Ready for AI" (amber), "Pending Analysis" (gray) |
| **Author** | Avatar circle with initials |
| **Date** | Relative time (1d, 2w, etc.) |
| **Actions** | 3-dot menu on hover |

- 3-dot menu: Rename, Download, Link to Deal, Extract Financials, Delete
- Re-analyze button appears for "standard" analysis type
- Empty state: folder icon + "No files in this folder yet" + "Upload files to get started"
- Portal rendering for menus (escapes overflow-hidden)

**4. AI Insights Panel (Right sidebar, 320px, collapsible)**
- **Collapsed state:** 12px thin bar with AI icon + expand chevron
- **Empty state:** "No insights yet" + "Generate AI Insights" CTA button
- **Generating state:** Spinner + "Analyzing folder..."
- **Full state:**
  - **Completeness bar:** 0-100%, color-coded (green >=80%, amber 50-79%, red <50%)
  - **Summary:** Key findings with percentage highlights
  - **Red Flags:** Cards with severity icon (high=red, medium=orange), title, description, "View File" link
  - **Missing Documents:** List with amber dots + "Request" button (sends email + in-app notification)
  - **Generate Full Report:** Downloads Markdown report
  - **Refresh button** in panel header

**5. File Upload Flow**
1. Click "Upload Files" → file picker
2. Validation: max 50MB, allowed types
3. Smart detection: CIM/financial docs → auto-check "auto-update deal info"
4. Confirmation modal: file list + option checkbox
5. Upload → success toast → auto-updates deal if checked

**6. Document Request Flow**
- Click "Request" on missing document in insights panel
- Sends email via Resend + creates in-app notification
- Notifies deal team members

### File Type Icons
| Type | Icon Color | Extensions |
|------|-----------|------------|
| PDF | Red | .pdf |
| Excel | Green | .xlsx, .xls, .csv |
| Word | Blue | .doc, .docx |
| Other | Slate/Gray | all others |

### Analysis Status Flow
```
Upload → "Pending Analysis" (gray) → Text extraction → "Ready for AI" (amber) → AI Analysis → "Analysis Complete" (blue) / "Key Insight" (green) / "Warning" (red)
```

---

## Deal Detail Page (referenced from Dashboard + Pipeline)

**URL:** `/deal.html?id={dealId}`
**Purpose:** Deep dive into a single deal — financials, AI analysis, chat, documents, team notes.

> This page is NOT in the designer's 3-page scope, but deals are the core object — understanding this page helps design the Dashboard and Pipeline cards that link here.

### Layout: Two-Column Split

```
+-- LEFT PANEL (58%) ---------------------+-- RIGHT PANEL (42%) --------+
|                                          |                             |
| [Icon] Deal Name  [Confidence] [...]    | Deal Assistant AI  [BETA]   |
|                                          | [status dot] Online         |
| Pipeline: [SOURCING] → [DD] → [LOI]... | [Clear Chat]                |
|                                          |                             |
| Lead Partner: [name]  Analyst: [name]   | [AI intro message]          |
| Deal Source: Broker   Updated: 2h ago   |                             |
|                                          | [Chat history messages]     |
| +--------+ +--------+ +--------+       |                             |
| |Revenue | |EBITDA  | |Deal Sz |       | [Suggested prompt chips]    |
| |$19.0Cr | |$9.0Cr  | |$42.0M  |       |  - Risks in [Industry]      |
| +--------+ +--------+ +--------+       |  - Margin & Valuation       |
|                                          |  - Build Investment Thesis  |
| == Financial Statements ============    |  - Due Diligence Questions  |
| [Income Statement] [Balance] [Cash]     |                             |
| Revenue   | FY2023 | FY2024 | FY2025   | +-------------------------+ |
| COGS      | ...    | ...    | ...       | | Ask about the deal...   | |
| Gross P.  | ...    | ...    | ...       | | [attach] [send]         | |
| EBITDA    | ...    | ...    | ...       | +-------------------------+ |
|                                          | AI can make mistakes.       |
| == AI Financial Analysis ============   |                             |
| [Overview|Deep Dive|Cash|Val|DD|AI|Memo]|                             |
|                                          |                             |
| == Key Risks =========================  |                             |
| - Revenue concentration risk            |                             |
| - Margin compression in Q3             |                             |
|                                          |                             |
| == Add Note ==========================  |                             |
| [Type a note... @ to mention]  [Add]   |                             |
|                                          |                             |
| == Activity Feed =====================  |                             |
| - GJ changed stage to DD (2h ago)      |                             |
| - AK uploaded CIM_v2.pdf (1d ago)      |                             |
|                                          |                             |
| == Recent Documents ==================  |                             |
| [PDF] CIM_v2.pdf  [XLS] Financials.xlsx |                             |
+------------------------------------------+-----------------------------+
```

### Left Panel Sections

**1. Deal Header**
- Company icon, deal name, financial extraction confidence badge (clickable → popup)
- 3-dot menu: AI Tools (Meeting Prep, Draft Email), Open Data Room, Delete Deal

**2. Pipeline Visualization**
- Visual stage progression bar showing where the deal is
- "Change Stage" button to advance/revert

**3. Deal Info Grid** (4 columns)
- Lead Partner, Analyst, Deal Source (Proprietary/Broker/Inbound), Last Updated

**4. Financial Metrics Cards** (dynamic — only shows metrics with data)
- Revenue (LTM) with mini bar chart
- EBITDA Margin with progress bar
- EBITDA, Deal Size (with EBITDA multiple), Projected IRR (with MoM), Gross Margin
- Each card: label, formatted value, optional "Target"/"Est." badge

**5. Financial Statements** (collapsible section)
- **Why it matters:** This is where the AI extraction results live. The AI reads uploaded PDFs/Excel and populates these tables automatically.
- **3 tabs:** Income Statement, Balance Sheet, Cash Flow
- **Table:** Rows = line items (Revenue, COGS, EBITDA, etc.), Columns = periods/documents
- **Inline editing:** Click any cell → number input → Enter to save
- **Chart toggle:** Switch between table view and Chart.js visualizations (Revenue & Growth, Balance Sheet Composition)
- **Validation flags:** Banner showing extraction quality checks
- **Conflict banner:** When multiple documents have overlapping data → "Review Conflicts" and "Auto-resolve" buttons
- **Source attribution:** Footer showing which documents the data was extracted from
- **70+ financial line items** across 3 statement types

**6. AI Financial Analysis** (collapsible, hidden until financials exist)
- **Why it matters:** Once financials are extracted, Avise runs a full analysis suite automatically — QoE scores, ratios, red flags, valuation screens. This is the "intelligence layer" on top of raw numbers.
- **7 tabs:**

| Tab | What It Shows | Why PE Professionals Need It |
|-----|--------------|----------------------------|
| **Overview** | QoE Score ring (0-100), EBITDA Bridge (reported → adjusted), Revenue Quality (CAGR, consistency) | Quick health check — is this deal's earnings quality trustworthy? |
| **Deep Dive** | Financial ratios by category (profitability, efficiency, leverage), DuPont decomposition, cost structure analysis | Detailed ratio analysis for IC memo preparation |
| **Cash & Capital** | Cash flow waterfall (EBITDA→CapEx→WC→FCF), working capital trends, debt capacity modeling | Can this business generate cash? How much debt can it support? |
| **Valuation** | LBO screening (pass/fail), benchmark comparison vs. peer deals | Is this deal viable for a leveraged buyout? How does it compare? |
| **Diligence** | Red flag cards (critical/warning severity), cross-document conflicts | What should the DD team investigate? Where do the numbers disagree? |
| **AI Insights** | Executive summary, key strengths, key risks, investment thesis, DD priorities | AI-written narrative for quick partner briefing |
| **Memo** | Link to Investment Memo Builder, QoE score, section count | Jump to full IC memo generation |

**7. Key Risks** (collapsible, max-height 320px scrollable)
- AI-extracted risk factors displayed as a bullet list

**8. Add Note** (glass panel)
- Text input with `@mention` support for tagging team members
- Notes appear in the activity feed

**9. Activity Feed** (collapsible, max-height 256px scrollable)
- Chronological list: stage changes, document uploads, note additions, member assignments
- Each entry: avatar + action description + relative timestamp
- Refresh button in header

**10. Recent Documents** (horizontal scroll)
- File icons (PDF/Excel/Word) + file names from the deal's data room
- Click opens real document preview via `PEDocPreview` (PDF rendered inline, Excel as formatted table with sheet tabs, Word via Mammoth.js)
- Excel preview: smart header detection, number formatting with commas, financial-aware row styling (section headers, totals), negative values in red
- Download button in preview modal triggers authenticated file download

### Right Panel — AI Deal Chat

- **What it is:** A conversational AI assistant with full context about this specific deal — its financials, documents, team, and stage.
- **Context-aware:** The chat system prompt includes full financial tables as Markdown, so the AI can quote exact numbers.
- **Suggested prompts** (dynamic chips based on deal data):
  - "Top 3 risks in [Industry]"
  - "Margin & Valuation Analysis"
  - "Build Investment Thesis"
  - "10 Due Diligence Questions"
  - "Summarize Documents" / "Growth & Exit Potential"
- **File attachments:** Paperclip icon → attach files → uploaded to VDR → AI can reference them
- **Message actions on AI responses:** Helpful button, Copy button, action CTA links
- **Chat history:** Last 200 messages loaded, scrollable
- **Clear chat:** Confirmation modal before wiping history
- **Typing indicator:** Three bouncing dots while AI is responding
- **Disclaimer footer:** "AI can make mistakes. Verify critical data from original documents."

---

## AI Features Summary

All AI features use the emerald accent (`#059669`) to visually distinguish them from core CRUD features.

| Feature | Where | What It Does | User Trigger |
|---------|-------|-------------|--------------|
| **Deal Signals Scanner** | Dashboard | Scans entire portfolio for risks, leadership changes, market shifts, competitive threats | "Scan Signals" button |
| **AI Search / Portfolio Chat** | Header (all pages) | Natural language queries across all deals and documents | Cmd+K or search bar |
| **Deal Chat** | Deal detail page | Conversational Q&A about a specific deal with financial context | Type in chat panel |
| **Deal Ingestion** | Header button | AI reads uploaded CIM/PDF and extracts company info + financials to create a deal | "Ingest Deal Data" button |
| **Deal Import Mapping** | CRM page | GPT-4o auto-maps CSV/Excel columns to Avise fields during bulk import | "Import Deals" button |
| **Financial Extraction** | Deal page / VDR | AI reads PDF/Excel documents and populates 70+ financial line items across 3 statement types | Automatic on upload or manual "Re-extract" |
| **Financial Analysis** | Deal page | Runs QoE scoring, ratio analysis, DuPont decomposition, LBO screening, red flag detection on extracted financials | Automatic after extraction |
| **Folder Insights** | VDR | Analyzes all documents in a folder for completeness, red flags, and missing documents | "Generate AI Insights" button |
| **Contact Enrichment** | Contacts page | Discovers job title, company, industry, LinkedIn, expertise from public data | "Enrich Contact" button |
| **Meeting Prep** | Deal page | Generates meeting brief with talking points, questions, risks, suggested agenda | "AI Meeting Prep" in deal menu |
| **Investment Memo** | Memo Builder page | AI-assisted IC memo generation with drag-and-drop sections | "Memo" tab in analysis |

### AI UX Patterns (consistent across all AI features)
- **Loading:** Spinning sync icon + descriptive text ("Analyzing...", "Enriching...", "Scanning...")
- **Confidence indicators:** Percentage badges + color-coded bars (green/amber/red)
- **Preview before save:** AI shows extracted/generated data; user reviews before committing
- **Error states:** Specific error messages (not generic "Something went wrong") + retry button
- **Cost transparency:** Low-cost operations (~$0.01-0.02 per AI call)

---

## Onboarding System

Guides first-time users through the product. Shown only to new accounts.

### Welcome Modal (first login only)
- Full-screen modal with rocket icon and backdrop blur
- Title: "Welcome to Avise"
- 3 step cards explaining the product:
  1. Upload a CIM → AI extracts financials in seconds
  2. Chat with Your Deals → Ask natural language questions
  3. Collaborate with Your Team → Share deal rooms
- Optional video demo embed (Loom)
- CTA: "Get Started" → navigates to CRM page
- Skip: "I'll explore on my own"

### Onboarding Checklist (dashboard widget)
- Persistent card showing "Getting Started — 2/5 completed"
- Animated progress bar
- **5 steps with navigation links:**
  1. Create your first deal → CRM page
  2. Upload a CIM or financial document → most recent deal's documents section
  3. Review AI-extracted financials → most recent deal's financials section
  4. Try Deal Chat → most recent deal's chat section
  5. Invite a team member → Settings page
- Click circle = mark complete (one-way, no un-checking)
- Click row = navigate to linked page
- Completed steps: green checkmark + strikethrough text
- Auto-completion: backend detects when steps are done via real activity (deal created, document uploaded, etc.)
- Dismissible but progress persists

### Empty States (context-aware)
- **Dashboard empty:** "Create your first deal to see pipeline metrics, AI insights, and team activity here." → CTA: "Create a Deal"
- **Deals empty:** "Start building your pipeline. Upload a CIM or create a deal manually." → CTA: "Create First Deal"
- **Contacts empty:** "Add contacts to track relationships, interaction history, and deal involvement." → CTA: "Add Contact"
- **Templates empty:** "Create a reusable memo template for your investment committee process." → CTA: "Create Template"
- Each has: large icon in light blue circle, centered layout, heading + description + primary button

---

## Help & Support Modal

Available on every page via user dropdown → "Help & Support."

- Two option cards:
  1. **Book a Support Call** — icon: calendar → opens Google Calendar booking (30-min video call)
  2. **Send Written Feedback** — icon: edit → opens Google Form for bug reports, feature requests
- Footer: "Need urgent help? Email tech@pocketfund.org or hello@pocketfund.org"

---

## Team Invitations (Settings Page)

- **Invite modal:** Email input + role dropdown (MEMBER/VIEWER/ADMIN) → "Send Invite"
- On success: swaps to link panel with copyable invite URL + "Invite Another" option
- **Invitation list:** Shows all sent invitations with status badges (PENDING amber, ACCEPTED green, EXPIRED gray)
- Each pending invite has inline "Copy Link" button
- Auto-opens when navigating to `/settings.html#invite`

---

## Cross-Page Patterns

### Notification Toast (all pages)
- Position: bottom-right, stacked
- 4 variants: success (green), error (red), warning (amber), info (blue)
- Auto-dismiss: 4 seconds with progress bar
- Manual dismiss button (X)

### Confirmation Dialog (all pages)
- Center modal with backdrop blur
- 3 variants: danger (red), warning (amber), info (blue)
- Keyboard: Escape to cancel
- Focus trapped in modal

### Empty States
- Always include: icon + heading + description + CTA button
- Consistent pattern across all pages
- Never leave a blank white space

### Loading States
- Spinning sync icon + descriptive text
- Skeleton loaders where appropriate
- Never infinite spinners — show error + retry after timeout

### Authentication
- All API calls use `PEAuth.authFetch()` (handles token refresh)
- 401 → redirect to login page
- Session persistence via Supabase auth

---

## Design Principles

1. **Banker aesthetic** — clean, professional, trustworthy. No playful colors or rounded designs.
2. **Data density** — PE professionals need to see a lot of information. Don't over-simplify.
3. **AI as assistant** — AI features use emerald (`#059669`) accent to distinguish from core UI. Never dominant.
4. **Whitespace matters** — generous padding inside cards, breathing room between sections.
5. **Consistency** — same button styles, badge patterns, shadow levels across all pages.
6. **Progressive disclosure** — show key info upfront, details on hover/click/expand.

---

## What Needs Improvement (Your Focus Areas)

These are areas where a fresh UI/UX eye would be most valuable:

1. **Visual consistency** — Some pages have slightly different card styles, badge sizes, spacing
2. **Information hierarchy** — Deal cards pack a lot of info; could benefit from better visual weight distribution
3. **Empty & loading states** — Some are basic text; could be more polished
4. **Mobile experience** — Responsive works but isn't optimized for mobile PE workflows
5. **Micro-interactions** — Hover states, transitions, feedback on actions could be more polished
6. **Color usage** — Stage badges, analysis badges, status indicators use many colors; could be more systematic
7. **VDR insights panel** — Layout and information architecture could be improved
8. **Dashboard widget system** — 12 optional widgets need a better customization UX

---

*Last updated: April 18, 2026*
