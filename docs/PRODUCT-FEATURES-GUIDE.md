# PE OS — Complete Product Feature Guide

> **Product:** AI-powered CRM for private equity / M&A deal management ("PE OS")
> **Audience:** Onboarding, sales/demo, hiring, and internal reference
> **Prepared for:** Ganesh · **Date:** 2026-07-13
> **Source of truth:** `apps/web-next` (Next.js frontend) + `apps/api` (Express API), current `main`-tracking state.

This guide covers, for every feature:
1. **What it is** (Complete Product Feature)
2. **Step-by-step navigation** (how a user actually gets to and uses it)
3. **🎥 Loom flag** — whether a recorded walkthrough is recommended
4. **Use cases** — realistic PE/M&A scenarios

---

## Legend

| Badge | Meaning |
|---|---|
| 🤖 | **AI-powered** feature (LLM / agent) |
| 🎥 | **Loom video recommended** — multi-step or "show-don't-tell" flow worth a recorded walkthrough |
| 🔒 | **Role-gated** — requires a minimum role (Analyst → Associate → Admin) |
| 🧪 | **Partial / Coming soon** — built but stubbed, hidden, or API-only in current UI |

**Roles** (stored → UI label): `VIEWER` = **Analyst** · `MEMBER` = **Associate** · `ADMIN` = **Admin** (some screens also honor Partner/Principal).

**Primary sidebar navigation:** Dashboard · Deals · Data Room · CRM · Admin · **AI Reports** (Memo Builder) — plus footer *Invite Team · Settings · Feedback*.

---

# Part 1 — Complete Feature Inventory

## A. Getting Started (Auth & Onboarding)
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| A1 | Sign Up (create firm workspace) | | | `/signup` |
| A2 | Login (+ TOTP MFA challenge) | | | `/login` |
| A3 | Verify Email (link / OTP / resend) | | | `/verify-email` |
| A4 | Forgot / Reset Password | | | `/forgot-password`, `/reset-password` |
| A5 | Accept Invitation (external join) | | | `/accept-invite` |
| A6 | Guided Onboarding (3 tasks) | 🤖 | 🎥 | `/onboarding` |
| A7 | Onboarding Checklist (dashboard nudge) | | | `/dashboard` |

## B. Dashboard
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| B1 | Customizable widget dashboard | | 🎥 | `/dashboard` |
| B2 | Pipeline Stats / Active Priorities / Portfolio Allocation | | | `/dashboard` |
| B3 | AI Deal Signals ("Scan Signals") | 🤖 | 🎥 | `/dashboard` |
| B4 | My Tasks / Upcoming Deadlines / This Week | | | `/dashboard` |
| B5 | Watchlist (track pre-pipeline targets) | | | `/dashboard` |
| B6 | Market Sentiment 🧪 | 🤖 | | `/dashboard` |

## C. Deals & Pipeline
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| C1 | Deal Pipeline (List + Kanban) | | 🎥 | `/deals` |
| C2 | Bulk actions (stage / export / pass / delete) | | | `/deals` |
| C3 | Deal Intake — AI create/enrich | 🤖 | 🎥 | modal / `/deal-intake` |
| C4 | Deal Detail workspace | | | `/deals/[id]` |
| C5 | Stage lifecycle + Edit / Delete deal | | | `/deals/[id]` |
| C6 | Deal Team management | 🔒 | | `/deals/[id]` |

## D. Deal Workspace — AI Analysis
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| D1 | Financial Statements (AI extraction, 3-statement) | 🤖 | 🎥 | `/deals/[id]` |
| D2 | Validation Flags + Conflict Resolution | | | `/deals/[id]` |
| D3 | AI Financial Analysis (QoE, LBO, ratios) | 🤖 | 🎥 | `/deals/[id]` |
| D4 | AI Narrative Insights + Benchmarking | 🤖 | 🎥 | `/deals/[id]` |
| D5 | Deal Assistant AI (chat agent w/ tools) | 🤖 | 🎥 | `/deals/[id]` |

## E. Data Room / VDR
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| E1 | Data Rooms overview + Create data room | 🔒 | | `/data-room` |
| E2 | Deal data room (3-pane workspace) | | 🎥 | `/data-room/[dealId]` |
| E3 | Upload documents (+ auto-merge financials) | 🤖 | 🎥 | `/data-room/[dealId]` |
| E4 | Folder organization (DD structure) | | | `/data-room/[dealId]` |
| E5 | File table (open, rename, delete, re-analyze) | 🤖 | | `/data-room/[dealId]` |
| E6 | Link document to another deal | | | `/data-room/[dealId]` |
| E7 | Extract financials from a document | 🤖 | | `/data-room/[dealId]` |
| E8 | AI Folder Insights (completeness, red flags) | 🤖 | 🎥 | `/data-room/[dealId]` |
| E9 | Request missing document | | | `/data-room/[dealId]` |
| E10 | Generate full folder report (Markdown) | | | `/data-room/[dealId]` |
| E11 | Search + smart filters | | | `/data-room/[dealId]` |

## F. AI Reports — Memo Builder & Templates
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| F1 | Create memo (deal-bound, template-seeded) | 🔒 | | `/memo-builder` |
| F2 | Generate All sections | 🤖 | 🎥 | `/memo-builder` |
| F3 | Per-section AI generate / regenerate | 🤖 | | `/memo-builder` |
| F4 | Section management (add/edit/reorder) | | | `/memo-builder` |
| F5 | AI Analyst chat (rewrite / tables / charts) | 🤖 | 🎥 | `/memo-builder` |
| F6 | Export (PDF / Markdown / Clipboard / Share) | | | `/memo-builder` |
| F7 | Templates library + editor | | 🎥 | `/templates` |

## G. CRM (Contacts)
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| G1 | Contacts directory (list/grid, search, filter) | | | `/contacts` |
| G2 | Add / Edit contact (+ background AI enrich) | 🤖 | | `/contacts` |
| G3 | Relationship Score & Network insights | | | `/contacts` |
| G4 | Contact detail panel | | | `/contacts` |
| G5 | Interaction logging (notes/calls/meetings) | | | `/contacts` |
| G6 | Connections / relationship mapping | | 🎥 | `/contacts` |
| G7 | Deal linking (role on a deal) | | | `/contacts` |
| G8 | CSV import / export | | | `/contacts` |
| G9 | AI Contact Enrichment agent | 🤖 | 🎥 | background |

## H. Admin, Team & Settings
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| H1 | Admin Command Center (stats, tasks, reviews) | 🔒 | 🎥 | `/admin` |
| H2 | Team Activity feed + Audit CSV export | 🔒 | | `/admin` |
| H3 | Team & Invitations (single + bulk CSV) | 🔒 | | `/settings` |
| H4 | Profile & Notification preferences | | | `/settings` |
| H5 | Firm Profile (AI-researched) | 🤖 | | `/settings` |
| H6 | Security: password, MFA, sessions | | | `/settings` |
| H7 | Trust posture + Tenant-isolation live test | 🔒 | 🎥 | `/settings` |
| H8 | Require-MFA org policy | 🔒 | | `/settings` |
| H9 | AI Usage (personal credits) | | | `/settings` |
| H10 | Internal AI usage console 🧪 | | | `/internal/usage` |

## I. Global / Cross-App
| # | Feature | AI | Loom | Route |
|---|---|---|---|---|
| I1 | Command Palette (⌘K) | | 🎥 | global |
| I2 | Context-aware AI Assistant | 🤖 | 🎥 | global |
| I3 | Notifications (bell + slide-out center) | | | global |
| I4 | Portfolio Chat (AI, ask across all deals) | 🤖 | 🎥 | global |

---

# Part 2 — Feature Walkthroughs (Navigation + Use Cases)

---

## A. Getting Started (Auth & Onboarding)

### A1. Sign Up — create firm workspace
**What:** New account + firm workspace. Full name, work email, firm name, password (≥10 chars, upper/lower/number/special, strength meter).
**Navigate:** Go to `/signup` → fill fields → **Create workspace** → if a session returns you land on `/onboarding`, otherwise "Check your email to verify."
**Use cases:** A boutique PE founder creating the firm's workspace; a solo dealmaker starting a trial.

### A2. Login (+ MFA)
**What:** Email/password sign-in, "Remember me", friendly error mapping. If a TOTP factor exists, a 6-digit MFA step appears. SSO button is a placeholder (🧪 no-op).
**Navigate:** `/login` → **Sign In** → (if MFA) enter code → **Verify Code** → `/dashboard`.
**Use cases:** Daily partner sign-in with authenticator code; "Remember me" on a work laptop.

### A3. Verify Email
**What:** Auto-verifies via email link (`token_hash`); success auto-redirects to `/login` after 5s. Manual OTP entry + resend (60s cooldown) fallback.
**Navigate:** Click the email link → auto-verify → **Continue to Login**; or enter code manually; or **Resend**.
**Use cases:** New signup confirming inbox; requesting a fresh link after expiry.

### A4. Forgot / Reset Password
**What:** Request a reset email, then set a new password (strength-checked, must differ from old).
**Navigate:** `/forgot-password` → **Send Reset Link** → open email → `/reset-password` → **Update Password** → `/login`.
**Use cases:** Partner locked out before an IC meeting; forced rotation after a security event.

### A5. Accept Invitation (external join)
**What:** Public token-verified flow showing firm/inviter/role; invitee sets name + password → account created and scoped to the inviting org; admins notified.
**Navigate:** Open `/accept-invite?token=…` from the invite email → **Create Account & Join** → **Go to Login** (or auto-redirect to `/dashboard`).
**Use cases:** Newly-hired analyst joining the firm workspace; external co-investor accepting view access.

### A6. 🤖🎥 Guided Onboarding (3 tasks)
**What:** A standalone 3-step flow (no app chrome) that gets a firm to first value in <3 min. Includes the **AI firm-research agent** and first-deal AI analysis.
**Navigate:**
1. Land on `/onboarding` → **Let's go** (or **Use a sample deal** to preload "Luktara Industries").
2. **Task 1 — Define your investment focus:** type your firm website (or paste LinkedIn) and blur the field → 🤖 AI researches the firm ("scanning website, searching news & deals…") → **"Profile researched"** card → **Use this profile** (auto-fills AUM + sectors). A Phase-2 deep-research runs in the background (polls up to ~90s). Pick fund size + sectors → save.
3. **Task 2 — Upload your first deal:** drag a CIM/teaser (PDF/XLSX/DOCX ≤50MB) **or** pick a sample (Luktara — 11 pre-seeded red flags; or Pinecrest Dermatology).
4. **Task 3 — Invite your team** (optional): add email/role rows → **Mark as done**.
5. **Completion:** 🤖 runs risk analysis on the newest deal and shows up to 5 findings ("Your AI analyst found N things on your deal") → **Open your deal**.
> **Loom:** This is the flagship first-run experience — record it end to end (website → AI firm profile → CIM upload → red flags). *Rate limit: 3 firm-enrichment runs/hour per org.*
**Use cases:** A new firm auto-builds its investment thesis so all downstream AI is house-tailored; an evaluator uses the Luktara demo to see red-flag detection without real data.

### A7. Onboarding Checklist (dashboard nudge)
**What:** A persistent "Getting Started" card on the dashboard (5 steps: create deal, upload CIM, review AI financials, try Deal Chat, invite teammate) that auto-completes from activity and can be dismissed.
**Navigate:** `/dashboard` (top of page) → click a step to jump to it, or **✕** to dismiss.
**Use cases:** Nudging a new analyst toward first upload and Deal Chat.

---

## B. Dashboard

### B1. 🎥 Customizable widget dashboard
**What:** Personalized home screen. Core widgets render inline; optional widgets are a draggable grid. Layout persists per-user.
**Navigate:** `/dashboard` → bottom action bar → **Add Widget** (pick visible widgets) or **Customize Dashboard** (drag by the handle) → **Done** / `Esc` to save.
> **Loom:** Short clip showing add-widget + drag-reorder + save.
**Use cases:** A partner surfaces "Active Priorities" + "AI Deal Signals" and hides "Market Multiples"; a firm sets a standard layout for new hires.

### B2. Core widgets — Pipeline Stats / Active Priorities / Portfolio Allocation
**What:** Pipeline Stats cards (Sourcing/DD/LOI/Closed + total closed $, click for stage detail); Active Priorities (top-5 deals table, **View All** → `/deals`); Portfolio Allocation donut by industry.
**Navigate:** `/dashboard` → click a stat card for the stage-detail modal; click any priority row → `/deals/[id]`.
**Use cases:** Morning standup scan of highest-priority deals; checking sector concentration before adding another deal.

### B3. 🤖🎥 AI Deal Signals
**What:** AI scans all active deals for actionable events (leadership change, financial event, market shift, competitive threat, regulatory change, growth opportunity, risk escalation, milestone approaching), each with a severity and a suggested action.
**Navigate:** `/dashboard` → "AI Deal Signals" widget → **Scan Signals** (radar icon) → results sorted critical→info.
> **Loom:** Great demo moment — run a scan and walk through a critical signal + suggested action.
**Use cases:** Weekly portfolio risk sweep; catching a leadership change on a target mid-DD; spotting an approaching LOI expiry.

### B4. My Tasks / Upcoming Deadlines / This Week
**What:** Task checklist with priority + due-date coloring (checkbox toggles status); deadlines due within 14 days; a 7-day calendar of tasks + close dates.
**Navigate:** `/dashboard` → tick a task to complete it; **View All Tasks** opens the tasks modal.
**Use cases:** Associate ticks off "Send NDA" and jumps to the linked deal; partner sees what's due this week.

### B5. Watchlist — track pre-pipeline targets
**What:** Track companies you're monitoring but haven't formally sourced (name, industry, notes).
**Navigate:** Enable the Watchlist widget via Customize → widget header **Add** → fill Company/Industry/Notes → **Add**; hover a row → trash to remove.
**Use cases:** Park a not-yet-actionable target ("founder-owned, revisit in 6 months"); build a thematic roll-up list before sourcing.

### B6. 🤖🧪 Market Sentiment
**What:** AI sentiment read (BULLISH/NEUTRAL/BEARISH + indicators + recommendation) derived from the firm's active-deal sectors. Backend live; widget currently marked "Coming Soon".
**Use cases:** (When surfaced) a daily sentiment read for the IC meeting.

---

## C. Deals & Pipeline

### C1. 🎥 Deal Pipeline (List + Kanban)
**What:** The main deals screen — every deal as a card in a **List View** or a drag-and-drop **Kanban** by stage. Stages: Initial Review → Due Diligence → IOI → LOI → Negotiation → Closing (+ Passed / Closed Won / Closed Lost).
**Navigate:** `/deals` ("Deal Pipeline"). Filter bar: **Stage / Industry / Deal Size / Priority** + **Clear**. Right: List/Kanban toggle, **Customize Metrics** (which financials show on cards), **Sort by** (Recent Activity, Deal Size, IRR, Revenue, Priority…). Search is debounced. In Kanban, drag a card between columns to change stage. Click a card → `/deals/[id]`.
> **Loom:** Show List↔Kanban toggle, filtering, and a drag-to-restage.
**Use cases:** Partner filters to "Due Diligence + Software" to prep a review; associate drags IOI→LOI after a term sheet; sort by "IRR (High)" for an IC shortlist.

### C2. Bulk actions
**What:** Multi-select deals for batch operations.
**Navigate:** `/deals` → tick card checkboxes → **BulkActionsBar** → **Change Stage** / **Export** (CSV) / **Mark as Passed** / **Delete**; `Esc` clears.
**Use cases:** End-of-quarter cleanup ("Mark as Passed" on 8 stale deals); export a filtered set to CSV for an LP.

### C3. 🤖🎥 Deal Intake — AI create / enrich
**What:** AI-powered deal creation. Upload a document or paste text; AI extracts company, industry, revenue, EBITDA, currency, summary, risks, highlights, creates/updates the deal, then generates clarifying follow-up questions.
**Navigate:**
1. Open the **Import Deals** button on `/deals` (also from header CTA, ⌘K, dashboard quick actions), or go to `/deal-intake`.
2. Choose **New** vs **Existing** deal → tab **File** (drag/drop, 50MB) or **Text** (paste, pick source type).
3. **Create Deal** → "Extracting deal data… AI is analyzing the content."
4. Review the extraction → answer **AI follow-up questions** → **Save & View Deal** (or **Skip**).
> **Loom:** CIM PDF → auto-extracted deal card → follow-up questions is a strong demo.
> **Note:** A CSV/Excel **bulk import** exists at the API level (`deal-import.ts`, 500-row cap, dedup, auto-creates companies) but has **no dedicated column-mapping UI** in the current app; deal creation goes through the AI ingest modal. There is **no HubSpot import** in the current (web-next) product.
**Use cases:** Drop a 40-page CIM → deal auto-created in seconds; paste an inbound broker email to spin up a sourcing record.

### C4. Deal Detail workspace
**What:** Full deal workspace — header bar + resizable two-column body (left = content, right = AI chat). Tabs: **Overview / Documents / Activity**.
**Navigate:** `/deals/[id]`. Header: breadcrumb, team avatar stack (→ Manage Team), **Data Room** link, copy-share-link, **Edit Deal**. Stage pipeline chips are clickable. Left tabs: Overview (summary + activity), Documents (drag-drop upload), Activity (full log). Drag the center divider to resize; double-click to reset.
**Use cases:** Deal lead moves a deal to "Negotiation" and copies the share link into Slack; associate uploads a QoE report to the Documents tab.

### C5. Stage lifecycle + Edit / Delete deal
**What:** Edit fields; move stages with an optional note; close to a terminal state (Won/Lost/Passed); delete (cascades to data-room files, docs, team — 🔒 `DEAL_DELETE`).
**Navigate:** **Edit Deal** (header) → save; click a stage chip → **Stage Change** modal (+ note); **Close Deal** → **Terminal Stage** modal; **Delete** → confirm.
**Use cases:** Mark a deal **Closed Won** at signing, or **Passed** with a note ("valuation too high").

### C6. 🔒 Deal Team management
**What:** Assign org users to a deal with roles **Lead Partner / Analyst / Viewer**. Setting a Lead updates `assignedTo`; changes are logged and the added user is notified.
**Navigate:** Deal page → click the team avatar stack / **+** → **Manage Deal Team** → adjust role dropdowns or remove; **Add Team Member** → search users → pick role → **Add to Team**.
**Use cases:** Staff a new mandate (self as Lead, two associates as Analysts); grant a Viewer role to an operating partner during DD.

---

## D. Deal Workspace — AI Analysis

### D1. 🤖🎥 Financial Statements (AI extraction)
**What:** Runs an AI financial agent over uploaded documents to build a normalized **3-statement model** (Income Statement, Balance Sheet, Cash Flow) with per-period line items, confidence scores, and detected currency/scale. Renders tables + charts.
**Navigate:** `/deals/[id]` → **Financial Statements** card. Empty → **Extract Financials** (progress cycles "reading file → analyzing data → almost done"). Populated → tabs per statement, chart toggles (**Revenue / Growth / Composition**), period filter (**all / annual / quarterly**), **Re-extract**, confidence badge.
> **Loom:** Upload a messy PDF P&L → clean charted 3-statement model in ~60s.
**Use cases:** Turn a 120-page CIM into a clean 3-year P&L; ingest a QuickBooks CSV + bank statement to reconcile cash.

### D2. Validation Flags + Conflict Resolution
**What:** Deterministic accounting-integrity checks (balance-sheet balancing, cash-flow ties, low-confidence periods) surfaced as amber/red warnings; when the same period is extracted from multiple docs with >2% variance, a **Conflict Banner** offers pick-a-version or **Auto-Resolve** (highest-confidence / latest-document).
**Navigate:** `/deals/[id]` → Financial Statements card → Validation panel + Conflict banner appear automatically.
**Use cases:** Catch a non-balancing balance sheet before IC; resolve a CIM-vs-audited revenue conflict to the audited figure.

### D3. 🤖🎥 AI Financial Analysis (QoE, LBO, ratios)
**What:** Collapsible panel with a **QoE score badge** (X/100) and seven tabs: **Overview, Deep Dive, Cash & Capital, Valuation, Diligence, AI Insights, Memo** — ratios, revenue quality/CAGR, cash-flow conversion, debt capacity, and an LBO screen (entry/exit multiples, MOIC, IRR).
**Navigate:** `/deals/[id]` → **AI Financial Analysis** card (blue border) → click tabs; expand to fullscreen.
> **Loom:** Walk the QoE badge → Deep Dive → Valuation (LBO returns).
**Use cases:** Screen LBO returns at 4× leverage before spending diligence hours; check EBITDA-to-FCF conversion for earnings quality.

### D4. 🤖🎥 AI Narrative Insights + Benchmarking
**What:** LLM-generated Executive Summary, Key Strengths, Key Risks, Investment Thesis, and DD Priorities — informed by **firm agent memory** (industry benchmarks + portfolio comparables). A benchmark view ranks the deal's revenue/EBITDA/gross-margin against org peers by percentile.
**Navigate:** `/deals/[id]` → AI Financial Analysis → **AI Insights** tab; **Regenerate** after re-extraction; benchmarks live under the Valuation tab.
> **Loom:** Show auto-drafted risks/thesis + a benchmark percentile.
**Use cases:** Auto-draft "key risks" bullets for an IC pre-read; benchmark a SaaS target's margin against the existing portfolio.

### D5. 🤖🎥 Deal Assistant AI (chat agent)
**What:** The flagship AI feature — an always-visible right-panel **ReAct agent** scoped to the deal, grounded in the deal's metadata, extracted financials, team, and the firm's investment profile. It can **call tools and take actions** on the deal.
**Navigate:** `/deals/[id]` → right panel **"Deal Assistant AI" (Beta)**. Personalized suggestion chips (e.g. "Risks in {industry}", "Build investment thesis", "Due diligence questions", "Summarize all documents"). Type a question, **Enter** to send; **attach_file** to add a doc mid-chat. Replies render Markdown with **Helpful/Copy** and **artifact action buttons** (create memo, open data room, view financials, change stage). Clear-history and settings controls in the header.
**Agent tools:** add_note, change_deal_stage, draft_email, get_analysis_summary, generate_meeting_prep, compare_deals, list/search_documents, get_deal_financials, get_deal_activity, trigger_financial_extraction, update_deal_field, suggest_action, scroll_to_section.
> **Loom:** Highest-value recording — ask it to "change stage to LOI and add a note", "draft 10 DD questions", "compare this to our other software deals".
**Use cases:** Draft categorized DD questions; compare a deal to portfolio comps during triage; have the agent restage a deal and log the note; generate meeting prep for a management call.

---

## E. Data Room / VDR

### E1. 🔒 Data Rooms overview + Create data room
**What:** A grid of every deal's data room (name, industry, stage badge, last-updated). "Create Data Room" spins up a new deal that auto-provisions default DD folders.
**Navigate:** `/data-room` → **Create Data Room** → enter a name ("e.g., Project Apollo") → **Create Data Room** → routes to `/data-room/{id}`. (🔒 Associate+; a 403 shows "You need Associate role or higher…")
**Use cases:** Spin up "Project Apollo" when a CIM lands; browse all live diligence rooms from one screen.

### E2. 🎥 Deal data room (3-pane workspace)
**What:** The working VDR for one deal — left folder sidebar, center file table with search/filters, right AI insights panel.
**Navigate:** `/data-room/[dealId]`. Left: **All Data Rooms** back link, folder tree, **New Folder**. Center: breadcrumb, **Upload Files**, team avatars, filter bars, file table. Right: **AI Quick Insights** (collapsible).
> **Loom:** Orient viewers to the 3-pane layout before deeper VDR clips.

### E3. 🤖🎥 Upload documents (+ auto-merge financials)
**What:** Upload PDF/Excel/Word into a folder. Server extracts text, runs AI extraction on PDFs, RAG-embeds content, and can **auto-merge** extracted financials into the deal.
**Navigate:** Select a folder → **Upload Files** (`.pdf/.xlsx/.xls/.doc/.docx`, 50MB max) → stage-2 modal lists files; if a PDF, a checkbox **"Auto-update deal with extracted data"** appears (auto-checked for CIM/financials/teaser) → **Upload**.
> **Loom:** Drop a CIM → watch it auto-populate the deal card.
**Use cases:** Auto-populate revenue/EBITDA/industry from a CIM; bulk-load a QoE Excel into "100 Financials"; file signed NDAs into Legal.

### E4. Folder organization (DD structure)
**What:** Manage the folder hierarchy; each folder shows a readiness badge (Ready/Attention/Reviewing/Restricted) + file count. New deals auto-get a 5-folder DD structure: **100 Financials, 200 Legal, 300 Commercial, 400 HR & Data, 500 Intellectual Property**.
**Navigate:** Click a folder to select; hover → **⋮** → **Rename** / **Delete**. **New Folder** (bottom) → name → **Create Folder**. Delete warns on cascade if the folder has files.
**Use cases:** Add a "Tax Documents" subfolder mid-DD; rename folders to match the seller's index.

### E5. 🤖 File table — open, rename, delete, re-analyze
**What:** Central file table (Name, AI Analysis state, Author, Date). Row-click opens the file via a 1-hour signed URL in a new tab.
**Navigate:** Row **⋮** → Rename / Download / **Link to Deal** / **Extract Financials** (Excel/PDF) / Delete. Inline **Re-analyze** (refresh) re-extracts text + re-embeds for RAG.
**Use cases:** Open a management deck for review; re-analyze a file uploaded before extraction ran.

### E6. Link document to another deal
**What:** Copies a document (same storage file) into another deal's room, optionally merging its extracted data into the target deal.
**Navigate:** Row **⋮** → **Link to Deal** → search deals → pick one → linked (target team notified).
**Use cases:** Share a master NDA across two bolt-on deals; move a company deck from a screening deal into the live acquisition.

### E7. 🤖 Extract financials from a document
**What:** Runs AI over an Excel/PDF to parse structured financial periods onto the deal.
**Navigate:** Row **⋮** → **Extract Financials** → "Extracting… 30–90s" → "N period(s) stored".
**Use cases:** Pull 3-year revenue/EBITDA from a QoE workbook; normalize a seller's model into the CRM schema.

### E8. 🤖🎥 AI Folder Insights
**What:** Per-folder AI analysis: **completeness %**, summary, **red flags** (severity + link to the offending file), and a **missing-documents** list. Drives the folder's readiness badge.
**Navigate:** Right panel **AI Quick Insights** → **Generate AI Insights** → completeness bar + red flags (**View File**) + missing docs (**Request**). Header refresh re-runs.
> **Loom:** Generate insights on "100 Financials" → red flag → missing-doc request.
**Use cases:** Confirm "100 Financials" is 85% ready before IC; surface a missing audited statement; get a per-workstream gap list.

### E9. Request missing document
**What:** Requests a flagged missing document — emails the deal team + posts an in-app notification.
**Navigate:** Insights panel → Missing Documents → **Request** next to an item.
**Use cases:** Chase an audited-financials PDF; nudge for a customer contract or org chart.

### E10. Generate full folder report (Markdown)
**What:** Downloads a Markdown VDR report for the active folder (summary, completion %, red flags, missing docs, per-file list).
**Navigate:** Insights panel footer → **Generate Full Report** → downloads `VDR_Report_{folder}_{timestamp}.md`.
**Use cases:** Attach a folder-readiness report to an IC memo; share a diligence snapshot with a co-investor.

### E11. Search + smart filters
**What:** Cross-folder search (name/content/tags) + toggleable smart-filter chips (PDFs Only, Spreadsheets, AI Warnings, Last 30 Days) and custom presets; plus a type/folder/sort bar.
**Navigate:** Search box (⌘K hint) → "Searching across all folders"; toggle smart chips; **Custom** → add presets; second bar for Type/Folder/Sort.
**Use cases:** Find every "AI Warnings" file before a risk review; view all Excels last 7 days; locate a contract by name across folders.

---

## F. AI Reports — Memo Builder & Templates

### F1. 🔒 Create memo (deal-bound)
**What:** Create an IC memo bound to a deal (required — AI reads the deal's financials/docs), optionally seeded from a template.
**Navigate:** `/memo-builder` → **New Memo** → Title + **Deal** (required) + **Template** (optional) → **Create Memo**. Can arrive pre-filled via `?dealId=` or from a template's "Use Template".
**Use cases:** Start an IC memo from a "SaaS Growth Equity" template; auto-create when redirected from deal chat.

### F2. 🤖🎥 Generate All sections
**What:** Runs the memo agent across every section, filling content (plus tables/charts) from deal financials + documents.
**Navigate:** Open a memo → header **Generate All** (auto_awesome). Requires a deal attached (otherwise an amber "Attach a deal to enable AI generation" pill).
> **Loom:** One-click full first-draft memo from extracted financials.
**Use cases:** One-click IC memo draft; regenerate the whole memo after new documents land.

### F3. 🤖 Per-section AI generate / regenerate
**What:** Generate/regenerate a single section with a senior-analyst prompt (HTML output with `[Source: CIM p.XX]` citations); supports a custom prompt.
**Navigate:** In the canvas, hover a section → **Regenerate with AI**; empty sections show **Generate content with AI**.
**Use cases:** Rewrite just "Risk Assessment"; regenerate "Financial Performance" after re-extraction without touching hand-edited sections.

### F4. Section management (add / edit / reorder)
**What:** Manually manage memo structure (12 section types incl. Custom), optionally AI-generating a new section on add.
**Navigate:** Outline sidebar → **Add Section** (type, title, "Generate with AI" checkbox). Per section: **Edit content** (HTML + Preview), **Save**, **Delete**; drag to reorder.
**Use cases:** Add a bespoke "Management Assessment"; reorder Recommendation last; delete an irrelevant Appendix.

### F5. 🤖🎥 AI Analyst chat
**What:** A ReAct chat agent that answers questions and proposes section edits/tables/charts applied back into the document (with undo). History persists.
**Navigate:** Right panel **AI Analyst**. Prompt chips: **Rewrite for Tone, Add EBITDA Bridge, Revenue Growth, Summarize Risks, Add Competitors**. Ask → review preview → confirm to append/prepend/replace.
> **Loom:** "Add an EBITDA bridge" → insert generated table into Financial Performance.
**Use cases:** Insert an EBITDA bridge; summarize risks with severity ratings; rewrite a section in formal IC tone.

### F6. Export (PDF / Markdown / Clipboard / Share)
**What:** Export the assembled memo.
**Navigate:** Header **Export to PDF** split button → **PDF / Markdown / Copy to Clipboard**; separate **Share**.
**Use cases:** Export the final IC memo for the committee packet; copy markdown into an email.

### F7. 🎥 Templates library + editor
**What:** Firm-wide template manager. Categories: **Investment Memos / Diligence Checklists / Outreach Sequences**. Editor manages sections (with AI-enabled/mandatory flags), category, and permissions (Firm-Wide / Partners Only / Analysts Only). "Use Template" launches the Memo Builder seeded from it.
**Navigate:** `/templates` → category tabs, filter/sort/search → **New Template** (name/category/description) or select a card → editor drawer (**Add Section**, reorder, **Template Settings**, **Active** toggle) → **Preview** / **Use Template** / **Save Changes**. Card **⋮** → Duplicate / Delete (🔒 `MEMO_DELETE`).
> **Loom:** Create a template → add a mandatory AI-enabled section → Use Template → memo pre-seeded.
**Use cases:** Standardize the firm's IC memo structure; clone for a sector-specific variant; mark which sections auto-generate with AI.

---

## G. CRM (Contacts)

### G1. Contacts directory
**What:** Firm-wide contact directory. Cards show type badge (Banker/Advisor/Executive/LP/Legal/Other), company, email/phone, tags, last-contacted, a **relationship Score** chip, and linked-deal count.
**Navigate:** `/contacts`. **Search** (debounced); **All Types** filter; **Sort** (Newest, Name, Company, Last Contacted); grid/list toggle; **Load More** (30/page). **More → Group by Company** reorganizes into per-company sections.
**Use cases:** Filter Bankers by "Last Contacted" to spot cold coverage; sort LPs by Score before a raise; search a target to pull all its contacts.

### G2. 🤖 Add / Edit contact
**What:** Modal form (name, email, phone, title, company, type, LinkedIn, tags, notes). On **create**, a background AI enrichment agent runs (non-blocking) if an LLM is available.
**Navigate:** `/contacts` → **Add Contact** → fill → **Save Contact**. Edit via detail panel → **Edit** → **Update Contact**.
**Use cases:** Add a banker met at a conference with tags; update an executive's title/company on a move.

### G3. Relationship Score & Network insights
**What:** A heuristic (non-LLM) relationship-strength score (0–100 from recency, frequency, linked deals) labeled Cold/Warm/Active/Strong. Backend also exposes timeline, duplicates, stale contacts, and a network "most-connected" view. *(🧪 On-page insight cards beyond the Score are currently stubbed; the endpoints are live.)*
**Navigate:** Score chip shows on each card and in the detail panel's Interaction Stats.
**Use cases:** Build a re-engagement list of dormant intermediaries; find the super-connector for warm intros; de-dupe before a relationship review.

### G4. Contact detail panel
**What:** Right slide-over with full profile: clickable email/tel/LinkedIn, tags, connections, notes, linked deals, interaction stats + timeline. Action bar: **Add Note / Link Deal / Edit / Delete**.
**Navigate:** `/contacts` → click any card/row.
**Use cases:** Review every logged call before a management presentation; quick-reach an advisor mid-negotiation.

### G5. Interaction logging
**What:** Log NOTE / MEETING / CALL / EMAIL / OTHER against a contact; logging updates `lastContactedAt` (which feeds the Score). (Deal-level activities with @-mentions are logged separately on deals.)
**Navigate:** Detail panel → **Add Note** → type/date/title/description → **Save** → appears in the Interaction Timeline.
**Use cases:** Log a diligence call with a target CFO (bumping their Score); track cadence with a key banker.

### G6. 🎥 Connections / relationship mapping
**What:** Build a bidirectional relationship graph between contacts — **Knows / Referred by / Reports to / Colleague / Introduced by** — with optional notes. Feeds the network "most-connected" ranking.
**Navigate:** Detail panel → **Connections → Add** → search a contact → pick relationship type → optional note → **Add Connection**.
> **Loom:** Show mapping a warm-intro path (e.g. board member "Introduced by" your banker).
**Use cases:** Map the warm-intro path to a target board member; model advisor clusters at a bank; track "Referred by" chains for sourcing credit.

### G7. Deal linking
**What:** Link a contact to deals with a role (Banker / Advisor / Board Member / Management / Other). Linked deals show the deal's stage badge; count feeds the Score.
**Navigate:** Detail panel → **Link Deal** → search deals → pick → choose role → **Link Deal**. Unlink via the link-off icon.
**Use cases:** Link the sell-side banker to a live deal so the team sees coverage; attach target management across deals.

### G8. CSV import / export
**What:** Bulk import (3-step wizard, flexible header mapping, ≤500 rows, per-row success/fail) and export the filtered directory to CSV.
**Navigate:** **More → Import from CSV** (upload → preview → **Import All** → Done); **More → Export to CSV** (honors current filters).
**Use cases:** Import a conference attendee list; export the filtered LP list for IR.

### G9. 🤖🎥 AI Contact Enrichment agent
**What:** A LangGraph agent that enriches a contact using **only the firm's own data** (no fabricated external data): searches CRM documents for mentions, analyzes the email domain, checks linked deals + relationship proximity, and synthesizes a profile — title, company, industry, bio, expertise, **dealRelevance** (high/med/low), **confidence**, a **keyInsight** ("why this person matters + what to do next"), and a **suggestedAction**. Only fills empty fields; low-confidence routes to review.
**Navigate:** Runs **automatically in the background** when a contact is created (no explicit button in the contacts UI).
> **Loom:** Add a contact seen in a data-room doc → show the enriched keyInsight + suggested action appearing.
**Use cases:** A contact found in a data-room doc gets recognized, tagged high-relevance, with "Schedule intro call"; a bulk-imported banker gets coverage/expertise inferred for outreach prioritization.

---

## H. Admin, Team & Settings

### H1. 🔒🎥 Admin Command Center
**What:** Team-performance + deal-flow control center. Stat cards (Team, Deal Volume, Overdue, Utilization), quick actions (**Assign Deal**, **Create Task**, **Schedule Review**, **Send Reminder**), Resource Allocation, a filterable Task Table, Upcoming Reviews. 🔒 Admin/Partner/Principal (others see Access Denied).
**Navigate:** `/admin` → click a stat card to scroll to its section; use quick-action buttons for modals.
> **Loom:** Walk the stat cards + assign-a-deal-with-task flow.
**Use cases:** Review analyst utilization at Monday standup; assign a newly-sourced deal with a Friday QoE task; spot overdue diligence before IC.

### H2. 🔒 Team Activity feed + Audit CSV export
**What:** Right-rail audit feed grouped by day (actor initials, AI badge, humanized action), with date/action/resource filters and **Export CSV** (org-scoped, up to 50k rows).
**Navigate:** `/admin` → **Team Activity** → adjust filters → **Export CSV**.
**Use cases:** Export a 90-day audit trail for an LP/SOC 2 auditor; investigate who downloaded a sensitive CIM.

### H3. 🔒 Team & Invitations
**What:** List invitations (email, role, status, **Copy Link**) and invite colleagues single or **bulk via CSV**. Roles: Analyst / Associate / Admin; per-invite workspace (deal) assignment; only admins invite admins.
**Navigate:** `/settings` → **Team** section → **Invite Team Member** → add rows (email/role/workspaces) or **Bulk import via CSV** → **Send Invitations**.
**Use cases:** Onboard three associates at once with pre-assigned workspaces; invite an external advisor as view-only to one deal.

### H4. Profile & Notification preferences
**What:** Edit display name, title, avatar (email/firm read-only); toggle which event types generate notifications (Deal Updates, Documents, Mentions, AI Insights, Tasks, Comments).
**Navigate:** `/settings` → **General** (edit + **Save Changes**) → **Notifications** (toggles + Save).
**Use cases:** Update a title after promotion; a partner mutes "Document Uploads" but keeps "Mentions".

### H5. 🤖 Firm Profile (AI-researched)
**What:** AI-researched firm profile (description, HQ, AUM, investment/sector focus, deal size, notable deals) used as shared context across deal AI. Read-only display + refresh.
**Navigate:** `/settings` → **Firm Profile** → **Refresh profile** → "Researching your firm (15–25s)…" → reloads.
**Use cases:** Generate house context so memos/analysis are tailored; refresh after the mandate changes.

### H6. Security — password, MFA, sessions
**What:** Change password (strength-checked); enroll/disable **TOTP 2FA** (QR + 6-digit verify); view and revoke **active sessions** (device/IP/last-active, "This device" badge).
**Navigate:** `/settings` → **Security** → Change Password / **Enable** 2FA (scan QR → Verify & Enable) / **Sign out** any session.
**Use cases:** Rotate a password after a phishing scare; enable 2FA before an IC meeting; revoke a session left on a hotel PC.

### H7. 🔒🎥 Trust posture + Tenant-isolation live test
**What:** A trust/compliance panel: org name + Organization ID (isolation proof), encryption checklist (AES-256, TLS 1.2+, JWT), a tenant-isolation badge, and actions (**Security Overview PDF**, **Sub-processor list**, **Request DPA**). Admins get a **live isolation test** that seeds a shadow org and runs ~8 cross-org checks proving each is BLOCKED (writes a `SECURITY_TEST_RUN` audit event).
**Navigate:** `/settings` → **Security** → trust panel; admins → **Run Isolation Test** → terminal-style BLOCKED ✓ output (<3s).
> **Loom:** Strong security-diligence demo — run the live isolation test on-screen.
**Use cases:** Run a live isolation proof during an LP security-DD call; generate SOC 2 audit evidence; forward the Security Overview PDF to a skeptical LP.

### H8. 🔒 Require-MFA org policy
**What:** Admin toggle for org-wide `requireMFA`; when on, members without 2FA get a 403 and are bounced to enroll. Writes WARNING-severity audit events.
**Navigate:** `/settings` → **Team & Invitations** (admin-only, bottom) → **Require Two-Factor Authentication** → confirm.
**Use cases:** Mandate 2FA ahead of a fundraise; enforce MFA before granting data-room access.

### H9. AI Usage (personal credits)
**What:** The current user's credits used this month + per-operation breakdown (free during beta; soft reference bar, no hard cap).
**Navigate:** `/settings` → **AI Usage** section.
**Use cases:** Gauge how heavily the team leans on AI; see which AI operations you use most.

### H10. 🧪 Internal AI usage console (staff only)
**What:** Cross-org AI telemetry for internal staff (`isInternal`; non-internal get 404). Tabs: **Live Feed** (per-event tokens/cost/status), **User Leaderboard** (spend ranking + throttle/block), **Cost Breakdown** (daily cost by operation + reconciliation).
**Navigate:** `/internal/usage`.
**Use cases:** Debug a spike in failed extractions; throttle a runaway account; reconcile provider spend vs credit pricing.

---

## I. Global / Cross-App

### I1. 🎥 Command Palette (⌘K)
**What:** Fast navigator/actions — jump to pages (role-filtered), deals, and contacts, plus verb actions.
**Navigate:** Press **⌘K** anywhere → type to filter → Enter.
> **Loom:** Quick clip — ⌘K → jump to a deal → run an action.
**Use cases:** Jump straight to a deal by name; trigger "New Deal" without leaving the keyboard.

### I2. 🤖🎥 Context-aware AI Assistant
**What:** A global assistant that adapts its suggested prompts to where you are — **deal** (risks, financial health, thesis, DD questions), **portfolio** (top performers, risks, pipeline velocity), **contacts** (follow-ups, network insights, intros), and **memo** (improve writing, sanity-check facts, counterargument).
**Navigate:** Open the assistant from the app chrome → pick a context-appropriate prompt chip or type freely.
> **Loom:** Show the assistant changing its suggestions across deal → portfolio → contacts.
**Use cases:** Ask "key risks & red flags" on a deal; "which deals need attention" across the portfolio; "draft warm outreach" for a contact.

### I3. Notifications (bell + slide-out center)
**What:** Header **bell** (unread badge, 30s poll, opening marks first unread as read, **Mark all read**) and a full **slide-out center** with **All / Unread / Mentions** tabs, time-grouped rows, per-row dismiss, and deep-links to deals. Types: Deal, Document, Mention, AI Insight, Task, Comment, System, Stage, Financial, Invite.
**Navigate:** Click the bell → dropdown → click a row to jump to its deal; open the center → filter tabs → dismiss / **Mark all as read**.
**Use cases:** Jump from a "task assigned" straight to the deal; filter **Mentions** to see where you were @-tagged; catch up on "This Week" after travel.

### I4. 🤖🎥 Portfolio Chat (ask across all deals)
**What:** A ReAct agent over the whole portfolio with tools: `get_portfolio_summary` (counts, revenue/EBITDA, avg IRR, breakdowns), `get_deal_details` (with extracted financials), `get_pipeline_analysis` (stage distribution, conversion). Cites specific numbers and explains *why* a deal needs attention; returns related deals.
**Navigate:** Portfolio/dashboard AI entry → ask e.g. "Which deals need attention?"
> **Loom:** Ask a portfolio-level question and show it citing real numbers + linking deals.
**Use cases:** "Which deals need attention?" surfaces stalled/low-metric deals; "average projected IRR and total EBITDA?"; "compare Luktara vs Pinecrest on revenue and stage."

---

# Part 3 — Loom Video Checklist

Record these walkthroughs (ordered by demo/onboarding value). ⭐ = highest priority.

| Loom | Feature | Why record it | Rough length |
|---|---|---|---|
| ⭐ 1 | **A6 — Guided Onboarding** (website → AI firm profile → CIM upload → red flags) | The flagship first-run "aha" moment | 3–4 min |
| ⭐ 2 | **D5 — Deal Assistant AI** (ask, then have it restage + add note, draft DD questions) | Shows the agent *taking actions*, not just chatting | 3–4 min |
| ⭐ 3 | **C3 — Deal Intake** (CIM PDF → auto-extracted deal + follow-up questions) | Core "AI does the data entry" wow | 2–3 min |
| ⭐ 4 | **D1 + D3 + D4 — Financials → AI Analysis → Insights** (extract → QoE/LBO → thesis/risks) | The analytical heart of the product | 4–5 min |
| ⭐ 5 | **E3 + E8 — VDR upload + AI Folder Insights** (upload → completeness/red flags → request missing) | Diligence workflow buyers care about | 3–4 min |
| 6 | **F2 + F5 — Memo Builder** (Generate All → AI Analyst adds an EBITDA bridge → export PDF) | End-to-end IC memo in minutes | 3–4 min |
| 7 | **H7 — Tenant-isolation live test + Trust posture** | Wins security/LP diligence conversations | 2 min |
| 8 | **B3 — AI Deal Signals** (Scan Signals → critical signal + action) | Proactive portfolio monitoring | 1–2 min |
| 9 | **I4 — Portfolio Chat** ("which deals need attention?") | Portfolio-level AI over real numbers | 2 min |
| 10 | **G6 + G9 — Contacts connections + AI enrichment** | Relationship intelligence story | 2–3 min |
| 11 | **F7 — Templates** (create → AI-enabled section → Use Template) | Firm-wide standardization | 2 min |
| 12 | **C1 — Deal Pipeline** (List↔Kanban, filter, drag-to-restage) | Everyday navigation basics | 1–2 min |
| 13 | **B1 — Dashboard customization** + **I1 — Command Palette (⌘K)** + **I2 — AI Assistant** | Quick "power-user" montage | 2 min |
| 14 | **H1 — Admin Command Center** (assign deal + task) | Manager/admin workflow | 2 min |

**No Loom needed** (self-evident forms/CRUD): Sign up / login / password reset (A1–A5), profile & notification prefs (H4), add/edit contact (G2), CSV import/export (G8), watchlist add (B5), basic file rename/delete/download (E5), invitations list (H3 list view), AI usage (H9).

---

# Appendix — Honesty notes (current state)

These are **built but partial** in the current app — flag them accordingly in demos:
- **SSO** on login is a placeholder (no-op).
- **Deactivate account** (Settings) is a stub → shows "not available in this version".
- **Market Sentiment** dashboard widget is "Coming Soon" (backend live).
- **Contacts insight cards** beyond the relationship Score are stubbed off (endpoints live).
- **CSV/Excel bulk deal import** exists at the API level but has **no column-mapping UI**; deal creation flows through the AI ingest modal.
- **No HubSpot import** exists in the current (web-next) product. *(A legacy HubSpot import shipped in the older `apps/web` frontend; it is not part of PE OS.)*
- **Internal AI usage console** (`/internal/usage`) is staff-only tooling, not a customer feature.

_All routes, labels, and behaviors above were verified against the current `apps/web-next` and `apps/api` source._
