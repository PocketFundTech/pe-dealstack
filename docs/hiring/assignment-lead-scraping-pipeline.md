# PE OS — Technical Assignment

## Lead Scraping Pipeline — Yellow Pages USA & Yelp

> **Company:** PE OS — AI-Powered CRM for Private Equity
> **Format:** Fork the repo, complete all 5 tasks, submit a single PR
> **Time:** 5-7 days (part-time, use any AI tools you want)
> **Stack:** Node.js / Express / TypeScript / Supabase (PostgreSQL) / GPT-4o

---

## About PE OS

PE OS is an AI-powered CRM for private equity firms. Deal teams use our platform to source deals, manage pipeline, and evaluate companies. One of the biggest pain points: **finding companies to acquire.**

Your assignment: **build a lead scraping pipeline** that pulls business data from Yellow Pages USA and Yelp, enriches it with AI, and feeds it into our deal pipeline as potential acquisition targets.

---

## Before You Start

1. Run the project locally (`apps/api` on port 3001, `apps/web` on port 3000)
2. Understand how deals and companies work in our system:
   - `apps/api/src/routes/deals.ts` — Deal CRUD, stages, org scoping
   - `apps/api/src/routes/companies.ts` — Company records linked to deals
   - `apps/api/src/routes/watchlist.ts` — Watchlist for tracking companies not yet in pipeline
   - `apps/api/src/middleware/orgScope.ts` — ALL data is org-scoped
3. Understand our web scraping setup:
   - `apps/api/src/services/webSearch.ts` — existing Apify Google Search integration
   - `apps/api/src/utils/urlHelpers.ts` — URL validation, SSRF prevention

---

## Task 1: Yellow Pages USA Scraper

**Problem:** PE firms looking to acquire businesses in a specific industry + geography need a way to find them. Yellow Pages USA has millions of business listings with name, address, phone, category, and sometimes revenue indicators.

**Build a service at `apps/api/src/services/leadScraping/yellowPages.ts`:**

1. **Search function:**
```typescript
async function scrapeYellowPages(params: {
  query: string;         // e.g., "plumbing", "HVAC", "dental practice"
  location: string;      // e.g., "Dallas, TX", "Florida", "90210"
  maxResults: number;    // cap at 100
}): Promise<YellowPagesResult[]>
```

2. **For each listing, extract:**
```typescript
interface YellowPagesResult {
  businessName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  category: string;          // Yellow Pages category
  website: string | null;
  yearsInBusiness: number | null;  // if shown on listing
  rating: number | null;
  reviewCount: number | null;
  isClaimedListing: boolean;       // claimed listings = more likely active
  sourceUrl: string;               // link to the YP listing
  scrapedAt: Date;
}
```

3. **Implementation approach:**
   - Use `axios` or `node-fetch` to request YP search results pages
   - Parse HTML with `cheerio` (add to dependencies if needed)
   - Handle pagination — YP shows ~30 results per page
   - Respect rate limiting — add delays between requests (1-2 seconds)
   - User-Agent rotation — use realistic browser user agents

4. **Error handling:**
   - YP blocks request → retry with backoff, then fail gracefully
   - No results found → return empty array, not an error
   - Partial page load → extract what you can, note incomplete results

**Test:** Search "plumbing" in "Dallas, TX" — verify you get structured results with all fields populated.

---

## Task 2: Yelp Business Scraper

**Problem:** Yelp has richer data than Yellow Pages — reviews, photos, price range, hours, and more engagement signals that help PE firms evaluate business quality.

**Build a service at `apps/api/src/services/leadScraping/yelp.ts`:**

1. **Search function:**
```typescript
async function scrapeYelp(params: {
  query: string;         // business type
  location: string;      // city, state, or zip
  maxResults: number;    // cap at 100
  priceRange?: number[]; // [1,2] = $ and $$, [3,4] = $$$ and $$$$
  minRating?: number;    // minimum star rating
}): Promise<YelpResult[]>
```

2. **For each listing, extract:**
```typescript
interface YelpResult {
  businessName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
  website: string | null;
  categories: string[];          // Yelp can have multiple categories
  rating: number;                // 1-5 stars
  reviewCount: number;
  priceRange: string | null;     // "$", "$$", "$$$", "$$$$"
  isOpen: boolean;
  hours: string | null;          // e.g., "Mon-Fri 8am-6pm"
  neighborhood: string | null;
  photoCount: number;
  highlightedReview: string | null;  // first/top review snippet
  sourceUrl: string;
  scrapedAt: Date;
}
```

3. **Implementation notes:**
   - Yelp is stricter about scraping — use proper headers, handle CAPTCHAs gracefully (detect and abort, don't try to solve)
   - Parse search result pages + individual listing pages for full data
   - Rate limit: 2-3 second delay between requests minimum
   - If Yelp blocks: return partial results with a `warning: "Rate limited after N results"`

4. **Deduplication with Yellow Pages:**
   - Same business may appear on both YP and Yelp
   - Add a `matchBusinesses(ypResults, yelpResults)` function that matches on:
     - Normalized business name (lowercase, strip "LLC", "Inc", etc.)
     - Phone number match
     - Address proximity (same zip code + similar street)
   - Return merged results with data from both sources

**Test:** Search "dental practice" in "Austin, TX" — verify structured results. Then run both YP + Yelp and test the dedup/merge.

---

## Task 3: AI Enrichment — Business Scoring & Deal Fit

**Problem:** Raw listings are just names and addresses. PE firms need to know: is this business a good acquisition target? How big is it? Is it growing? What's the likely revenue?

**Build a service at `apps/api/src/services/leadScraping/enrichment.ts`:**

1. **For each scraped business, use GPT-4o to estimate:**

```typescript
interface EnrichedBusiness {
  // From scrapers (Task 1 & 2)
  ...YellowPagesResult & YelpResult;

  // AI-enriched fields
  estimatedRevenue: {
    low: number;         // e.g., 500000
    high: number;        // e.g., 2000000
    confidence: number;  // 0-1
    reasoning: string;   // "Based on 15 employees, dental practice in Austin metro..."
  };
  estimatedEmployees: {
    count: number;
    source: string;      // "Inferred from review volume and location size"
  };
  businessModel: string;         // "B2C service", "B2B manufacturing", etc.
  ownerOperated: boolean | null; // likely owner-operated vs managed
  competitivePosition: string;   // "Strong local presence" / "Commoditized" / "Niche specialist"
  dealFitScore: number;          // 0-100 — how good of an acquisition target
  dealFitReasons: string[];      // ["Established 10+ years", "Strong reviews", "Fragmented market"]
  dealFitConcerns: string[];     // ["Single location", "Owner-dependent", "Low review count"]
  suggestedDealSize: {
    low: number;
    high: number;
    multiple: string;            // "3-5x EBITDA" or "1-2x Revenue"
  };
}
```

2. **Prompt design:**
   - Feed GPT-4o the business data (name, category, location, reviews, rating, years in business)
   - Ask it to estimate revenue based on industry benchmarks + signals (review count, location, years, price range)
   - Ask for deal fit assessment based on PE acquisition criteria:
     - Recurring/predictable revenue?
     - Fragmented industry (roll-up opportunity)?
     - Owner-operator vs. management team?
     - Growth indicators (review trend, expansion)?
   - Use structured output (JSON mode) for consistent parsing

3. **Batch processing:**
   - Enrich up to 20 businesses per batch call
   - Group similar businesses together in one prompt for efficiency (same industry = one prompt)
   - Track token usage per batch

4. **Cost control:**
   - Log estimated cost per enrichment
   - Skip enrichment for clearly bad leads (closed businesses, <3 stars, no phone)
   - Cache enrichment results — don't re-enrich the same business within 30 days

**Test:** Enrich 5 plumbing businesses from Dallas — verify revenue estimates are reasonable for the market.

---

## Task 4: Lead Storage & Deduplication

**Problem:** Scraped leads need to be stored, deduplicated against existing deals/companies, and made searchable by the PE team.

**Build:**

1. **Database schema** — Create a `Lead` table (include migration SQL):

```sql
CREATE TABLE "Lead" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL REFERENCES "Organization"(id),
  "businessName" TEXT NOT NULL,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "zip" TEXT,
  "phone" TEXT,
  "website" TEXT,
  "category" TEXT,
  "source" TEXT NOT NULL,              -- 'yellow_pages', 'yelp', 'both'
  "sourceUrls" JSONB,                  -- { yellowPages: "...", yelp: "..." }
  "rating" DECIMAL,
  "reviewCount" INTEGER,
  "yearsInBusiness" INTEGER,
  "enrichment" JSONB,                  -- full EnrichedBusiness data
  "dealFitScore" INTEGER,              -- denormalized for sorting/filtering
  "estimatedRevenue" DECIMAL,          -- denormalized (midpoint)
  "status" TEXT DEFAULT 'new',         -- 'new', 'reviewed', 'contacted', 'converted', 'rejected'
  "linkedDealId" UUID REFERENCES "Deal"(id),  -- set when converted to deal
  "linkedCompanyId" UUID REFERENCES "Company"(id),
  "notes" TEXT,
  "scrapedAt" TIMESTAMPTZ NOT NULL,
  "enrichedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lead_org_score ON "Lead"("organizationId", "dealFitScore" DESC);
CREATE INDEX idx_lead_org_status ON "Lead"("organizationId", "status");
CREATE INDEX idx_lead_org_category ON "Lead"("organizationId", "category");
```

2. **Deduplication service at `apps/api/src/services/leadScraping/deduplicator.ts`:**
   - Before storing a lead, check against:
     - **Existing leads** in the same org (phone match OR normalized name + zip match)
     - **Existing companies** in the org (name similarity > 85%)
     - **Existing deals** in the org (company name match)
   - If duplicate found:
     - Same lead exists → update with newer data, don't create duplicate
     - Matches existing company → link the lead to that company, flag as "already in system"
     - Matches existing deal → link to deal, flag as "already in pipeline"
   - Return dedup stats: `{ new: 45, updated: 8, alreadyInSystem: 3, alreadyInPipeline: 2 }`

3. **Batch storage:**
   - Accept array of enriched leads
   - Deduplicate the batch internally first (same business from YP + Yelp)
   - Then deduplicate against DB
   - Use transactions — if batch storage fails mid-way, rollback
   - Return per-lead status (created / updated / skipped / linked)

---

## Task 5: API Routes & Scraping Pipeline

**Problem:** Wire everything into API endpoints that the PE team can use to run scraping jobs, view results, and convert leads to deals.

**Build routes at `apps/api/src/routes/lead-scraping.ts`:**

1. **Trigger a scraping job:**
```
POST /api/leads/scrape
Body: {
  query: "plumbing",
  location: "Dallas, TX",
  sources: ["yellow_pages", "yelp"],  // or ["yellow_pages"] only
  maxResults: 50,
  autoEnrich: true,                    // run AI enrichment after scraping
  filters: {
    minRating: 3.5,                    // optional
    priceRange: [2, 3]                 // optional (Yelp only)
  }
}
```

Response:
```typescript
{
  jobId: string;
  status: 'processing';
  estimatedTime: number;     // seconds
}
```

The scraping should run **asynchronously** — return immediately with a job ID, process in background.

2. **Check job status:**
```
GET /api/leads/scrape/:jobId
```

Response:
```typescript
{
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  progress: {
    yellowPages: { found: 30, scraped: 30, done: true };
    yelp: { found: 25, scraped: 18, done: false };
    enrichment: { processed: 12, total: 45, done: false };
    deduplication: { done: false };
  };
  result?: {                 // present when completed
    totalFound: 55;
    afterDedup: 45;
    enriched: 45;
    stored: { new: 38, updated: 4, alreadyInSystem: 3 };
    topLeads: Lead[];        // top 5 by dealFitScore
  };
  error?: string;            // present when failed
}
```

3. **Browse and manage leads:**
```
GET    /api/leads?status=new&minScore=60&category=plumbing&sort=dealFitScore_desc&page=1&limit=20
GET    /api/leads/:id
PATCH  /api/leads/:id                    — update status, add notes
POST   /api/leads/:id/convert-to-deal   — create a Deal + Company from this lead
DELETE /api/leads/:id
```

4. **Convert to deal:**
   - Create a Company from lead data (name, address, phone, website)
   - Create a Deal linked to that company (stage: "sourcing", source: "lead_scraping")
   - Pre-fill deal fields from enrichment (estimated revenue, industry, business model)
   - Update lead status to `converted`, link to new deal
   - Return the created deal

5. **All routes must be:**
   - Org-scoped (`orgMiddleware`)
   - Authenticated (`authMiddleware`)
   - Audit logged (scrape jobs, conversions)
   - Rate limited: max 3 scrape jobs per hour per org (prevent abuse)

**Test the full flow:**
- Trigger a scrape → poll status → get results → browse leads → convert top lead to deal → verify deal was created with correct data

---

## How to Submit

1. Feature branch: `assignment/lead-scraping-<your-name>`
2. Single PR with all 5 tasks
3. Your PR should include:
   - Architecture overview — how the pipeline flows end to end
   - Scraping approach — how you handle rate limits, blocks, failures
   - AI enrichment prompt — why you structured it the way you did
   - Dedup logic — how matching works, what thresholds you chose
   - Cost estimates — scraping time + GPT-4o cost per batch
   - What you'd improve with more time
   - Which AI tools you used during development

## Evaluation Criteria

| Criteria | Weight | What We Look For |
|----------|--------|------------------|
| **Pipeline Architecture** | 25% | Clean flow from scrape → enrich → dedup → store, async job handling |
| **Scraping Quality** | 25% | Reliable extraction, handles failures, respects rate limits |
| **Data Quality** | 20% | Good deduplication, sensible AI enrichment, proper validation |
| **Code Quality** | 20% | Follows repo patterns, clean TypeScript, org-scoped, error handling |
| **PR Quality** | 10% | Clear docs, architecture diagram, cost awareness |

## What We Provide

- Private fork with seed data (existing deals, companies, contacts)
- Supabase staging env vars + OpenAI API key (capped at $10)
- 15-minute kickoff call + async Slack channel

## Legal Note

This assignment involves web scraping of publicly available business directory data. Use respectful scraping practices — rate limiting, proper user agents, no CAPTCHA bypassing. The scraped data is for evaluation purposes only and will not be used commercially without proper licensing.

---

*Questions? Slack channel is open. Good luck!*
