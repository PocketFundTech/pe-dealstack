# PE Financial Intelligence Agent — Documentation

> **Product:** AI-powered financial extraction, validation, and analysis engine for PE deal teams.
> **One-liner:** "Our AI agent autonomously extracts, validates, and analyzes financials like a junior analyst — turning 5-6 hours of manual work into 5 minutes + review."

---

## Part 1: Non-Technical Overview

### What It Does

The Financial Intelligence Agent is the core analytical engine of Avise. When a deal team uploads financial documents (CIMs, P&Ls, balance sheets, Excel models), the agent:

1. **Extracts** — Reads the document and pulls out structured financial data (Income Statement, Balance Sheet, Cash Flow)
2. **Validates** — Cross-checks the numbers (do rows add up? does Net Income flow through all 3 statements?)
3. **Self-Corrects** — If validation fails, it re-reads only the failing section with a more targeted approach (up to 3 retries)
4. **Stores** — Saves the clean data to the database, detecting conflicts with previously uploaded documents
5. **Analyzes** — Runs 13+ financial analysis modules on the stored data, producing a full deal analysis dashboard

### How to Trigger It

| Action | What Happens |
|--------|-------------|
| **Upload a PDF/Excel** to a deal's Financial Statements panel | Agent extracts, validates, self-corrects, and stores the data |
| **Click "Extract Financials"** on the deal page | Opens the extraction modal (upload file or paste text) |
| **Visit the deal page** after extraction | Analysis dashboard loads automatically below Financial Statements |

### Input

The agent accepts:
- **PDF files** — CIMs, audited financials, tax returns (text-based or scanned)
- **Excel files** (.xlsx, .xls) — Financial models, P&L spreadsheets
- **Pasted text** — Raw financial data copied from any source

### How It Works (Simple Flow)

```
Document Upload
      ↓
┌─────────────┐     ┌──────────┐     ┌──────────────┐     ┌─────────┐
│   EXTRACT   │ ──→ │ VALIDATE │ ──→ │ SELF-CORRECT │ ──→ │  STORE  │
│             │     │          │     │  (if needed)  │     │         │
│ Read doc,   │     │ Math     │     │ Re-read only  │     │ Save to │
│ pull numbers│     │ checks,  │     │ failing parts │     │ database│
│             │     │ cross-   │     │ (max 3 tries) │     │         │
└─────────────┘     │ validate │     └──────────────┘     └─────────┘
                    └──────────┘
                                                                ↓
                                                     ┌──────────────────┐
                                                     │  ANALYZE (auto)  │
                                                     │                  │
                                                     │ 13+ modules run  │
                                                     │ on stored data   │
                                                     └──────────────────┘
```

### Output — The Deal Analysis Dashboard

After extraction, the deal page shows a premium tabbed dashboard with 6 sections:

#### Tab 1: Overview
- **QoE Score** (0-100) — Quality of Earnings assessment with animated score ring
- **Key Findings** — Critical/Warning/Positive flags (revenue decline, margin compression, SG&A leverage, etc.)
- **Quick Stats** — Revenue CAGR, FCF Conversion, Net Leverage, LBO Screen pass/fail
- **EBITDA Bridge** — Reported → Addbacks → Adjusted EBITDA per period
- **Revenue Quality** — CAGR, consistency score, period-over-period growth rates

#### Tab 2: Deep Dive
- **Financial Ratios** — 18 ratios across 4 groups (Profitability, Liquidity, Leverage, Efficiency) with trend charts, benchmarks, and trend arrows
- **DuPont Analysis** — ROE decomposition (Net Margin × Asset Turnover × Equity Multiplier)
- **Cost Structure** — COGS/SGA/R&D as % of revenue, break-even revenue, operating leverage

#### Tab 3: Cash & Capital
- **Cash Flow Analysis** — EBITDA → CapEx → WC Change → Free Cash Flow waterfall with conversion %
- **Working Capital** — AR, Inventory, AP, NWC per period with NWC % Revenue and normalized target
- **Debt Capacity** — Current leverage, max debt at 3x/4x, DSCR, interest coverage, headroom

#### Tab 4: Valuation
- **LBO Quick Screen** — 12-scenario sensitivity matrix (4 entry × 3 exit multiples) showing MOIC and IRR, pass/fail badge
- **Portfolio Benchmarking** — Percentile ranking vs firm's other deals (revenue, EBITDA margin, gross margin)

#### Tab 5: Diligence
- **Red Flag Analysis** — Deep detection: revenue recognition anomalies, expense capitalization, intangible surges, margin erosion, inventory buildup, equity erosion
- **Cross-Document Verification** — Compares financials across all uploaded documents, flags discrepancies >2%

#### Tab 6: Memo
- **Open Memo Builder** button — Links to the full investment memo builder page (`/memo-builder.html`)

### Value Delivered

| What the Agent Replaces | Hours Saved per Deal |
|------------------------|---------------------|
| Manual data entry from CIMs | 2-3 hours |
| Ratio analysis & financial modeling | 3-4 hours |
| Normalized EBITDA / addback analysis | 2-3 hours |
| Cash flow & working capital analysis | 1-2 hours |
| LBO quick screen & sensitivity tables | 2-3 hours |
| Quality of Earnings review | 3-5 hours |
| Cross-referencing documents | 1-2 hours |
| **Total per deal** | **15-22 hours → 5 min + review** |

### The Moat

The more deals a firm processes → the richer their portfolio benchmark data → the more valuable the comparisons → the harder it is to switch. **Network effect on private data.**

---

## Part 2: Technical Documentation

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Vanilla JS)                     │
│                                                                   │
│  deal.html → deal.js → js/financials.js → js/analysis.js        │
│                                                                   │
│  analysis.js: 6-tab dashboard, 26 render functions, Chart.js     │
│  Tabs: Overview | Deep Dive | Cash & Capital | Valuation |       │
│        Diligence | Memo                                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (PEAuth.authFetch)
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│                       API (Express.js)                           │
│                                                                   │
│  routes/financials.ts — 9 endpoints                              │
│                                                                   │
│  ┌──────────────────┐  ┌─────────────────────────────┐          │
│  │ LangGraph Agent   │  │ Financial Analysis Engine    │          │
│  │ (7 files, ~1.1K)  │  │ (financialAnalysis.ts ~1.5K) │          │
│  │                    │  │                               │          │
│  │ Extract → Validate │  │ QoE, Ratios, EBITDA Bridge, │          │
│  │ → Self-Correct →   │  │ Revenue, Cash Flow, WC,     │          │
│  │ Store              │  │ Cost, Debt, LBO, Red Flags  │          │
│  └──────────────────┘  └─────────────────────────────┘          │
│                                                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Supabase client
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DATABASE (Supabase / PostgreSQL)               │
│                                                                   │
│  FinancialStatement table                                        │
│  - UNIQUE(dealId, statementType, period, documentId)             │
│  - isActive boolean + partial unique index                       │
│  - extractionSource CHECK ('gpt4o','azure','vision','manual')    │
└─────────────────────────────────────────────────────────────────┘
```

### File Structure

```
apps/api/src/
├── routes/
│   └── financials.ts              # 9 API endpoints (~1,087 lines)
├── services/
│   ├── financialAnalysis.ts       # Analysis engine (~1,503 lines)
│   ├── financialClassifier.ts     # GPT-4o classifier
│   ├── financialExtractionOrchestrator.ts  # Fast/deep pass
│   └── agents/
│       └── financialAgent/
│           ├── index.ts           # Entry point: runFinancialAgent()
│           ├── state.ts           # LangGraph state schema
│           ├── graph.ts           # StateGraph wiring + routing
│           └── nodes/
│               ├── extractNode.ts     # 3-layer extraction
│               ├── validateNode.ts    # Math + cross-statement checks
│               ├── selfCorrectNode.ts # Targeted re-extraction
│               └── storeNode.ts       # DB persistence via runDeepPass()

apps/web/
├── deal.html                      # Analysis section container
├── deal.js                        # loadAnalysis() call
└── js/
    ├── financials.js              # Financial statements panel
    └── analysis.js                # Premium tabbed dashboard (~1,209 lines)
```

### LangGraph Agent — State Machine

#### State Schema (`state.ts`)

```typescript
type FinancialAgentStateType = {
  // ── Input ──
  dealId: string;
  documentId: string | null;
  fileName: string;
  fileType: 'pdf' | 'excel' | 'image';
  fileBuffer: Buffer | null;
  organizationId: string | null;

  // ── Extraction ──
  rawText: string;
  extractionSource: 'gpt4o' | 'azure' | 'vision' | 'manual';
  classification: ClassificationResult | null;
  statements: ClassifiedStatement[];
  overallConfidence: number;

  // ── Validation ──
  validationResult: ValidationResult | null;

  // ── Self-Correction ──
  retryCount: number;       // current retry attempt
  maxRetries: number;       // default: 3
  failedChecks: FailedCheck[];

  // ── Storage ──
  statementIds: string[];
  periodsStored: number;
  hasConflicts: boolean;

  // ── Metadata ──
  status: 'pending' | 'extracting' | 'validating' | 'self_correcting'
        | 'storing' | 'completed' | 'failed';
  warnings: string[];
  error: string | null;
  steps: AgentStep[];       // append-only execution log
};
```

#### Graph Wiring (`graph.ts`)

```
START → extractNode
  ↓
routeAfterExtract:
  - classification is null or empty → END (with error)
  - otherwise → validateNode
  ↓
routeAfterValidate:
  - all checks pass → storeNode
  - checks fail + retryCount < maxRetries → selfCorrectNode
  - checks fail + retryCount >= maxRetries → storeNode (with warnings)
  ↓
routeAfterSelfCorrect:
  - always → validateNode (loop back)
  ↓
storeNode → END
```

#### Node Details

| Node | File | Lines | What It Does |
|------|------|-------|-------------|
| **Extract** | `extractNode.ts` | 215 | Detects file type → routes to Azure Document Intelligence, pdf-parse + GPT-4o, or GPT-4o Vision. For Excel: xlsx → CSV → GPT-4o. Returns classified statements. |
| **Validate** | `validateNode.ts` | 165 | Row total checks, column total checks, 3-statement cross-validation (BS balances, CF ties to BS, NI flows through). Produces confidence score per statement. |
| **Self-Correct** | `selfCorrectNode.ts` | 251 | On validation failure → identifies failing page/table → re-extracts with targeted GPT-4o prompt → merges corrections into existing data → increments retryCount. |
| **Store** | `storeNode.ts` | 109 | Calls `runDeepPass()` to persist. Handles multi-document merge: UNIQUE constraint on `(dealId, statementType, period, documentId)`, `isActive` boolean, conflict detection. |

#### Entry Point

```typescript
// apps/api/src/services/agents/financialAgent/index.ts

import { runFinancialAgent } from './index.js';

const result = await runFinancialAgent({
  dealId: '...',
  documentId: '...',
  fileName: 'CIM.pdf',
  fileType: 'pdf',
  fileBuffer: Buffer.from(...),
  organizationId: '...',
});

// result: FinancialAgentResult
// {
//   success: boolean,
//   periodsStored: number,
//   statementIds: string[],
//   hasConflicts: boolean,
//   agent: {
//     status, retryCount, validationResult, steps[], error
//   }
// }
```

### Analysis Engine — `financialAnalysis.ts`

All analysis is **pure computation** from stored `FinancialStatement` rows. No LLM calls. Fast, free, deterministic.

#### Entry Point

```typescript
export async function analyzeFinancials(
  dealId: string,
  rows: FinancialStatement[]
): Promise<AnalysisResult>
```

#### Internal Pipeline

```
rows (FinancialStatement[])
  ↓
prepareData(rows) → { income: Map, balance: Map, cashflow: Map }
  ↓ (parallel computation)
  ├── computeQoEFlags(data)        → QoEFlag[] + score (0-100)
  ├── computeRatios(data)          → RatioGroup[] (18 ratios, 4 groups)
  ├── computeDuPont(data)          → DuPont decomposition
  ├── computeEBITDABridge(data)    → Reported → Adjusted EBITDA
  ├── computeRevenueQuality(data)  → CAGR, consistency, growth rates
  ├── computeCashFlowAnalysis(data)→ EBITDA-to-FCF conversion table
  ├── computeWorkingCapital(data)  → NWC components, normalized target
  ├── computeCostStructure(data)   → COGS/SGA/RD %, break-even, leverage
  ├── computeDebtCapacity(data)    → Max debt, DSCR, headroom
  ├── computeLBOScreen(data)       → 12-scenario MOIC/IRR matrix
  └── computeRedFlags(data)        → Deep detection flags
```

#### Analysis Modules

| Module | Key Metrics | Flags/Thresholds |
|--------|------------|------------------|
| **QoE Score** | 0-100 score from base 75 | Critical: -12, Warning: -5, Positive: +5 |
| **QoE Flags** | Revenue decline, EBITDA margin, cash conversion, AR vs revenue, CapEx vs D&A, leverage, SG&A | 10+ flag types with severity levels |
| **Profitability Ratios** | Gross margin, EBITDA margin, net margin, ROA, ROE | PE benchmarks per ratio |
| **Liquidity Ratios** | Current, quick, cash ratio | Benchmark: 1.5-3.0x |
| **Leverage Ratios** | Debt/equity, debt/EBITDA, interest coverage, fixed charge | Flag if interest coverage <3x |
| **Efficiency Ratios** | Asset turnover, DSO, DPO, cash conversion cycle | Benchmark ranges included |
| **DuPont** | ROE = Net Margin × Asset Turnover × Equity Multiplier | Per-period decomposition |
| **EBITDA Bridge** | Reported → owner addbacks → one-time items → Adjusted | Addback detection heuristics |
| **Revenue Quality** | CAGR, organic growth rates, consistency score (0-100) | Volatile if std dev > 20% |
| **Cash Flow** | EBITDA → CapEx → WC → FCF, conversion % | Flag if conversion <60% |
| **Working Capital** | AR, Inventory, AP, NWC, NWC % Revenue | Normalized NWC = trailing avg |
| **Cost Structure** | COGS%, SGA%, R&D%, OpEx%, break-even revenue | Operating leverage: high/moderate/low |
| **Debt Capacity** | Max debt @3x/4x/5x, DSCR, interest coverage, headroom | DSCR: banks want >1.25x |
| **LBO Screen** | 12-scenario matrix (4 entry × 3 exit), MOIC, IRR | Pass if any scenario IRR ≥20% |
| **Red Flags** | Revenue recognition, expense capitalization, intangible surge, margin erosion, inventory buildup, equity erosion | 6 deep detection rules |

### API Endpoints

| Method | Path | Purpose | Response |
|--------|------|---------|----------|
| `GET` | `/deals/:dealId/financials` | List all stored statements | `FinancialStatement[]` |
| `GET` | `/deals/:dealId/financials/summary` | Latest metrics + sparkline | Revenue, EBITDA, margins |
| `POST` | `/deals/:dealId/financials/extract` | **Run the agent** | `{ result, agent }` |
| `GET` | `/deals/:dealId/financials/analysis` | **Full analysis suite** | `AnalysisResult` |
| `GET` | `/deals/:dealId/financials/cross-doc` | Cross-document verification | Conflicts with Δ% |
| `GET` | `/deals/:dealId/financials/benchmark` | Portfolio benchmarking | Percentile rankings |
| `GET` | `/deals/:dealId/financials/memo` | Investment memo draft | 7-section memo object |
| `PATCH` | `/deals/:dealId/financials/:id` | User manual edits | Updated statement |
| `GET` | `/deals/:dealId/financials/conflicts` | Merge conflicts | Conflicting rows |

### Frontend — `analysis.js`

#### Tab → Module Mapping

| Tab | Modules Rendered | Render Functions |
|-----|-----------------|-----------------|
| **Overview** | QoE Score Ring, Key Findings, Quick Stats, EBITDA Bridge, Revenue Quality | `renderOverviewTab()`, `renderScoreRing()`, `renderSeverityCounts()`, `renderFlagCard()`, `renderEBITDABridge()`, `renderRevenueQuality()` |
| **Deep Dive** | Financial Ratios (4 sub-tabs with charts), DuPont, Cost Structure | `renderDeepDiveTab()`, `renderRatioDashboard()`, `renderRatioRow()`, `renderSingleRatioChart()`, `renderDuPont()`, `renderCostStructure()` |
| **Cash & Capital** | Cash Flow Analysis, Working Capital, Debt Capacity | `renderCashCapitalTab()`, `renderCashFlowAnalysis()`, `renderWorkingCapital()`, `renderDebtCapacity()` |
| **Valuation** | LBO Screen, Portfolio Benchmarking | `renderValuationTab()`, `renderLBOScreen()`, `renderBenchmark()` |
| **Diligence** | Red Flags, Cross-Doc Verification | `renderDiligenceTab()`, `renderRedFlags()`, `renderCrossDoc()` |
| **Memo** | Redirect button to Memo Builder | `renderMemoTab()` → `/memo-builder.html?id={dealId}` |

#### Styling

- **Theme:** Banker Blue (`#003366`) primary, white cards, Inter font
- **Cards:** `analysis-card` class — white bg, subtle shadow, hover lift
- **Tables:** `analysis-table` class — rounded borders, alternating row hover, summary row gradient
- **Charts:** Chart.js with gradient fills, custom tooltips (dark), Inter font
- **Animations:** `analysisFadeIn` (0.4s), `analysisSlideUp` (0.5s) on tab switch
- **Score Ring:** SVG circle with animated `stroke-dashoffset`
- **CSS injected** via `injectAnalysisStyles()` — no external stylesheet needed

#### Data Flow

```
deal.js: loadDealData()
  ├── loadFinancials(dealId)     → Financial Statements panel
  └── loadAnalysis(dealId)       → analysis.js
        │
        ├── GET /financials/analysis     → main analysis data
        ├── GET /financials/cross-doc    → conflict data
        ├── GET /financials/benchmark    → peer comparison
        └── GET /financials/memo         → memo sections
              │
              ↓ (Promise.allSettled — parallel)
        renderDashboard(data) → 6 tab panels rendered
        setTimeout → renderRatioCharts() → Chart.js instances
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent Framework | LangGraph StateGraph (TypeScript) |
| LLM | GPT-4o (extraction + classification) |
| OCR Layer 1 | Azure Document Intelligence |
| OCR Layer 2 | pdf-parse + GPT-4o |
| OCR Layer 3 | GPT-4o Vision (scanned docs) |
| Excel Parser | xlsx library |
| Analysis Engine | Pure TypeScript computation (no LLM) |
| Charts | Chart.js (CDN) |
| Database | Supabase (PostgreSQL) |
| API | Express.js |
| Auth | Supabase Auth + PEAuth middleware |

### Database Schema — FinancialStatement

```sql
CREATE TABLE "FinancialStatement" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId"        UUID NOT NULL REFERENCES "Deal"(id),
  "documentId"    UUID REFERENCES "Document"(id),
  "statementType" TEXT CHECK ("statementType" IN ('INCOME_STATEMENT','BALANCE_SHEET','CASH_FLOW')),
  period          TEXT NOT NULL,
  "periodType"    TEXT CHECK ("periodType" IN ('HISTORICAL','PROJECTED')),
  "extractionSource" TEXT CHECK ("extractionSource" IN ('gpt4o','azure','vision','manual')),
  "isActive"      BOOLEAN DEFAULT true,
  "mergeStatus"   TEXT DEFAULT 'clean',
  revenue         DECIMAL,
  "costOfRevenue" DECIMAL,
  "grossProfit"   DECIMAL,
  "operatingExpenses" DECIMAL,
  ebitda          DECIMAL,
  "netIncome"     DECIMAL,
  "totalAssets"   DECIMAL,
  "totalLiabilities" DECIMAL,
  "totalEquity"   DECIMAL,
  -- ... 30+ financial fields
  "createdAt"     TIMESTAMPTZ DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ DEFAULT now(),

  UNIQUE("dealId", "statementType", period, "documentId")
);

-- Ensures only ONE active row per (dealId, statementType, period)
CREATE UNIQUE INDEX idx_active_statement
  ON "FinancialStatement"("dealId", "statementType", period)
  WHERE "isActive" = true;
```

### Known Gotchas

| Issue | Details |
|-------|---------|
| **extractionSource constraint** | Only `'gpt4o'`, `'azure'`, `'vision'`, `'manual'` allowed — never compound values |
| **Statement type normalization** | GPT-4o returns variants (CASH_FLOW_STATEMENT, P_AND_L) — normalizer handles aliases |
| **Partial unique index** | `WHERE isActive = true` — ensures one active row per period at DB level |
| **Analysis = no LLM calls** | All analysis computed from stored rows — fast, free, deterministic |
| **escapeHtml conflict** | `deal.js` defines global `escapeHtml()` — `analysis.js` uses `esc()` internally |
| **Chart.js global** | `Chart` is loaded via CDN `<script>` — not imported, so IDE may show "not found" |
| **Self-correct max retries** | Default 3 — if all fail, data stores with warnings for human review |
| **Cross-doc threshold** | Flags discrepancies >2% between documents |

---

*Last updated: March 2026 — Session 34*
