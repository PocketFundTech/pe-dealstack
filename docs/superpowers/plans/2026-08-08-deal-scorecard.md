# Deal Scorecard + Go/No-Go Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deal can be scored against two layers (general quality + firm-specific thesis fit) producing a typed `GO | NO_GO | BORDERLINE` verdict with concrete reasons, surfaced as a badge on pipeline cards and a panel on the deal page.

**Architecture:** Firm criteria live in `Organization.settings.dealCriteria` (same JSON pattern as `firmProfile`, no migration). A new `services/agents/dealScorecard/` module makes one `trackedClaudeMessage()` structured-output call and persists the verdict to a new `Deal.scorecard` JSONB column (one-line manual migration). A new route + a fire-and-forget post-extraction hook trigger scoring. Frontend: Settings criteria editor, pipeline-card badge, self-contained deal-page panel.

**Tech Stack:** `trackedClaudeMessage` (Phase 1 client — note: **no `signal` option on this branch**; use client-side `Promise.race` timeout only), hand-written JSON output schema, Vitest + supertest.

**Branch note:** `feat/deal-scorecard` is based on `feat/phase1-ai-core` (6e91d68). `routes/organizations.ts` does NOT exist on this branch (it's security-trust work on another branch) — criteria endpoints are a new small route file.

---

### Task 1: Criteria endpoints — `GET`/`PUT /api/organizations/criteria`

**Files:**
- Create: `apps/api/src/routes/organization-criteria.ts`
- Modify: `apps/api/src/app.ts` (one mount line)
- Test: `apps/api/tests/organization-criteria.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/organization-criteria.test.ts`:

```ts
/**
 * GET/PUT /api/organizations/criteria — dealCriteria settings round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));

let orgSettings: Record<string, any> = {};
let lastUpdate: Record<string, any> | null = null;

function tableMock() {
  return (table: string) => {
    if (table !== 'Organization') throw new Error(`Unexpected table: ${table}`);
    return {
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }),
      update: (patch: any) => { lastUpdate = patch; return { eq: async () => ({ error: null }) }; },
    };
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/organization-criteria.js');
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgSettings = {};
  lastUpdate = null;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('GET /api/organizations/criteria', () => {
  it('returns null criteria when none are configured and no firmProfile exists', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ criteria: null, seededFromFirmProfile: false });
  });

  it('returns a firmProfile-seeded prefill (without persisting) when criteria are absent', async () => {
    orgSettings = { firmProfile: { sectors: ['SaaS', 'Healthcare'] } };
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.status).toBe(200);
    expect(res.body.seededFromFirmProfile).toBe(true);
    expect(res.body.criteria.sectorsInclude).toEqual(['SaaS', 'Healthcare']);
    expect(lastUpdate).toBeNull(); // read-time seeding only, nothing written
  });

  it('returns stored criteria verbatim when configured', async () => {
    orgSettings = { dealCriteria: { sectorsInclude: ['Industrial'], sectorsExclude: [], dealSizeMin: 5, dealSizeMax: 15, revenueMin: null, revenueMax: null, ebitdaMin: 1, hardExclusions: ['startups'], thesis: 'Boring businesses' } };
    const app = await buildApp();
    const res = await request(app).get('/api/organizations/criteria');
    expect(res.body.criteria.dealSizeMax).toBe(15);
    expect(res.body.seededFromFirmProfile).toBe(false);
  });
});

describe('PUT /api/organizations/criteria', () => {
  it('validates and persists criteria into settings.dealCriteria, preserving other settings', async () => {
    orgSettings = { firmProfile: { sectors: ['SaaS'] } };
    const app = await buildApp();
    const body = {
      sectorsInclude: ['SaaS'], sectorsExclude: ['Retail'],
      dealSizeMin: 5, dealSizeMax: 15, revenueMin: null, revenueMax: null,
      ebitdaMin: 1, hardExclusions: ['startups', 'turnarounds'], thesis: 'Recurring revenue only',
    };
    const res = await request(app).put('/api/organizations/criteria').send(body);
    expect(res.status).toBe(200);
    expect(lastUpdate!.settings.dealCriteria.thesis).toBe('Recurring revenue only');
    expect(lastUpdate!.settings.firmProfile).toEqual({ sectors: ['SaaS'] }); // untouched
  });

  it('rejects an invalid body with 400', async () => {
    const app = await buildApp();
    const res = await request(app).put('/api/organizations/criteria').send({ dealSizeMin: 'not-a-number' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/organization-criteria.test.ts`
Expected: FAIL — module `../src/routes/organization-criteria.js` doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/organization-criteria.ts` (modeled on `onboarding-firm.ts`'s settings-merge pattern):

```ts
// ─── Organization deal criteria (dealCriteria settings) ───────────
// GET/PUT /api/organizations/criteria — the firm's investment criteria
// used by the deal scorecard. Stored in Organization.settings.dealCriteria
// (same JSON pattern as settings.firmProfile — no migration).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

export const dealCriteriaSchema = z.object({
  sectorsInclude: z.array(z.string()).max(30).default([]),
  sectorsExclude: z.array(z.string()).max(30).default([]),
  dealSizeMin: z.number().nullable().default(null),
  dealSizeMax: z.number().nullable().default(null),
  revenueMin: z.number().nullable().default(null),
  revenueMax: z.number().nullable().default(null),
  ebitdaMin: z.number().nullable().default(null),
  hardExclusions: z.array(z.string()).max(30).default([]),
  thesis: z.string().max(2000).default(''),
});

export type DealCriteria = z.infer<typeof dealCriteriaSchema>;

async function loadSettings(orgId: string): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  return (data?.settings || {}) as Record<string, any>;
}

// GET /api/organizations/criteria
router.get('/criteria', async (req: Request, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);

    if (settings.dealCriteria) {
      return res.json({ criteria: settings.dealCriteria, seededFromFirmProfile: false });
    }

    // Read-time seeding from the research agent's firmProfile — nothing persisted.
    const firmProfile = settings.firmProfile as { sectors?: string[] } | undefined;
    if (firmProfile?.sectors?.length) {
      const seeded = dealCriteriaSchema.parse({ sectorsInclude: firmProfile.sectors });
      return res.json({ criteria: seeded, seededFromFirmProfile: true });
    }

    res.json({ criteria: null, seededFromFirmProfile: false });
  } catch (error: any) {
    log.error('criteria GET failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load criteria' });
  }
});

// PUT /api/organizations/criteria
router.put('/criteria', async (req: Request, res: Response) => {
  const parsed = dealCriteriaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid criteria', details: parsed.error.flatten() });
  }
  try {
    const orgId = getOrgId(req);
    const settings = await loadSettings(orgId);
    const updatedSettings = { ...settings, dealCriteria: parsed.data };
    const { error } = await supabase
      .from('Organization')
      .update({ settings: updatedSettings })
      .eq('id', orgId);
    if (error) throw error;
    res.json({ success: true, criteria: parsed.data });
  } catch (error: any) {
    log.error('criteria PUT failed', { error: error.message });
    res.status(500).json({ error: 'Failed to save criteria' });
  }
});

export default router;
```

In `apps/api/src/app.ts`, import next to the other route imports:

```ts
import organizationCriteriaRouter from './routes/organization-criteria.js';
```

and mount next to the other authenticated mounts (after the `usersRouter` line):

```ts
app.use('/api/organizations', authMiddleware, orgMiddleware, usageContextMiddleware, organizationCriteriaRouter);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/organization-criteria.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/organization-criteria.ts apps/api/src/app.ts apps/api/tests/organization-criteria.test.ts
git commit -m "feat(scorecard): dealCriteria settings endpoints (GET/PUT /api/organizations/criteria)"
```

---

### Task 2: `scoreDeal` engine + migration

**Files:**
- Create: `apps/api/src/services/agents/dealScorecard/index.ts`
- Create: `apps/api/scorecard-migration.sql`
- Test: `apps/api/tests/deal-scorecard-engine.test.ts`

- [ ] **Step 1: Write the migration file**

Create `apps/api/scorecard-migration.sql`:

```sql
-- ============================================================
-- Deal Scorecard Migration — Deal.scorecard
-- Adds the JSONB column holding the two-layer scorecard verdict.
--
-- To apply: psql "$SUPABASE_DB_URL" -f apps/api/scorecard-migration.sql
-- Or run via the Supabase SQL editor. (Vercel does NOT run this.)
-- ============================================================

ALTER TABLE public."Deal"
  ADD COLUMN IF NOT EXISTS "scorecard" jsonb;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/tests/deal-scorecard-engine.test.ts`:

```ts
/**
 * services/agents/dealScorecard — scoreDeal engine tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackedClaudeMessage = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const analyzeFinancials = vi.fn();
vi.mock('../src/services/analysis/index.js', () => ({
  analyzeFinancials: (...args: any[]) => analyzeFinancials(...args),
}));

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

let dealRow: any;
let statements: any[];
let orgSettings: Record<string, any>;
let persistedScorecard: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: dealRow, error: null }) }) }) }),
        update: (patch: any) => { persistedScorecard = patch.scorecard; return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      };
    }
    if (table === 'FinancialStatement') {
      return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: statements, error: null }) }) }) }) };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: orgSettings }, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

const CRITERIA = {
  sectorsInclude: ['Software'], sectorsExclude: [], dealSizeMin: 5, dealSizeMax: 15,
  revenueMin: null, revenueMax: null, ebitdaMin: 1, hardExclusions: ['startups'], thesis: 'Recurring revenue',
};

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      overallScore: 72, verdict: 'GO', qualityScore: 78, thesisFitScore: 66,
      reasons: [{ kind: 'hit', text: 'Within size range' }],
      ...overrides,
    }),
    model: 'claude-sonnet-5',
    stopReason: 'end_turn',
    usage: { inputTokens: 900, outputTokens: 150 },
  };
}

async function getEngine() {
  return await import('../src/services/agents/dealScorecard/index.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedScorecard = null;
  dealRow = { id: 'deal-1', name: 'Acme', industry: 'Software', stage: 'INITIAL_REVIEW', revenue: 10, ebitda: 2, dealSize: 12, irrProjected: null, mom: null, description: null };
  statements = [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 } }];
  orgSettings = { dealCriteria: CRITERIA };
  analyzeFinancials.mockResolvedValue({ redFlags: [{ severity: 'medium', title: 'Customer concentration' }] });
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.DEAL_SCORECARD_TIMEOUT_MS;
});

describe('scoreDeal', () => {
  it('produces and persists a schema-shaped scorecard with scoredAt and served model', async () => {
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { scoreDeal } = await getEngine();
    const result = await scoreDeal('deal-1', 'org-1');

    expect(result.verdict).toBe('GO');
    expect(result.overallScore).toBe(72);
    expect(result.model).toBe('claude-sonnet-5');
    expect(typeof result.scoredAt).toBe('string');
    expect(persistedScorecard).toEqual(result);

    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.operation).toBe('deal_scorecard');
    expect(call.role).toBe('chat');
    expect(call.outputSchema).toBeDefined();
    // Criteria and financial data both reach the prompt
    expect(call.messages[0].content).toContain('Recurring revenue');
    expect(call.messages[0].content).toContain('Customer concentration');
  });

  it('throws CRITERIA_NOT_CONFIGURED when the org has no dealCriteria', async () => {
    orgSettings = {};
    const { scoreDeal, CriteriaNotConfiguredError } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toBeInstanceOf(CriteriaNotConfiguredError);
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('scores on metadata alone when no financials exist, without calling analyzeFinancials', async () => {
    statements = [];
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { scoreDeal } = await getEngine();
    await scoreDeal('deal-1', 'org-1');
    expect(analyzeFinancials).not.toHaveBeenCalled();
    expect(trackedClaudeMessage.mock.calls[0][0].messages[0].content).toContain('No extracted financial statements');
  });

  it('throws (and persists nothing) when the deal is not in the org', async () => {
    dealRow = null;
    const { scoreDeal } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toThrow('Deal not found');
    expect(persistedScorecard).toBeNull();
  });

  it('throws (and persists nothing) when the model call fails', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('boom'));
    const { scoreDeal } = await getEngine();
    await expect(scoreDeal('deal-1', 'org-1')).rejects.toThrow('boom');
    expect(persistedScorecard).toBeNull();
  });
});

describe('maybeScoreAfterExtraction', () => {
  it('runs scoreDeal when criteria exist', async () => {
    trackedClaudeMessage.mockResolvedValue(verdict());
    const { maybeScoreAfterExtraction } = await getEngine();
    await maybeScoreAfterExtraction('deal-1', 'org-1');
    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op when criteria are not configured', async () => {
    orgSettings = {};
    const { maybeScoreAfterExtraction } = await getEngine();
    await expect(maybeScoreAfterExtraction('deal-1', 'org-1')).resolves.toBeUndefined();
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('never throws even when scoring fails', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('boom'));
    const { maybeScoreAfterExtraction } = await getEngine();
    await expect(maybeScoreAfterExtraction('deal-1', 'org-1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/deal-scorecard-engine.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create `apps/api/src/services/agents/dealScorecard/index.ts`:

```ts
// ─── Deal Scorecard engine ───────────────────────────────────────
// Two-layer deal scoring: general quality + firm thesis fit.
// One trackedClaudeMessage structured-output call; verdict persisted
// to Deal.scorecard (JSONB — see apps/api/scorecard-migration.sql,
// applied MANUALLY per the repo's Supabase-migrations convention).
//
// NOTE: this branch's trackedClaudeMessage has no `signal` option —
// the timeout below races client-side only (same as other Phase 1
// call sites on this branch).

import { supabase } from '../../../supabase.js';
import { trackedClaudeMessage } from '../../ai/client.js';
import { analyzeFinancials } from '../../analysis/index.js';
import { log } from '../../../utils/logger.js';

const SCORECARD_TIMEOUT_MS = 30_000;

export class CriteriaNotConfiguredError extends Error {
  constructor() {
    super('Investment criteria are not configured for this organization');
    this.name = 'CriteriaNotConfiguredError';
  }
}

export interface Scorecard {
  overallScore: number;
  verdict: 'GO' | 'NO_GO' | 'BORDERLINE';
  qualityScore: number;
  thesisFitScore: number;
  reasons: Array<{ kind: 'hit' | 'miss' | 'flag'; text: string }>;
  scoredAt: string;
  model: string;
}

const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    overallScore: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['GO', 'NO_GO', 'BORDERLINE'] },
    qualityScore: { type: 'integer', minimum: 0, maximum: 100 },
    thesisFitScore: { type: 'integer', minimum: 0, maximum: 100 },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['hit', 'miss', 'flag'] },
          text: { type: 'string' },
        },
        required: ['kind', 'text'],
      },
    },
  },
  required: ['overallScore', 'verdict', 'qualityScore', 'thesisFitScore', 'reasons'],
};

const SCORECARD_SYSTEM_PROMPT = `You are scoring a private-equity deal against a two-layer rubric for an investment team.

Layer 1 — general quality (qualityScore 0-100): revenue durability/recurrence, margin quality, customer concentration, CapEx intensity, and any red flags from the financial analysis provided.
Layer 2 — thesis fit (thesisFitScore 0-100): how well the deal matches the firm's stated criteria (sectors, size bounds, hard exclusions, thesis).

Rules:
- Score ONLY from the data provided. Never invent numbers or facts. If financial data is missing, say so explicitly in a reason and keep the quality score conservative.
- Every NO_GO verdict must include at least one "miss" reason tied to a specific criterion (e.g. "outside size range: $28M vs the firm's $5-15M max").
- "hit" = criterion satisfied, "miss" = criterion violated, "flag" = quality concern not tied to a criterion.
- verdict: GO when both layers are strong, NO_GO when a hard criterion is violated or quality is poor, BORDERLINE otherwise.
- overallScore reflects both layers, weighted toward thesis fit — a great business the firm would never buy is not a GO.`;

/** Load the org's dealCriteria, or null if unset. */
async function loadCriteria(orgId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  const settings = (data?.settings || {}) as Record<string, any>;
  return settings.dealCriteria ?? null;
}

export async function scoreDeal(dealId: string, orgId: string): Promise<Scorecard> {
  const criteria = await loadCriteria(orgId);
  if (!criteria) throw new CriteriaNotConfiguredError();

  const { data: deal } = await supabase
    .from('Deal')
    .select('id, name, industry, stage, revenue, ebitda, dealSize, irrProjected, mom, description')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .single();
  if (!deal) throw new Error('Deal not found');

  const { data: statements } = await supabase
    .from('FinancialStatement')
    .select('statementType, period, lineItems')
    .eq('dealId', dealId)
    .eq('isActive', true)
    .order('period', { ascending: false });

  let financialSection: string;
  if (statements && statements.length > 0) {
    const analysis = await analyzeFinancials(dealId, statements);
    const flags = (analysis.redFlags ?? [])
      .map((f: any) => `- [${f.severity ?? 'unknown'}] ${f.title ?? f.description ?? JSON.stringify(f)}`)
      .join('\n');
    financialSection = `Extracted statements (${statements.length}):\n${statements
      .slice(0, 6)
      .map((s) => `- ${s.statementType} ${s.period}: ${JSON.stringify(s.lineItems).slice(0, 500)}`)
      .join('\n')}\n\nRed flags from analysis:\n${flags || '- none identified'}`;
  } else {
    financialSection = 'No extracted financial statements are available for this deal — score quality from deal-level metadata only and note this limitation in a reason.';
  }

  const userPrompt = `## Firm Criteria\n${JSON.stringify(criteria, null, 2)}\n\n## Deal\n${JSON.stringify(deal, null, 2)}\n\n## Financial Data\n${financialSection}`;

  const timeoutMs = Number(process.env.DEAL_SCORECARD_TIMEOUT_MS) > 0
    ? Number(process.env.DEAL_SCORECARD_TIMEOUT_MS)
    : SCORECARD_TIMEOUT_MS;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Deal scorecard timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  let result: { text: string; model: string };
  try {
    result = await Promise.race([
      trackedClaudeMessage({
        operation: 'deal_scorecard',
        role: 'chat',
        system: SCORECARD_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        outputSchema: SCORECARD_SCHEMA,
        maxTokens: 2000,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const parsed = JSON.parse(result.text);
  const scorecard: Scorecard = { ...parsed, scoredAt: new Date().toISOString(), model: result.model };

  const { error: updateError } = await supabase
    .from('Deal')
    .update({ scorecard })
    .eq('id', dealId)
    .eq('organizationId', orgId);
  if (updateError) throw updateError;

  log.info('[dealScorecard] scored', { dealId, verdict: scorecard.verdict, overallScore: scorecard.overallScore });
  return scorecard;
}

/**
 * Post-extraction hook: score if criteria are configured; silent no-op
 * otherwise. Never throws — never allowed to affect the extraction
 * response it piggybacks on.
 */
export async function maybeScoreAfterExtraction(dealId: string, orgId: string): Promise<void> {
  try {
    const criteria = await loadCriteria(orgId);
    if (!criteria) return;
    await scoreDeal(dealId, orgId);
  } catch (err: any) {
    log.warn(`[dealScorecard] post-extraction scoring skipped: ${err?.message}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/deal-scorecard-engine.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/agents/dealScorecard/index.ts apps/api/scorecard-migration.sql apps/api/tests/deal-scorecard-engine.test.ts
git commit -m "feat(scorecard): scoreDeal engine — two-layer structured-output verdict + migration"
```

---

### Task 3: Score route + post-extraction hook

**Files:**
- Create: `apps/api/src/routes/deals-scorecard.ts`
- Modify: `apps/api/src/app.ts` (mount + aiLimiter line)
- Modify: `apps/api/src/routes/financials-extraction.ts` (two hook call sites)
- Test: `apps/api/tests/deals-scorecard-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/deals-scorecard-route.test.ts`:

```ts
/**
 * POST /api/deals/:dealId/scorecard route tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const scoreDeal = vi.fn();
class CriteriaNotConfiguredError extends Error {}
vi.mock('../src/services/agents/dealScorecard/index.js', () => ({
  scoreDeal: (...args: any[]) => scoreDeal(...args),
  CriteriaNotConfiguredError,
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-scorecard.js');
  const app = express();
  app.use(express.json());
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1' };
});

describe('POST /api/deals/:dealId/scorecard', () => {
  it('returns the persisted scorecard on success', async () => {
    scoreDeal.mockResolvedValue({ overallScore: 72, verdict: 'GO', qualityScore: 78, thesisFitScore: 66, reasons: [], scoredAt: 'now', model: 'claude-sonnet-5' });
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('GO');
    expect(scoreDeal).toHaveBeenCalledWith('deal-1', 'org-1');
  });

  it('404s when the deal is not in the caller org', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(404);
    expect(scoreDeal).not.toHaveBeenCalled();
  });

  it('400s with code CRITERIA_NOT_CONFIGURED when criteria are missing', async () => {
    scoreDeal.mockRejectedValue(new CriteriaNotConfiguredError('no criteria'));
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CRITERIA_NOT_CONFIGURED');
  });

  it('500s with a clear message on engine failure (e.g. missing scorecard column)', async () => {
    scoreDeal.mockRejectedValue(new Error("column \"scorecard\" of relation \"Deal\" does not exist"));
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('scorecard');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/deals-scorecard-route.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/deals-scorecard.ts`:

```ts
// ─── Deal scorecard route ─────────────────────────────────────────
// POST /api/deals/:dealId/scorecard — run the two-layer scorecard
// for a deal and return the persisted verdict.

import { Router } from 'express';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { scoreDeal, CriteriaNotConfiguredError } from '../services/agents/dealScorecard/index.js';
import { log } from '../utils/logger.js';

const router = Router();

router.post('/:dealId/scorecard', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const scorecard = await scoreDeal(dealId, orgId);
    res.json(scorecard);
  } catch (error: any) {
    if (error instanceof CriteriaNotConfiguredError) {
      return res.status(400).json({
        error: 'Set your investment criteria in Settings before scoring deals.',
        code: 'CRITERIA_NOT_CONFIGURED',
      });
    }
    log.error('Deal scorecard failed', { error: error.message });
    res.status(500).json({ error: `Failed to score deal: ${error.message}` });
  }
});

export default router;
```

In `apps/api/src/app.ts`: import `dealsScorecardRouter from './routes/deals-scorecard.js';`, add the rate-limit line next to the other `/api/deals/*` aiLimiter lines:

```ts
app.use('/api/deals/*/scorecard', aiLimiter);              // trackedClaudeMessage
```

and mount next to the other deals routers:

```ts
app.use('/api/deals', authMiddleware, orgMiddleware, usageContextMiddleware, dealsScorecardRouter);
```

- [ ] **Step 4: Wire the post-extraction hook**

In `apps/api/src/routes/financials-extraction.ts`, add to the imports:

```ts
import { maybeScoreAfterExtraction } from '../services/agents/dealScorecard/index.js';
```

In the `POST /deals/:dealId/financials/extract` handler, immediately before its final `res.json({ success: agentResult.status === 'completed', ...` response (after the `finally { releaseExtractionSlot(orgId); }` block), insert:

```ts
    // Fire-and-forget: re-score the deal against firm criteria now that
    // fresh financials exist. Never awaited, never affects this response.
    if (agentResult.status === 'completed') {
      void maybeScoreAfterExtraction(dealId, orgId);
    }
```

In the `POST /documents/:documentId/extract-financials` handler, find its equivalent success path (the `res.json` after its `runFinancialAgent` call, around line 335) and insert the same guarded `void maybeScoreAfterExtraction(...)` call — read the handler first to use its actual local variable names for dealId/orgId.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/deals-scorecard-route.test.ts tests/deal-scorecard-engine.test.ts tests/organization-criteria.test.ts`
Expected: PASS (17 tests)

Then the full suite: `cd apps/api && npx vitest run`
Expected: baseline for this branch (795 passed / 44 skipped / 8 known `mfa-bypass.test.ts` failures) + 17 new passes, no new failures.

Then `cd apps/api && npx tsc --noEmit` — expect only this branch's pre-existing errors (3 `stop_details` in client.ts, 2 memo-route `PostgrestFilterBuilder`); nothing new.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/deals-scorecard.ts apps/api/src/app.ts apps/api/src/routes/financials-extraction.ts apps/api/tests/deals-scorecard-route.test.ts
git commit -m "feat(scorecard): score route + post-extraction auto-score hook"
```

---

### Task 4: Frontend — Settings criteria editor, pipeline badge, deal-page panel

**Files:**
- Modify: `apps/web-next/src/types/index.ts` (Scorecard type + Deal field)
- Create: `apps/web-next/src/app/(app)/settings/CriteriaSection.tsx`
- Modify: `apps/web-next/src/app/(app)/settings/page.tsx` (register section)
- Modify: `apps/web-next/src/app/(app)/deals/deals-deal-card.tsx` (badge)
- Create: `apps/web-next/src/app/(app)/deals/[id]/deal-scorecard-section.tsx`
- Modify: `apps/web-next/src/app/(app)/deals/[id]/deal-page-left-panel.tsx` (render section)
- Create: `apps/web-next/src/app/(app)/deals/scorecard-badge.test.tsx`

- [ ] **Step 1: Add types**

In `apps/web-next/src/types/index.ts`, above `export interface Deal`:

```ts
export interface DealScorecard {
  overallScore: number;
  verdict: "GO" | "NO_GO" | "BORDERLINE";
  qualityScore: number;
  thesisFitScore: number;
  reasons: Array<{ kind: "hit" | "miss" | "flag"; text: string }>;
  scoredAt: string;
  model: string;
}
```

and inside `Deal`, after `tags?: string[];`:

```ts
  scorecard?: DealScorecard | null;
```

- [ ] **Step 2: Write the failing badge test**

Create `apps/web-next/src/app/(app)/deals/scorecard-badge.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScorecardBadge } from "./scorecard-badge";
import type { DealScorecard } from "@/types";

function card(verdict: DealScorecard["verdict"], overallScore = 72): DealScorecard {
  return { overallScore, verdict, qualityScore: 70, thesisFitScore: 74, reasons: [], scoredAt: "2026-08-08T00:00:00Z", model: "claude-sonnet-5" };
}

describe("ScorecardBadge", () => {
  it("renders GO with the score", () => {
    render(<ScorecardBadge scorecard={card("GO", 81)} />);
    expect(screen.getByText(/GO 81/)).toBeTruthy();
  });

  it("renders NO-GO", () => {
    render(<ScorecardBadge scorecard={card("NO_GO", 22)} />);
    expect(screen.getByText(/NO-GO 22/)).toBeTruthy();
  });

  it("renders nothing when unscored", () => {
    const { container } = render(<ScorecardBadge scorecard={null} />);
    expect(container.firstChild).toBeNull();
  });
});
```

Run: `cd apps/web-next && npx vitest run "src/app/(app)/deals/scorecard-badge.test.tsx"`
Expected: FAIL — `./scorecard-badge` doesn't exist.

- [ ] **Step 3: Implement the badge**

Create `apps/web-next/src/app/(app)/deals/scorecard-badge.tsx`:

```tsx
import { cn } from "@/lib/cn";
import type { DealScorecard } from "@/types";

const VERDICT_STYLES: Record<DealScorecard["verdict"], { label: string; cls: string }> = {
  GO: { label: "GO", cls: "bg-green-50 border-green-200 text-green-700" },
  NO_GO: { label: "NO-GO", cls: "bg-red-50 border-red-200 text-red-600" },
  BORDERLINE: { label: "", cls: "bg-amber-50 border-amber-200 text-amber-700" },
};

export function ScorecardBadge({ scorecard }: { scorecard?: DealScorecard | null }) {
  if (!scorecard) return null;
  const v = VERDICT_STYLES[scorecard.verdict];
  return (
    <span
      className={cn(
        "px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap leading-none",
        v.cls,
      )}
      title={`Scorecard: quality ${scorecard.qualityScore}, thesis fit ${scorecard.thesisFitScore}`}
    >
      {v.label ? `${v.label} ${scorecard.overallScore}` : `${scorecard.overallScore}`}
    </span>
  );
}
```

In `deals-deal-card.tsx`, import it and render it inside the header chip group (the `div` with `className="flex items-center gap-1 shrink-0"`), before the stage chip:

```tsx
import { ScorecardBadge } from "./scorecard-badge";
// ... in the chip group:
              <ScorecardBadge scorecard={deal.scorecard} />
```

Run the badge test again — expect PASS (3 tests).

- [ ] **Step 4: Implement the deal-page section (self-contained, same pattern as `DealAnalysisSection`)**

Create `apps/web-next/src/app/(app)/deals/[id]/deal-scorecard-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DealScorecard } from "@/types";

const REASON_ICONS: Record<DealScorecard["reasons"][number]["kind"], { icon: string; cls: string }> = {
  hit: { icon: "check_circle", cls: "text-green-600" },
  miss: { icon: "cancel", cls: "text-red-500" },
  flag: { icon: "flag", cls: "text-amber-600" },
};

export function DealScorecardSection({
  dealId,
  initialScorecard,
}: {
  dealId: string;
  initialScorecard?: DealScorecard | null;
}) {
  const [scorecard, setScorecard] = useState<DealScorecard | null>(initialScorecard ?? null);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCriteria, setNeedsCriteria] = useState(false);

  const runScore = async () => {
    setScoring(true);
    setError(null);
    setNeedsCriteria(false);
    try {
      const result = await api.post<DealScorecard>(`/deals/${dealId}/scorecard`, {});
      setScorecard(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to score deal";
      if (msg.includes("investment criteria")) setNeedsCriteria(true);
      else setError(msg);
    } finally {
      setScoring(false);
    }
  };

  return (
    <div className="bg-background-body rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-[#003366]">grading</span>
          <span className="text-xs font-bold uppercase tracking-wider text-text-muted">Deal Scorecard</span>
        </div>
        <button
          onClick={runScore}
          disabled={scoring}
          className="px-3 py-1.5 rounded-md text-xs font-semibold text-white disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          {scoring ? "Scoring..." : scorecard ? "Re-score" : "Score deal"}
        </button>
      </div>

      {needsCriteria && (
        <p className="text-xs text-text-secondary">
          Set your investment criteria first —{" "}
          <Link href="/settings#criteria" className="text-[#003366] font-semibold underline">
            open Settings
          </Link>
          .
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {scorecard && (
        <div className="mt-1">
          <div className="flex items-center gap-4 mb-3">
            <span
              className={cn(
                "px-3 py-1.5 rounded-md border text-sm font-bold",
                scorecard.verdict === "GO" && "bg-green-50 border-green-200 text-green-700",
                scorecard.verdict === "NO_GO" && "bg-red-50 border-red-200 text-red-600",
                scorecard.verdict === "BORDERLINE" && "bg-amber-50 border-amber-200 text-amber-700",
              )}
            >
              {scorecard.verdict.replace("_", "-")} · {scorecard.overallScore}/100
            </span>
            <div className="text-xs text-text-muted">
              <div>Quality: <span className="font-semibold text-text-main">{scorecard.qualityScore}</span></div>
              <div>Thesis fit: <span className="font-semibold text-text-main">{scorecard.thesisFitScore}</span></div>
            </div>
          </div>
          <ul className="space-y-1">
            {scorecard.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-text-secondary">
                <span className={cn("material-symbols-outlined text-[16px] shrink-0", REASON_ICONS[r.kind].cls)}>
                  {REASON_ICONS[r.kind].icon}
                </span>
                {r.text}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-text-muted mt-2">
            Scored {new Date(scorecard.scoredAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
```

In `deal-page-left-panel.tsx`: import it and render between `<FinancialMetricsRow deal={deal} />` and `<FinancialStatementsSection ...>`:

```tsx
        {/* Deal Scorecard section */}
        <DealScorecardSection dealId={dealId} initialScorecard={(deal as { scorecard?: import("@/types").DealScorecard | null }).scorecard} />
```

(If `DealDetail` in this page's types already extends `Deal`, drop the cast and use `deal.scorecard` directly — check when editing.)

- [ ] **Step 5: Implement the Settings criteria editor**

Create `apps/web-next/src/app/(app)/settings/CriteriaSection.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DealCriteria {
  sectorsInclude: string[];
  sectorsExclude: string[];
  dealSizeMin: number | null;
  dealSizeMax: number | null;
  revenueMin: number | null;
  revenueMax: number | null;
  ebitdaMin: number | null;
  hardExclusions: string[];
  thesis: string;
}

const EMPTY: DealCriteria = {
  sectorsInclude: [], sectorsExclude: [], dealSizeMin: null, dealSizeMax: null,
  revenueMin: null, revenueMax: null, ebitdaMin: null, hardExclusions: [], thesis: "",
};

const csv = (arr: string[]) => arr.join(", ");
const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function CriteriaSection() {
  const [criteria, setCriteria] = useState<DealCriteria>(EMPTY);
  const [seeded, setSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<{ criteria: DealCriteria | null; seededFromFirmProfile: boolean }>(
          "/organizations/criteria",
        );
        if (data.criteria) setCriteria(data.criteria);
        setSeeded(data.seededFromFirmProfile);
      } catch (err) {
        console.warn("criteria load failed", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.put("/organizations/criteria", criteria);
      setSaved(true);
      setSeeded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save criteria");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-text-muted">Loading criteria...</p>;

  return (
    <div className="bg-surface-card rounded-lg border border-border-subtle p-6">
      <h3 className="text-base font-bold text-text-main mb-1">Investment Criteria</h3>
      <p className="text-xs text-text-muted mb-4">
        The deal scorecard grades every deal against these criteria.
        {seeded && " Pre-filled from your firm profile — review and save."}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="text-xs font-semibold text-text-secondary">
          Sectors (include)
          <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.sectorsInclude)}
            onChange={(e) => setCriteria({ ...criteria, sectorsInclude: parseCsv(e.target.value) })} placeholder="SaaS, Healthcare" />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Sectors (exclude)
          <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.sectorsExclude)}
            onChange={(e) => setCriteria({ ...criteria, sectorsExclude: parseCsv(e.target.value) })} placeholder="Retail" />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Deal size min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.dealSizeMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, dealSizeMin: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Deal size max ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.dealSizeMax ?? ""}
            onChange={(e) => setCriteria({ ...criteria, dealSizeMax: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Revenue min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.revenueMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, revenueMin: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          EBITDA min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.ebitdaMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, ebitdaMin: num(e.target.value) })} />
        </label>
      </div>

      <label className="block text-xs font-semibold text-text-secondary mt-4">
        Hard exclusions
        <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.hardExclusions)}
          onChange={(e) => setCriteria({ ...criteria, hardExclusions: parseCsv(e.target.value) })} placeholder="startups, turnarounds" />
      </label>

      <label className="block text-xs font-semibold text-text-secondary mt-4">
        Investment thesis
        <textarea rows={3} className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.thesis}
          onChange={(e) => setCriteria({ ...criteria, thesis: e.target.value })} placeholder="Recurring-revenue businesses with low CapEx..." />
      </label>

      <div className="flex items-center gap-3 mt-4">
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-md text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: "#003366" }}>
          {saving ? "Saving..." : "Save criteria"}
        </button>
        {saved && <span className="text-xs text-green-600 font-semibold">Saved</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

In `settings/page.tsx`: import `CriteriaSection`, add a `{ id: "criteria", label: "Investment Criteria", icon: "grading" }` entry to `NAV_SECTIONS` (read the actual shape of existing entries and match it), and render `<div id="section-criteria"><CriteriaSection /></div>` alongside the other sections (place after `FirmProfileSection`).

- [ ] **Step 6: Run frontend tests + typecheck**

Run: `cd apps/web-next && npx vitest run`
Expected: baseline (61 on this branch) + 3 badge tests, all passing.

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: no errors in files this task touched (this worktree may show the known pre-existing `@types/react` hoisting artifact in untouched files — compare against files touched, not total count).

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/types/index.ts "apps/web-next/src/app/(app)/settings/CriteriaSection.tsx" "apps/web-next/src/app/(app)/settings/page.tsx" "apps/web-next/src/app/(app)/deals/deals-deal-card.tsx" "apps/web-next/src/app/(app)/deals/scorecard-badge.tsx" "apps/web-next/src/app/(app)/deals/scorecard-badge.test.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-scorecard-section.tsx" "apps/web-next/src/app/(app)/deals/[id]/deal-page-left-panel.tsx"
git commit -m "feat(scorecard): criteria settings UI, pipeline badge, deal-page scorecard panel"
```

---

### Task 5: Manual verification (not a coding task)

Standing caveat, same as every cycle this session: no local Supabase/Anthropic credentials in this sandboxed worktree — genuine end-to-end verification is not possible here and must not be claimed. Static verification (full suites + typecheck) is the ceiling. Whoever has real credentials must, before merging: (1) run `apps/api/scorecard-migration.sql` against Supabase (manual — Vercel won't), (2) set criteria in Settings, score a real deal, confirm the verdict + reasons are sensible and the badge appears on the pipeline card, (3) run a financial extraction and confirm the auto-score fires without affecting the extraction response, (4) confirm a NO_GO includes a criterion-tied miss reason.

---

## Rollout

No feature flag — additive feature, nothing existing changes behavior; rollback is `git revert`. Deploy coupling: the manual `Deal.scorecard` column migration must run before the score endpoint works (clear 500 until then). Watch `UsageEvent` rows for `operation = 'deal_scorecard'` to see real usage/cost. Note the branch lands on the `feat/phase1-ai-core` stack — it ships with the V2 merge chain.
