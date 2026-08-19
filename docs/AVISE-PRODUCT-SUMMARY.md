# Avise — Product Summary for Strategy & GTM Planning

**Last Updated:** March 27, 2026
**For:** Product Team, Strategy, ICP Definition, Sales Enablement

---

## What is Avise?

Avise is an **AI-native deal management platform for private equity**. It replaces the manual, spreadsheet-driven workflow PE firms use to source deals, run due diligence, and manage relationships — with an intelligent system that reads documents, extracts financials, flags risks, and writes investment memos.

**One-liner:** "The Intelligence Layer for Private Equity"

**Tagline:** "Automate deal flow analysis and unify your institutional CRM with the world's first AI-native PE operating system."

---

## Product at a Glance

| Dimension | Details |
|-----------|---------|
| **Type** | B2B SaaS (multi-tenant) |
| **Deployment** | Cloud (Vercel serverless) |
| **Stack** | Node.js/Express API + Vanilla JS frontend + Supabase (PostgreSQL) |
| **AI Layer** | OpenAI GPT-4o, GPT-4o-mini, Azure Document Intelligence, Google Gemini (configurable) |
| **Auth** | Supabase Auth (email/password, email verification, password reset) |
| **Status** | Live, deployed, A- production readiness |
| **Frontend Pages** | 26 pages |
| **API Endpoints** | 120+ REST endpoints |
| **AI Agents** | 6 LangGraph-based agents |
| **Database Tables** | 23 tables |

---

## Core Modules & Features

### 1. Deal Pipeline & CRM
The central hub for tracking investment opportunities.

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Drag-drop deals across stages: Sourcing → Due Diligence → IOI → LOI → Close |
| **Deal Cards** | Revenue, EBITDA, IRR projected, sector, stage, team assignment |
| **Deal Intake Form** | Structured new deal entry with company info + financial overview |
| **Activity Timeline** | Chronological log of all deal events (calls, meetings, uploads, stage changes) |
| **Task Management** | Create/assign/track tasks per deal with due dates |
| **Deal Team** | Assign team members with roles (Lead, Support, Reviewer) |
| **CSV Export** | Export deal data for reporting |

### 2. AI Financial Extraction (The Wedge Feature)
**This is the #1 differentiator.** No competitor does this.

| Feature | Description |
|---------|-------------|
| **CIM Auto-Extraction** | Upload a CIM PDF → AI extracts Income Statement, Balance Sheet, Cash Flow in ~30 seconds |
| **3-Layer Extraction** | Azure Document Intelligence → pdf-parse + GPT-4o → GPT-4o Vision (scanned docs) |
| **Excel Support** | Upload .xlsx → AI scores sheets by relevance (0-100), skips junk sheets, extracts financials |
| **Self-Correcting Agent** | LangGraph 5-node pipeline: Extract → Verify → Validate → Self-Correct → Store (max 3 retries) |
| **Two-Pass Verification** | GPT-4o-mini cross-checks extracted values against source text (~$0.003/run) |
| **Merge Conflict Resolution** | Multi-document upload detects overlapping data → user resolves via merge modal |
| **Agent Log** | Full transparency — every extraction step timestamped and visible in UI |

### 3. PE Analysis Suite (13 Modules)
Auto-generated from extracted financials — no manual input needed.

| Module | What It Shows |
|--------|---------------|
| **Quality of Earnings (QoE)** | Revenue quality, earnings sustainability, adjustment flags |
| **Financial Ratios** | Liquidity, profitability, leverage, efficiency ratios with trend charts |
| **DuPont Analysis** | ROE decomposition (margin × turnover × leverage) |
| **EBITDA Bridge** | Walk from revenue to EBITDA with variance highlights |
| **Revenue Quality** | Recurring vs. one-time, customer concentration, growth decomposition |
| **Cash Flow Analysis** | Operating, investing, financing flows with free cash flow calculation |
| **Working Capital** | Days sales outstanding, days payable, cash conversion cycle |
| **Cost Structure** | Fixed vs. variable, COGS breakdown, margin analysis |
| **Debt Capacity & LBO Screen** | Leverage ratios, debt service coverage, LBO quick-screen |
| **Red Flags** | Anomaly detection — margin compression, revenue cliffs, accounting irregularities |
| **Cross-Document Analysis** | Compare data across multiple uploaded documents for consistency |
| **Benchmarking** | Peer comparison (industry medians) |
| **Valuation Screen** | Quick valuation multiples (EV/EBITDA, EV/Revenue) |

### 4. Virtual Data Room (VDR)
Secure document management built into every deal.

| Feature | Description |
|---------|-------------|
| **Folder Structure** | 5 default folders auto-created (Financials, Legal, Operations, Market, Other) |
| **Smart Filters** | PDFs, Spreadsheets, AI Warnings, Last 30 Days + 7 custom presets |
| **Cross-Folder Search** | Search ALL folders at once with result count + clear |
| **Document Sharing** | Generate shareable links for external parties |
| **Document Requests** | Email + in-app notification to request files from deal team |
| **AI Folder Insights** | Auto-summarize folder contents ("Contains 3 CIMs and 2 years of financials") |
| **File Preview** | In-browser preview for PDFs and images |

### 5. Investment Memo Builder
AI-assisted memo authoring with structured templates.

| Feature | Description |
|---------|-------------|
| **Template Library** | Create, duplicate, manage reusable memo templates |
| **Section-Based Editing** | Add/remove/reorder sections with drag-drop |
| **AI Section Generation** | Click "Generate" → AI writes section using deal data + documents |
| **Chat per Section** | Ask AI to refine, expand, or rewrite individual sections |
| **Financial Data Link** | Auto-pulls extracted financials into relevant memo sections |
| **Export** | Download completed memos |

### 6. Contact CRM & Relationship Intelligence
Manage the people behind every deal.

| Feature | Description |
|---------|-------------|
| **Contact Management** | Full CRUD with company, type (Investor, Advisor, Management, Banker), tags |
| **Relationship Scoring** | 0-100 score (Recency 0-40 + Frequency 0-40 + Deals 0-20). Badges: Cold/Warm/Active/Strong |
| **AI Enrichment** | GPT-4o infers job title, company details from name/email. Honest confidence caps by input sparsity |
| **CSV Import/Export** | Handles 20+ header name variations, quoted fields, name splitting |
| **Duplicate Detection** | AI identifies potential duplicate contacts |
| **Network View** | Contact-to-contact connections + contact-to-deal links |
| **Interaction Tracking** | Log calls, emails, meetings per contact |
| **Grid/List Toggle** | Switch between card grid and table list views |
| **Company Grouping** | Group contacts by firm |

### 7. AI Deal Chat ("Chat with Your Deal")
Ask questions about any deal in natural language.

| Feature | Description |
|---------|-------------|
| **ReAct Agent** | 6 closure-bound tools — searches docs, fetches financials, compares deals, suggests actions |
| **Document Search** | "What does the CIM say about customer concentration?" → agent searches VDR |
| **Financial Queries** | "What's the 3-year revenue CAGR?" → agent calculates from extracted data |
| **Deal Comparison** | "How does this compare to [other deal]?" → side-by-side analysis |
| **Action Suggestions** | "What should I do next?" → PE-specific recommendations |
| **File Attachments** | Upload files in chat → stored in VDR → agent can search them |
| **Persistent History** | Chat history saved per deal |

---

## AI Agents Inventory (6 Total)

| Agent | Architecture | Use Case | Cost/Run |
|-------|-------------|----------|----------|
| **Financial Extraction** | LangGraph 5-node StateGraph | CIM/financial doc → structured data | ~$0.05-0.15 |
| **Deal Chat** | LangChain ReAct + 6 tools | Natural language deal Q&A | ~$0.01-0.03 |
| **Contact Enrichment** | LangGraph 4-node StateGraph | Profile completion from name/email | ~$0.01 |
| **Meeting Prep** | Parallel fetch + generation | Pre-meeting brief with talking points | ~$0.02-0.05 |
| **Signal Monitor** | LangGraph 3-node StateGraph | Portfolio-wide deal movement alerts | ~$0.02 |
| **Email Drafter** | LangGraph 4-node StateGraph | Template-based email with compliance check | ~$0.01-0.03 |

---

## Current Pricing (on pricing page)

| Tier | Price/User/Mo | Annual Price | Key Limits |
|------|--------------|-------------|------------|
| **Boutique** | $199 | $159 | 5 active deal rooms, basic AI, email support |
| **Mid-Market** | $479 | $383 | 25 deal rooms, "Chat with Deals" AI, team collaboration, sentiment analysis |
| **Enterprise** | Custom | Custom | Unlimited rooms, SSO, custom models, dedicated AM |

---

## Platform Capabilities (Non-Feature)

| Capability | Details |
|------------|---------|
| **Multi-Tenancy** | Full org isolation — 33 endpoints secured, zero cross-org data leakage |
| **Team Management** | Invite team members, assign roles (Admin, Member), manage permissions |
| **Notifications** | In-app notification bell + email notifications (Resend) |
| **Audit Trail** | Full audit logging — entity-level change tracking for compliance |
| **Settings** | Org settings, sector preferences, API configuration |
| **Help Center** | Built-in documentation and API reference |
| **Legal Pages** | Privacy policy, terms of service |

---

## Competitive Positioning

| Capability | Avise | DealCloud | 4Degrees | Affinity | Altvia |
|-----------|-------|-----------|----------|----------|--------|
| **AI Financial Extraction** | Yes (auto) | No | No | No | No |
| **AI Deal Chat** | Yes (6 tools) | No | No | No | No |
| **AI Memo Builder** | Yes | No | No | No | No |
| **AI Analysis (13 modules)** | Yes (auto) | Manual | Manual | No | Basic |
| **VDR Built-In** | Yes | Add-on | No | No | Yes |
| **Contact AI Enrichment** | Yes | Via Salesforce | Via integration | Yes (core) | No |
| **Setup Time** | Same day | 3-6 months | 1-2 months | 2-4 weeks | 1-3 months |
| **Price (annual, 5 users)** | ~$12K-29K | $50K+ | $25K+ | $30K+ | $20K+ |
| **Target AUM** | <$500M (sweet spot) | $1B+ | $500M+ | $500M+ | $500M+ |

---

## User Roles & Workflows

### Who Uses Avise?

| Role | Primary Workflows | Time Saved |
|------|-------------------|------------|
| **PE Associate / Analyst** | Upload CIM → extract financials → run analysis → draft memo → manage docs | 6-8 hrs/deal → 1-2 hrs |
| **VP / Principal** | Review deal pipeline → chat with deals → prep for meetings → approve memos | 2-3 hrs/deal → 30 min |
| **Managing Director / GP** | Dashboard overview → signal monitoring → portfolio chat → email drafting | Passive monitoring |
| **IR / Operations** | Contact management → relationship scoring → team coordination → audit trail | Manual tracking → automated |

### Key User Journey (Happy Path)
```
Signup → Create Org → Invite Team → Create Deal → Upload CIM
  → AI Extracts Financials (30 sec) → Review & Validate
  → 13 Analysis Modules Auto-Generate → Chat with Deal ("What's the margin trend?")
  → Create Memo from Template → AI Writes Sections → Export Memo
  → Track in Pipeline (Sourcing → DD → IOI → Close)
  → Manage Contacts & Relationships Throughout
```

---

## What's NOT Built Yet

| Feature | Status | Priority |
|---------|--------|----------|
| Portfolio Dashboard | "Coming Soon" page exists | High — needed for post-close workflow |
| Mobile App | N/A | Low — PE workflows are desktop-heavy |
| SSO / SAML | Not built | High for enterprise tier |
| Salesforce Integration | Not built | Medium — many PE firms use SF |
| PitchBook / CB Insights API | Not built | Medium — deal sourcing enrichment |
| Custom Reporting / BI | Not built | Medium — GPs want custom dashboards |
| Workflow Automation | Not built | Low — email triggers, stage-based actions |

---

## Key Metrics to Track for Product Team

| Metric | Why It Matters |
|--------|---------------|
| **CIMs Processed / Week** | Core value metric — are users using the wedge feature? |
| **Extraction Accuracy %** | Product quality — do users trust the AI output? |
| **Deals Created / Org** | Adoption depth — are they moving real deal flow into Avise? |
| **Chat Messages / Deal** | Engagement — is the AI assistant useful enough to talk to? |
| **Memos Generated** | Value delivery — are they producing output with Avise? |
| **Invite-to-Activate Rate** | Team adoption — does it spread within the firm? |
| **Time from Signup to First CIM Upload** | Activation speed — how fast do they hit the "aha moment"? |

---

## Use This Document For

- **ICP Definition** → See "User Roles" + "Competitive Positioning" + "Target AUM" sections
- **Battlecard Creation** → See "Competitive Positioning" table
- **Sales Enablement** → See "Key User Journey" + "Time Saved" estimates
- **Pricing Strategy** → See current tiers + competitor pricing comparison
- **Feature Prioritization** → See "What's NOT Built Yet" + "Key Metrics"
- **Messaging & Positioning** → See module descriptions + "The Wedge Feature" section
- **GTM Motions** → Reference alongside [GTM-STRATEGY.md](GTM-STRATEGY.md)

---

*Generated from live codebase analysis — 26 pages, 120+ endpoints, 6 AI agents, 23 database tables.*
