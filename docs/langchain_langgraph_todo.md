# LangChain & LangGraph Integration — Avise

---

## PRIORITY: PE Financial Intelligence Agent (LangGraph)

> Goal: Build an autonomous AI agent that extracts, validates, analyzes, and benchmarks financials for PE deal teams — turning 5-6 hours of manual analyst work into 5 minutes + review.
> Selling point: "Our AI agent autonomously extracts, validates, and analyzes financials like a junior analyst."

---

### Phase 1: Convert Orchestrator to LangGraph Agent (Foundation)

**What:** Replace the current linear orchestrator with a LangGraph state machine that can branch, loop, and self-correct.

- [x] **1a.** Set up LangGraph + LangChain dependencies in `apps/api`
  - `@langchain/langgraph`, `@langchain/openai`, `@langchain/core`
- [x] **1b.** Define agent state schema
  - Extracted data, confidence scores, validation errors, retry count, source document refs
- [x] **1c.** Build Extract node
  - Dynamic routing: Azure → pdf-parse+GPT-4o → Excel → Vision
  - Agent decides best path based on file type, page count, scan detection
- [x] **1d.** Build Validate node
  - Math checks (row totals, column totals)
  - 3-statement cross-validation (BS balances, CF ties to BS, NI flows through)
  - Confidence scoring per statement
- [x] **1e.** Build Self-Correct node (KILLER FEATURE)
  - On validation failure → identify which page/table failed
  - Re-extract only the failing section with a more targeted prompt
  - Max 3 retry loops, then flag for human review with context
- [x] **1f.** Wire up LangGraph conditional edges + retry loops
  - Extract → Validate → (pass) → Store
  - Extract → Validate → (fail) → Self-Correct → Validate (loop)

```
┌──────────┐    ┌──────────┐    ┌──────────────┐
│ EXTRACT  │ →  │ VALIDATE │ →  │ SELF-CORRECT │
│          │    │          │    │              │
└──────────┘    └────┬─────┘    └──────┬───────┘
                     │                 │
                pass ↓            loops back
                ┌──────────┐
                │  STORE   │
                └──────────┘
```

---

### Phase 2: QoE (Quality of Earnings) Auto-Analysis Agent

**What:** Automatically flag the same things a $200K QoE engagement would surface.

- [x] **2a.** Revenue concentration detection
  - Flag if top customer >20%, top 3 >50% (extract from CIM text)
- [x] **2b.** EBITDA addback validation
  - Detect "one-time" costs appearing in 2+ consecutive years → likely recurring
  - Flag aggressive addbacks (>30% of reported EBITDA)
- [x] **2c.** Working capital trend analysis
  - AR days, AP days, Inventory days — trend direction + magnitude
  - Flag: AR days increasing >20% YoY → collection risk
- [x] **2d.** CapEx vs Depreciation sanity check
  - CapEx << Depreciation for 2+ years → deferred maintenance risk
  - CapEx >> Depreciation → heavy investment phase, future margin pressure

**Output:** QoE Summary card with Critical / Warning / Positive flags

---

### Phase 2.5: Deal Financial Analysis Suite — What a Real LMM Analyst Does

**What:** Automate the 15+ types of financial analysis that a lower middle market PE associate manually builds in Excel for every deal. This is the core value — the agent doesn't just extract numbers, it **thinks about them like an analyst**.

#### A. Ratio Analysis Dashboard (The Fundamentals)
- [x] **Profitability Ratios** — Gross margin, EBITDA margin, net margin, return on assets (ROA), return on equity (ROE) — trended across all available periods
- [x] **Liquidity Ratios** — Current ratio, quick ratio, cash ratio — is this business able to meet short-term obligations?
- [x] **Leverage Ratios** — Debt-to-equity, debt-to-EBITDA, interest coverage (EBITDA / interest expense), fixed charge coverage
- [x] **Efficiency Ratios** — Asset turnover, inventory turnover, receivables turnover, payables turnover — how well does management deploy capital?
- [x] **DuPont Decomposition** — Break ROE into net margin × asset turnover × equity multiplier — pinpoint what's driving (or killing) returns

#### B. Normalized EBITDA / Adjusted Earnings
- [x] **Owner addback detection** — Above-market owner compensation, personal expenses run through the business, related-party rent
- [x] **One-time vs recurring classification** — Litigation costs, restructuring, COVID impacts — are they truly non-recurring?
- [x] **Pro forma adjustments** — What EBITDA looks like post-acquisition: remove seller perks, add run-rate of recent hires, adjust for lost/won contracts
- [x] **EBITDA bridge** — Waterfall chart: Reported EBITDA → +addbacks → -questionable items → = Adjusted EBITDA

#### C. Revenue Quality Analysis
- [x] **Recurring vs non-recurring split** — Contractual/subscription revenue vs project/one-time — what % is "sticky"?
- [x] **Organic vs acquired growth** — Strip out acquisition-driven revenue to see true organic growth rate
- [x] **Revenue by customer cohort** — Are older customers growing, flat, or churning? Vintage analysis
- [x] **Pricing vs volume decomposition** — Revenue growth from selling more units vs raising prices — which is sustainable?
- [x] **Backlog / pipeline coverage** — Future revenue visibility: how many months of revenue is already contracted?

#### D. Cash Flow & Cash Conversion Analysis
- [x] **EBITDA-to-FCF conversion** — EBITDA minus CapEx minus WC changes minus taxes = true cash generation. Flag if conversion < 60%
- [x] **Cash conversion cycle (CCC)** — DSO + DIO - DPO in days — how long does it take to turn inventory/services into cash?
- [x] **Free cash flow trend** — Is FCF improving or deteriorating vs EBITDA? Divergence = red flag
- [x] **CapEx classification** — Maintenance CapEx (keep the lights on) vs growth CapEx (new capacity) — only maintenance should be deducted for "true" FCF
- [x] **Dividend / distribution capacity** — How much cash can be pulled out while maintaining operations?

#### E. Working Capital Normalization
- [x] **NWC calculation** — Current assets (excl. cash) minus current liabilities (excl. debt) — trended
- [x] **NWC as % of revenue** — Is WC growing proportionally to revenue or out of control?
- [x] **Normalized NWC target** — Average of trailing 12 months, seasonal adjustments — what's the "peg" for the purchase agreement?
- [x] **WC surplus / deficit at close** — If actual NWC at close ≠ target → purchase price adjustment up or down

#### F. Fixed vs Variable Cost Structure
- [x] **Operating leverage analysis** — What % of costs are fixed? High fixed costs = big upside if revenue grows, big risk if it drops
- [x] **Break-even revenue** — At what revenue level does EBITDA = 0? How far above break-even is the business today? (margin of safety)
- [x] **Contribution margin** — Revenue minus variable costs — what each incremental dollar of revenue contributes to profit
- [x] **Cost structure benchmarking** — COGS %, SG&A %, R&D % as % of revenue vs industry norms

#### G. Debt Capacity & Leverage Analysis
- [x] **Maximum debt capacity** — Based on 3-4x senior debt / EBITDA (typical LMM leverage), how much debt can this business support?
- [x] **Debt service coverage ratio (DSCR)** — (EBITDA - CapEx) / (interest + principal) — banks want >1.25x
- [x] **Interest coverage** — EBITDA / interest expense — flag if <3x
- [x] **Leverage scenario modeling** — At 3x, 4x, 5x leverage: what are annual debt service payments? Can the business handle it?

#### H. LBO Quick Screen
- [x] **Entry multiple** — Implied TEV / EBITDA at the asking price
- [x] **5-year exit modeling** — If entry at Xx, grow EBITDA at Y%, exit at Zx → what's the equity return (MOIC and IRR)?
- [x] **Equity check size** — At given leverage, how much equity is needed? Does it fit the fund's check size range?
- [x] **Sensitivity table** — Matrix of returns across entry multiples (rows) × exit multiples (columns) × growth rates

#### I. Comparable Analysis
- [x] **Public comps** — Pull relevant public company multiples (EV/EBITDA, EV/Revenue, P/E) for the same sector/size
- [x] **Precedent transactions** — What have similar LMM deals traded at in the last 2-3 years?
- [x] **Football field chart** — Visual range of implied valuations across DCF, comps, precedents, LBO

#### J. Seasonality & Cyclicality
- [x] **Monthly/quarterly revenue patterns** — Is this business seasonal? Which months are strong/weak?
- [x] **Cyclicality assessment** — How correlated is revenue with GDP / industry cycles? Counter-cyclical = premium
- [x] **Peak vs trough margins** — In the best and worst periods, what do margins look like? Stress-test the investment thesis

#### K. Customer & Vendor Concentration
- [x] **Top 10 customer analysis** — Revenue %, contract terms, renewal dates, growth trend per customer
- [x] **Customer churn / retention rates** — Gross and net retention — is the base stable?
- [x] **Vendor dependency** — Single-source suppliers? What happens if key vendor raises prices 20%?
- [x] **Contract analysis** — Weighted average contract length, auto-renewal %, termination provisions

#### L. Management & Workforce Metrics
- [x] **Revenue per employee** — Trended — is the team getting more or less productive?
- [x] **Compensation benchmarking** — Is management comp in line with market? Over-paying = margin opportunity. Under-paying = retention risk
- [x] **Key-person dependency** — How much revenue/relationships are tied to 1-2 people?
- [x] **Employee turnover** — Voluntary turnover rate — high turnover = culture/comp problems

**Output:** Full Deal Analysis Report — every section above generates a card/panel in the deal dashboard with charts, tables, and AI commentary. Exportable as PDF for IC presentation.

```
┌─────────────────────────────────────────────────────────────┐
│                DEAL ANALYSIS DASHBOARD                       │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ Ratio        │ Normalized   │ Revenue      │ Cash Flow      │
│ Analysis     │ EBITDA       │ Quality      │ & Conversion   │
│ Dashboard    │ Bridge       │ Breakdown    │ Analysis       │
├──────────────┼──────────────┼──────────────┼────────────────┤
│ Working      │ Cost         │ Debt         │ LBO Quick      │
│ Capital      │ Structure    │ Capacity     │ Screen         │
│ Normalization│ Analysis     │ & DSCR       │ & Returns      │
├──────────────┼──────────────┼──────────────┼────────────────┤
│ Comps &      │ Seasonality  │ Customer     │ Management     │
│ Precedents   │ & Cyclicality│ Concentration│ & Workforce    │
│ Football Fld │ Patterns     │ Risk Matrix  │ Metrics        │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

---

### Phase 3: Red Flag Deep Detection Agent

**What:** Go beyond math — detect business-level concerns that junior analysts miss.

- [x] **3a.** Revenue recognition anomalies
  - Percentage-of-completion without backlog disclosure
  - Revenue growing faster than cash collections
  - Unbilled revenue as % of total increasing
- [x] **3b.** Related-party transaction flagging
  - Detect payments to entities with similar names to seller/management
  - Flag management fees, consulting fees to related parties
- [x] **3c.** Expense capitalization detection
  - SG&A declining while revenue flat → expenses moved to balance sheet?
  - R&D capitalization rate increasing without disclosure
- [x] **3d.** Trend analysis + 3-year projections
  - Historical CAGR-based revenue projections
  - Margin trajectory extrapolation
  - Stress test: what if margins flatten?

**Output:** Red Flag Report with severity levels (Critical / Warning / Info)

---

### Phase 4: Cross-Document Verification Agent

**What:** Read multiple uploaded documents and cross-reference numbers.

- [x] **4a.** CIM vs P&L vs Tax return reconciliation
  - Compare revenue/EBITDA figures across all uploaded docs
  - Flag discrepancies >2%
- [x] **4b.** Conflict detection and seller query generation
  - Auto-generate questions for the seller: "CIM states 2023 revenue = $38.2M but P&L shows $36.8M — please reconcile"
  - Track resolution status per conflict

**Output:** Cross-Reference Matrix showing consistency across documents

---

### Phase 5: Portfolio Benchmarking (Deal-over-Deal) — THE MOAT

**What:** Compare current deal against the firm's own deal history. The more deals processed, the smarter the comparisons — competitors can't copy your private data.

- [x] **5a.** Build deal metrics store
  - Normalize and store key metrics from every extracted deal
  - Revenue, margins, growth rates, multiples, sector, deal size
- [x] **5b.** Comparable deal scoring and ranking
  - "This deal's metrics rank in the 35th percentile of your B2B SaaS deals"
  - Show where it excels and where it trails
  - Filter by sector, size, vintage year

**Output:** Benchmark Dashboard with percentile rankings vs portfolio

---

### Phase 6: Investment Memo Auto-Draft

**What:** Generate a first-draft investment memo from all extracted + analyzed data.

- [x] **6a.** Memo template engine
  - Business Overview (from CIM text extraction)
  - Financial Summary (from extracted statements)
  - Key Strengths (from QoE positive signals)
  - Key Risks (from Red Flag report)
  - Valuation Context (from benchmarks + multiples)
- [x] **6b.** Customizable per firm's memo format
  - Allow firms to upload their template structure
  - Agent fills sections based on available data

**Output:** Downloadable investment memo (DOCX/PDF) ready for partner review

---

## Why PE Firms Will Pay for This

| Pain Point | Hours Saved per Deal | Agent Feature |
|-----------|---------------------|---------------|
| Manual data entry from CIMs | 2-3 hours | Extract + Self-Correct |
| Ratio analysis & financial modeling | 3-4 hours | Deal Analysis Suite (12 modules) |
| Normalized EBITDA / addback analysis | 2-3 hours | Adjusted Earnings Agent |
| Revenue quality & cohort analysis | 1-2 hours | Revenue Quality Module |
| Cash flow & working capital analysis | 1-2 hours | Cash Conversion Agent |
| LBO quick screen & sensitivity tables | 2-3 hours | LBO Screen Agent |
| Comps & precedent transactions | 2-3 hours | Comparable Analysis Module |
| Quality of Earnings review | 3-5 hours | QoE Auto-Analysis |
| Writing investment memos | 2-3 hours | Memo Auto-Draft |
| Comparing to past deals | 1 hour (from memory) | Portfolio Benchmarking |
| Cross-referencing documents | 1-2 hours | Cross-Doc Verification |
| **Total per deal** | **20-30 hours → 1 hour review** | |

> At 50 deals/year x $150/hr associate cost = **$150K-$225K annual value per firm**
> That's essentially **replacing a junior analyst's entire workload** on initial deal screening

---

## The Moat

The more deals a firm processes → the richer their portfolio benchmark data → the more valuable the comparisons → the harder it is to switch away. **Network effect on private data.**

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent Framework | LangGraph (TypeScript) |
| LLM | GPT-4o (extraction + analysis) |
| Observability | LangSmith (trace every agent decision) |
| OCR Layer 1 | Azure Document Intelligence |
| OCR Layer 2 | pdf-parse + GPT-4o classifier |
| OCR Layer 3 | GPT-4o Vision (scanned docs) |
| Excel Parser | xlsx library |
| Database | Supabase (PostgreSQL) |
| API | Express.js (existing) |

---
---

## OTHER LANGCHAIN/LANGGRAPH INTEGRATIONS — ✅ ALL COMPLETE (Session 35)

### Drop-in Replacements (Low Risk)

- [x] Replace RAG pipeline (`rag.ts`) with LangChain's `GoogleGenerativeAIEmbeddings` + Supabase vector store
- [x] Replace manual JSON parsing in `aiExtractor.ts` with `withStructuredOutput()` using Zod schemas
- [x] Create unified LLM abstraction layer (`services/llm.ts` — swap between GPT-4 / Gemini via config env vars)

### Tool-Augmented Deal Chat

- [x] Define LangChain tools: `search_documents`, `get_deal_financials`, `compare_deals`, `get_deal_activity`, `update_deal_field`, `suggest_action`
- [x] Upgrade deal chat (`/api/deals/:dealId/chat`) to use `createReactAgent()` with tools
- [x] Upgrade portfolio chat (`/api/portfolio/chat`) to use tools (`get_portfolio_summary`, `get_deal_details`, `get_pipeline_analysis`)
- [x] LLM fetches what it needs on demand via tools instead of stuffing all deal data into system prompt

### Contact Enrichment Agent

- [x] Build `StateGraph` for contact enrichment: research → validate → conditional routing → save/review
- [x] Add conditional routing: confidence < 70% → human review, else → auto-save
- [x] API endpoint: `POST /api/ai/enrich-contact` (ready for "Enrich" button integration)

### AI Meeting Prep

- [x] Build LangGraph workflow: parallel fetch (contact history + deal status + RAG doc summaries + activities)
- [x] LLM compiles structured meeting brief with talking points, questions, risks, agenda
- [x] API endpoint: `POST /api/ai/meeting-prep` (structured JSON output, PDF export ready)

### Deal Signal Monitoring

- [x] Build LangGraph agent: fetch portfolio → analyze signals per deal → classify signal type → route & notify
- [x] Route by signal: leadership_change, financial_event, market_shift, competitive_threat, regulatory_change, growth_opportunity, risk_escalation, milestone_approaching
- [x] Signal severity routing: critical/warning signals create Activity entries for deal timeline
- [x] API endpoint: `POST /api/ai/scan-signals`

### Smart Email Drafting

- [x] Build LangGraph workflow: draft → tone check → compliance check → finalize (4-node StateGraph)
- [x] Template library: 7 PE email templates (initial outreach, follow-up, document request, LOI intro, deal update, meeting request, thank you)
- [x] Human-in-the-loop: returns `ready_for_review` or `compliance_issues` status — user reviews before sending
- [x] API endpoints: `POST /api/ai/draft-email`, `GET /api/ai/email-templates`

### Skip LangChain For (Keep Direct SDK)

- Market sentiment endpoint — now uses LangChain `withStructuredOutput()` via unified LLM layer
- Embedding calls — now use `GoogleGenerativeAIEmbeddings` from `@langchain/google-genai`
- Legacy routes still using direct OpenAI SDK (memos-chat, ai.ts) — work fine, migrate when touched
