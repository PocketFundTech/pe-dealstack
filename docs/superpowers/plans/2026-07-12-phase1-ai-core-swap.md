# Phase 1 — AI Core Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OpenAI/OpenRouter extraction stack with a single Anthropic client (Fable 5 default) doing one structured-output extraction call per document, behind an `EXTRACTION_ENGINE` flag, with a bake-off harness gating any legacy deletion.

**Architecture:** A new `services/ai/` module (model map + tracked client wrapper) and a new `services/extraction/` module (JSON schema, normalizer, Claude engine) produce the existing `ClassificationResult` interface, so the LangGraph financial agent, validator, orchestrator, and store node are untouched except for: a `'claude'` value in `ExtractionSource`, an engine branch in `extractNode`, skip-guards in `verifyNode`/`crossVerifyNode`, and one routing guard in `graph.ts`. Repair (max 1 pass) happens inside the engine using the existing deterministic `validateStatements`.

**Tech Stack:** `@anthropic-ai/sdk` (latest), structured outputs (`output_config.format` json_schema), Files API (`files-api-2025-04-14`), server-side refusal fallbacks (`server-side-fallback-2026-06-01`, Fable 5 → Opus 4.8), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-phase1-ai-core-swap-design.md`

**Out of scope (separate follow-up plan):** migrating the ~40 non-extraction LLM call sites (memos, insights, emails). This plan covers spec items 1–5 and 7; item 6 gets its own plan once this one is proven.

**Conventions used throughout:** ESM imports with `.js` suffix; tests live flat in `apps/api/tests/`; run tests with `npm test -- <file>` from `apps/api/`; commit after every green test. All paths below are relative to repo root unless noted.

---

### Task 1: Branch, SDK upgrade, and DB migration file

**Files:**
- Create: `apps/api/phase1-claude-extraction-migration.sql`
- Modify: `apps/api/package.json` (dependency bump only, via npm)

- [ ] **Step 1: Create the working branch**

```bash
cd "/Users/ganesh/AI CRM"
git checkout -b feat/phase1-ai-core
```

Note: the tree carries unrelated in-progress security edits. Only ever `git add` the specific files this plan names — never `git add -A`.

- [ ] **Step 2: Upgrade the Anthropic SDK**

```bash
cd "/Users/ganesh/AI CRM/apps/api"
npm install @anthropic-ai/sdk@latest
node -e "console.log(require('@anthropic-ai/sdk/package.json').version)"
```

Expected: version prints (≥ 0.9x, newer than the current ^0.91.1). If `output_config` or `betas` types are missing later, this step is the fix point.

- [ ] **Step 3: Write the migration file**

Create `apps/api/phase1-claude-extraction-migration.sql`:

```sql
-- Phase 1: Claude extraction engine (spec 2026-07-11)
-- RUN MANUALLY in Supabase SQL editor — Vercel deploys code but never runs SQL.

-- 1) Allow 'claude' as an extractionSource on FinancialStatement.
-- Default Postgres name for an inline column CHECK is <table>_<column>_check.
-- If the DROP fails, find the real name with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = '"FinancialStatement"'::regclass AND contype = 'c';
ALTER TABLE "FinancialStatement"
  DROP CONSTRAINT IF EXISTS "FinancialStatement_extractionSource_check";
ALTER TABLE "FinancialStatement"
  ADD CONSTRAINT "FinancialStatement_extractionSource_check"
  CHECK ("extractionSource" IN ('gpt4o', 'azure', 'vision', 'manual', 'claude'));

-- 2) Price rows so UsageEvent cost attribution works for the new models.
-- (modelPrices.ts caches this table; costUsd=0 + priceLookupFailed=true otherwise.)
INSERT INTO "ModelPrice" (model, provider, "inputPricePer1M", "outputPricePer1M") VALUES
  ('claude-fable-5',  'anthropic', 10, 50),
  ('claude-opus-4-8', 'anthropic',  5, 25),
  ('claude-sonnet-5', 'anthropic',  3, 15),
  ('claude-haiku-4-5','anthropic',  1,  5)
ON CONFLICT (model) DO UPDATE
  SET "inputPricePer1M" = EXCLUDED."inputPricePer1M",
      "outputPricePer1M" = EXCLUDED."outputPricePer1M",
      provider = EXCLUDED.provider;
```

If `ON CONFLICT (model)` errors because the unique key differs, check the table's constraints and adjust the conflict target — do not remove the upsert.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/phase1-claude-extraction-migration.sql apps/api/package.json package-lock.json
git commit -m "chore(ai): upgrade anthropic sdk + phase1 extraction migration sql"
```

**⚠️ Operator action (blocking for Tasks 6+ against real DB, not for unit tests):** run the SQL in Supabase, and verify in the Anthropic Console that the org is on ≥30-day data retention (Fable 5 400s on every request otherwise).

---

### Task 2: Model map — `services/ai/models.ts`

**Files:**
- Create: `apps/api/src/services/ai/models.ts`
- Test: `apps/api/tests/ai-models.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/ai-models.test.ts`:

```typescript
/**
 * AI role → model map tests (Phase 1 AI core swap).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['AI_EXTRACTION_MODEL', 'AI_CHAT_MODEL', 'AI_FAST_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function getModels() {
  return await import('../src/services/ai/models.js');
}

describe('getModelConfig', () => {
  it('defaults extraction to claude-fable-5 with refusal fallback to opus 4.8', async () => {
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('extraction');
    expect(cfg.model).toBe('claude-fable-5');
    expect(cfg.betas).toContain('server-side-fallback-2026-06-01');
    expect(cfg.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
  });

  it('defaults chat to sonnet 5 and fast to haiku 4.5, with no fallback plumbing', async () => {
    const { getModelConfig } = await getModels();
    expect(getModelConfig('chat').model).toBe('claude-sonnet-5');
    expect(getModelConfig('fast').model).toBe('claude-haiku-4-5');
    expect(getModelConfig('chat').fallbacks).toBeUndefined();
    expect(getModelConfig('chat').betas).toEqual([]);
  });

  it('honors env overrides and drops fable-only plumbing when downgraded', async () => {
    process.env.AI_EXTRACTION_MODEL = 'claude-opus-4-8';
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('extraction');
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.fallbacks).toBeUndefined();
    expect(cfg.betas).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/ai-models.test.ts
```

Expected: FAIL — cannot find module `../src/services/ai/models.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/ai/models.ts`:

```typescript
/**
 * AI role → Anthropic model map (Phase 1 AI core swap).
 * Single source of truth replacing utils/aiModels.ts tiers for new call sites.
 *
 * Roles (spec 2026-07-11):
 *   extraction → claude-fable-5 (founder decision; env-downgradable)
 *   chat       → claude-sonnet-5
 *   fast       → claude-haiku-4-5
 *
 * Fable 5 request shaping handled here so call sites never branch:
 *   - never send a `thinking` param (explicit disable 400s on Fable 5)
 *   - server-side refusal fallback to claude-opus-4-8
 */

export type AiRole = 'extraction' | 'chat' | 'fast';

export interface ModelConfig {
  model: string;
  maxTokens: number;
  /** anthropic-beta flags this model requires (callers may append more). */
  betas: string[];
  /** Server-side refusal fallback chain (Fable 5 only). */
  fallbacks?: Array<{ model: string }>;
}

const DEFAULTS: Record<AiRole, string> = {
  extraction: 'claude-fable-5',
  chat: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5',
};

const ENV_OVERRIDES: Record<AiRole, string> = {
  extraction: 'AI_EXTRACTION_MODEL',
  chat: 'AI_CHAT_MODEL',
  fast: 'AI_FAST_MODEL',
};

const MAX_TOKENS: Record<AiRole, number> = {
  extraction: 64000, // large multi-period JSON output
  chat: 16000,
  fast: 4096,
};

export function getModelConfig(role: AiRole): ModelConfig {
  const model = process.env[ENV_OVERRIDES[role]] || DEFAULTS[role];
  const cfg: ModelConfig = { model, maxTokens: MAX_TOKENS[role], betas: [] };
  if (model === 'claude-fable-5') {
    cfg.betas.push('server-side-fallback-2026-06-01');
    cfg.fallbacks = [{ model: 'claude-opus-4-8' }];
  }
  return cfg;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/ai-models.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/ai/models.ts apps/api/tests/ai-models.test.ts
git commit -m "feat(ai): role-based anthropic model map with fable-5 extraction default"
```

---

### Task 3: Tracked client wrapper — `services/ai/client.ts`

**Files:**
- Create: `apps/api/src/services/ai/client.ts`
- Test: `apps/api/tests/ai-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/ai-client.test.ts`:

```typescript
/**
 * Tracked Anthropic client wrapper tests (Phase 1 AI core swap).
 * The SDK is mocked; assertions cover request shaping, refusal handling,
 * and UsageEvent recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamCalls: any[] = [];
let nextFinalMessage: any;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (req: any) => {
          streamCalls.push(req);
          return { finalMessage: async () => nextFinalMessage };
        },
      },
      files: { upload: vi.fn() },
    };
  }
  return { default: MockAnthropic, toFile: vi.fn(async (b: any) => b) };
});

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => { recorded.push(e); }),
}));

function okMessage(text: string) {
  return {
    model: 'claude-fable-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1200, output_tokens: 340 },
  };
}

beforeEach(() => {
  streamCalls.length = 0;
  recorded.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.AI_EXTRACTION_MODEL;
});

async function getClient() {
  return await import('../src/services/ai/client.js');
}

describe('trackedClaudeMessage', () => {
  it('shapes a fable-5 extraction request: no thinking, fallbacks + betas, output_config', async () => {
    nextFinalMessage = okMessage('{"ok":true}');
    const { trackedClaudeMessage } = await getClient();
    const res = await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    });
    const req = streamCalls[0];
    expect(req.model).toBe('claude-fable-5');
    expect(req.thinking).toBeUndefined();
    expect(req.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    expect(req.betas).toContain('server-side-fallback-2026-06-01');
    expect(req.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    });
    expect(res.text).toBe('{"ok":true}');
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it('records a UsageEvent with the served model and token counts', async () => {
    nextFinalMessage = okMessage('x');
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'financial_extraction',
      provider: 'anthropic',
      model: 'claude-fable-5',
      promptTokens: 1200,
      completionTokens: 340,
      status: 'success',
    });
  });

  it('throws AIRefusalError on stop_reason refusal and records status blocked', async () => {
    nextFinalMessage = {
      model: 'claude-fable-5',
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const { trackedClaudeMessage, AIRefusalError } = await getClient();
    await expect(
      trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).rejects.toBeInstanceOf(AIRefusalError);
    expect(recorded[0]).toMatchObject({ status: 'blocked' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/ai-client.test.ts
```

Expected: FAIL — cannot find module `../src/services/ai/client.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/ai/client.ts`:

```typescript
/**
 * Single tracked Anthropic client (Phase 1 AI core swap).
 *
 * Every new-stack LLM call goes through trackedClaudeMessage():
 *  - resolves model + request shaping from models.ts (role map)
 *  - streams (large max_tokens would time out non-streaming)
 *  - handles stop_reason "refusal" (throws AIRefusalError — a refusal that
 *    survives the server-side fallback chain is a content outcome, not a 500)
 *  - records a UsageEvent (fire-and-forget ledger, provider 'anthropic')
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../../utils/logger.js';
import { recordUsageEvent } from '../usage/trackedLLM.js';
import { getModelConfig, type AiRole } from './models.js';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — AI features unavailable');
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Test-only: reset the singleton (mirrors _resetModelPriceCache convention). */
export function _resetAnthropicClient(): void {
  _client = null;
}

export class AIRefusalError extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super(`Claude declined the request${category ? ` (category: ${category})` : ''}`);
    this.name = 'AIRefusalError';
    this.category = category;
  }
}

export interface ClaudeCallOptions {
  /** UsageEvent operation name, e.g. 'financial_extraction'. */
  operation: string;
  role: AiRole;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  /** JSON schema for structured output (output_config.format). */
  outputSchema?: Record<string, unknown>;
  /** Extra anthropic-beta flags (e.g. files-api-2025-04-14). */
  extraBetas?: string[];
  maxTokens?: number;
}

export interface ClaudeCallResult {
  text: string;
  /** Model that actually served the response (fallback-aware). */
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export async function trackedClaudeMessage(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const startedAt = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    messages: opts.messages,
    betas: [...cfg.betas, ...(opts.extraBetas ?? [])],
  };
  if (opts.system) request.system = opts.system;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.outputSchema) {
    request.output_config = { format: { type: 'json_schema', schema: opts.outputSchema } };
  }
  // Never send `thinking`: Fable 5 rejects explicit configs; other models
  // use their defaults.

  const record = (status: 'success' | 'error' | 'blocked', model: string, inTok: number, outTok: number) =>
    void recordUsageEvent({
      operation: opts.operation,
      provider: 'anthropic',
      status,
      model,
      promptTokens: inTok,
      completionTokens: outTok,
      durationMs: Date.now() - startedAt,
    }).catch(() => { /* ledger is fire-and-forget */ });

  try {
    const stream = client.beta.messages.stream(request as never);
    const message = await stream.finalMessage();

    const inTok = message.usage?.input_tokens ?? 0;
    const outTok = message.usage?.output_tokens ?? 0;

    if (message.stop_reason === 'refusal') {
      record('blocked', message.model, inTok, outTok);
      const category =
        message.stop_details && 'category' in message.stop_details
          ? ((message.stop_details as { category: string | null }).category)
          : null;
      throw new AIRefusalError(category);
    }

    record('success', message.model, inTok, outTok);
    const text = (message.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { text, model: message.model, stopReason: message.stop_reason ?? null, usage: { inputTokens: inTok, outputTokens: outTok } };
  } catch (err) {
    if (err instanceof AIRefusalError) throw err;
    record('error', cfg.model, 0, 0);
    log.error('trackedClaudeMessage failed', { operation: opts.operation, model: cfg.model, err });
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/ai-client.test.ts
```

Expected: 3 passed. If TypeScript complains that `stream`'s request type rejects `betas`/`fallbacks`/`output_config`, keep the `as never` cast (the SDK's beta types lag the API; the wire shape is per the migration guide) — do not remove the fields.

- [ ] **Step 5: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/ai/client.ts apps/api/tests/ai-client.test.ts
git commit -m "feat(ai): tracked anthropic client wrapper with refusal handling + usage ledger"
```

---

### Task 4: Extraction schema + prompts — `services/extraction/extractionSchema.ts`

**Files:**
- Create: `apps/api/src/services/extraction/extractionSchema.ts`
- Test: covered by Task 5's normalizer tests (schema is data + Zod mirror; no logic)

- [ ] **Step 1: Write the module**

Create `apps/api/src/services/extraction/extractionSchema.ts`:

```typescript
/**
 * Structured-output schema for Claude financial extraction (Phase 1).
 *
 * Design decisions (spec 2026-07-11):
 *  - lineItems is an ARRAY of {name, value, sourcePage, sourceQuote} — JSON
 *    schema with additionalProperties:false cannot express open records, and
 *    per-item provenance replaces the legacy verify/cross-verify passes.
 *  - Values are reported EXACTLY AS PRINTED; unitScale/currency per statement.
 *    Numeric normalization happens in TypeScript (normalize.ts), not prompts.
 */

import { z } from 'zod';

export const RAW_UNIT_SCALES = ['UNITS', 'THOUSANDS', 'MILLIONS', 'BILLIONS'] as const;

// ── Zod mirror (validates the parsed model output) ────────────────────
const rawLineItem = z.object({
  name: z.string(),
  value: z.number().nullable(),
  sourcePage: z.number().int().nullable(),
  sourceQuote: z.string().nullable(),
});

const rawPeriod = z.object({
  period: z.string(),
  periodType: z.enum(['HISTORICAL', 'PROJECTED', 'LTM']),
  confidence: z.number(),
  lineItems: z.array(rawLineItem),
});

const rawStatement = z.object({
  statementType: z.enum(['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW']),
  unitScale: z.enum(RAW_UNIT_SCALES),
  currency: z.string(),
  periods: z.array(rawPeriod),
});

export const extractionResponseZod = z.object({
  statements: z.array(rawStatement),
  overallConfidence: z.number(),
  warnings: z.array(z.string()),
});

export type ExtractionResponse = z.infer<typeof extractionResponseZod>;
export type RawStatement = z.infer<typeof rawStatement>;
export type RawLineItem = z.infer<typeof rawLineItem>;

// ── JSON schema sent to the API (output_config.format.schema) ─────────
// Hand-written: structured outputs require additionalProperties:false and
// do not support numeric min/max, so keep it constraint-light.
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statementType: { type: 'string', enum: ['INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW'] },
          unitScale: { type: 'string', enum: [...RAW_UNIT_SCALES] },
          currency: { type: 'string', description: 'ISO code as printed, e.g. USD, EUR' },
          periods: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                period: { type: 'string', description: 'e.g. "2022", "2025E", "LTM"' },
                periodType: { type: 'string', enum: ['HISTORICAL', 'PROJECTED', 'LTM'] },
                confidence: { type: 'integer', description: '0-100 confidence for this period' },
                lineItems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'snake_case canonical name from the vocabulary' },
                      value: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Value EXACTLY as printed — do NOT convert units' },
                      sourcePage: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: '1-based page the value appears on' },
                      sourceQuote: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Short verbatim snippet containing the value' },
                    },
                    required: ['name', 'value', 'sourcePage', 'sourceQuote'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['period', 'periodType', 'confidence', 'lineItems'],
              additionalProperties: false,
            },
          },
        },
        required: ['statementType', 'unitScale', 'currency', 'periods'],
        additionalProperties: false,
      },
    },
    overallConfidence: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['statements', 'overallConfidence', 'warnings'],
  additionalProperties: false,
} as const;

// ── Prompts ───────────────────────────────────────────────────────────
// Canonical vocabulary mirrors financialSchema.ts keys so the existing
// validator/orchestrator/UI keep working unchanged.
export const EXTRACTION_SYSTEM_PROMPT = `You are a private-equity financial analyst extracting 3-statement financial data from deal documents (CIMs, financial packages, filings).

Rules:
- Report every value EXACTLY as printed in the document. Do NOT convert units or currencies — instead set unitScale (UNITS/THOUSANDS/MILLIONS/BILLIONS) and currency per statement to describe how the document prints them.
- Use these canonical snake_case names when a line represents the same concept, even if the document's label differs (e.g. "Turnover"/"Net Sales" → revenue):
  income statement: revenue, cogs, gross_profit, gross_margin_pct, sga, rd, other_opex, total_opex, ebitda, ebitda_margin_pct, da, ebit, interest_expense, ebt, tax, net_income, sde
  balance sheet: cash, accounts_receivable, inventory, other_current_assets, total_current_assets, ppe_net, goodwill, intangibles, total_assets, accounts_payable, short_term_debt, other_current_liabilities, total_current_liabilities, long_term_debt, total_liabilities, total_equity
  cash flow: operating_cf, capex, fcf, acquisitions, debt_repayment, dividends, net_change_cash, investing_activities, financing_activities
  Anything material that doesn't match gets a descriptive snake_case name. Any invented name for a ratio, rate, or multiple (not a dollar amount) MUST end in _pct (percentages) or _ratio/_multiple (e.g. tax_rate_pct, debt_to_ebitda_ratio, current_ratio) — downstream code scales dollar amounts by unitScale but leaves these suffixed fields untouched, so an unsuffixed ratio would be silently corrupted.
- Percentages (names ending _pct) are reported as percent numbers (e.g. 42.5), never fractions — the one exception to "exactly as printed": convert a printed decimal fraction (0.425) to its percent equivalent (42.5).
- Every line item needs sourcePage (1-based) and a short verbatim sourceQuote when the value is visible in the document; use null only when genuinely unavailable.
- One period entry per fiscal period column. Projected periods keep their suffix (e.g. "2025E").
- If a statement type is absent, omit it and add a warning.`;

export const EXTRACTION_USER_INSTRUCTION = `Extract all income statement, balance sheet, and cash flow data from the attached document into the required JSON structure.`;

/** Repair prompt: one pass, targeted at deterministic validator failures. */
export function buildRepairInstruction(failures: string[], previousJson: string): string {
  return `A deterministic validator found these problems with your previous extraction:
${failures.map((f) => `- ${f}`).join('\n')}

Your previous extraction JSON:
${previousJson}

Re-examine the document and return the FULL corrected extraction in the same JSON structure. Fix the flagged values by re-reading the source pages; keep values that were correct unchanged. Remember: values exactly as printed, unitScale/currency describe the document.`;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npx tsc --noEmit
```

Expected: no NEW errors from `src/services/extraction/extractionSchema.ts` (pre-existing worktree errors, if any, are out of scope).

- [ ] **Step 3: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/extraction/extractionSchema.ts
git commit -m "feat(extraction): structured-output schema + prompts for claude engine"
```

---

### Task 5: Normalizer — `services/extraction/normalize.ts`

**Files:**
- Create: `apps/api/src/services/extraction/normalize.ts`
- Test: `apps/api/tests/extraction-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/extraction-normalize.test.ts`:

```typescript
/**
 * Normalizer tests: raw as-printed extraction → ClassificationResult in
 * canonical millions, with _source provenance strings.
 */
import { describe, it, expect } from 'vitest';
import type { ExtractionResponse } from '../src/services/extraction/extractionSchema.js';

async function getNormalize() {
  const mod = await import('../src/services/extraction/normalize.js');
  return mod.toClassificationResult;
}

function fixture(overrides: Partial<ExtractionResponse> = {}): ExtractionResponse {
  return {
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale: 'THOUSANDS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 92,
            lineItems: [
              { name: 'revenue', value: 45200, sourcePage: 12, sourceQuote: 'Revenue of $45,200' },
              { name: 'total_revenue', value: 45200, sourcePage: 12, sourceQuote: 'Total revenue $45,200' },
              { name: 'ebitda_margin_pct', value: 18.5, sourcePage: 13, sourceQuote: 'EBITDA margin 18.5%' },
              { name: 'ebitda', value: 8362, sourcePage: 13, sourceQuote: 'EBITDA $8,362' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 90,
    warnings: [],
    ...overrides,
  };
}

describe('toClassificationResult', () => {
  it('converts THOUSANDS to millions and leaves _pct fields unscaled', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(fixture());
    const li = result.statements[0].periods[0].lineItems;
    expect(li.revenue).toBeCloseTo(45.2);
    expect(li.ebitda).toBeCloseTo(8.362);
    expect(li.ebitda_margin_pct).toBeCloseTo(18.5); // percentages never scaled
    expect(result.statements[0].unitScale).toBe('MILLIONS'); // post-conversion
  });

  it('folds provenance into <name>_source strings and dedupes aliases', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(fixture());
    const li = result.statements[0].periods[0].lineItems as Record<string, unknown>;
    expect(li.revenue_source).toBe('p12: "Revenue of $45,200"');
    // total_revenue is an alias of revenue — canonical key wins, no duplicate
    expect(li.total_revenue).toBeUndefined();
  });

  it('adds a warning for non-USD currency and for BILLIONS scale conversion', async () => {
    const toClassificationResult = await getNormalize();
    const result = toClassificationResult(
      fixture({
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'BILLIONS',
            currency: 'EUR',
            periods: [
              {
                period: '2023',
                periodType: 'HISTORICAL',
                confidence: 80,
                lineItems: [{ name: 'revenue', value: 1.2, sourcePage: 3, sourceQuote: '€1.2bn revenue' }],
              },
            ],
          },
        ],
      }),
    );
    expect(result.statements[0].periods[0].lineItems.revenue).toBeCloseTo(1200);
    expect(result.warnings.some((w) => w.includes('EUR'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/extraction-normalize.test.ts
```

Expected: FAIL — cannot find module `../src/services/extraction/normalize.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/extraction/normalize.ts`:

```typescript
/**
 * Normalizer: raw as-printed Claude extraction → the existing
 * ClassificationResult interface (financialClassifier.ts), so the validator,
 * orchestrator, store node, and UI are untouched.
 *
 * - Scale conversion to canonical MILLIONS happens HERE (deterministic code),
 *   not in prompts — the top source of legacy scale errors (spec §3.2).
 *   Converted values are rounded to 4 decimals to kill reciprocal-multiply
 *   float noise (mirrors financialClassifier.ts's own rounding convention).
 * - Ratio-like fields (name ends `_pct`, `_ratio`, or `_multiple`) are never
 *   scaled — matches the suffix convention the prompt requires for any
 *   invented ratio/rate/multiple name (extractionSchema.ts).
 * - Provenance folds into the legacy `${name}_source` string convention: the
 *   VERBATIM sourceQuote (matching financialClassifier.ts's own convention —
 *   see extractionPrompt.ts's source_quote examples), falling back to a bare
 *   `p{page}` marker only when no quote was captured. A prefix-wrapped quote
 *   would never literally appear in the source document, which silently
 *   defeats storeNode.ts's scoreSourceMatch() substring check.
 * - Alias canonicalization is delegated to validateLineItems (financialSchema),
 *   which exports its alias table so this module has a single source of truth.
 */

import type {
  ClassificationResult,
  ClassifiedStatement,
} from '../financialClassifier.js';
import { validateLineItems, LINE_ITEM_ALIASES } from '../financialSchema.js';
import type { ExtractionResponse, RawStatement } from './extractionSchema.js';

const SCALE_TO_MILLIONS: Record<RawStatement['unitScale'], number> = {
  UNITS: 1 / 1_000_000,
  THOUSANDS: 1 / 1_000,
  MILLIONS: 1,
  BILLIONS: 1_000,
};

/** Round to 4 decimals — kills float noise from the reciprocal scale factors above. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Post-pass after validateLineItems: when both an alias and its canonical
 * target are present (validateLineItems only renames when the canonical key
 * is absent), drop the alias so the record has a single, unambiguous key.
 */
function dropDuplicateAliases(
  record: Record<string, unknown>,
  warnings: string[],
): void {
  for (const [alias, canonical] of Object.entries(LINE_ITEM_ALIASES)) {
    if (alias in record && canonical in record) {
      delete record[alias];
      delete record[`${alias}_source`];
      warnings.push(`Dropped duplicate alias "${alias}" (canonical "${canonical}" present)`);
    }
  }
}

function foldPeriodLineItems(
  items: Array<{ name: string; value: number | null; sourcePage: number | null; sourceQuote: string | null }>,
  factor: number,
): Record<string, number | string | null> {
  const record: Record<string, number | string | null> = {};
  for (const item of items) {
    const name = item.name.trim().toLowerCase().replace(/\s+/g, '_');
    // First non-null value wins — a null placeholder shouldn't shadow a
    // real value reported under the same name later in the array.
    if (name in record && record[name] !== null) continue;
    const isUnscaled = name.endsWith('_pct') || name.endsWith('_ratio') || name.endsWith('_multiple');
    record[name] = item.value === null ? null : isUnscaled ? item.value : round4(item.value * factor);
    if (item.sourcePage !== null || item.sourceQuote !== null) {
      const page = item.sourcePage !== null ? `p${item.sourcePage}` : 'p?';
      record[`${name}_source`] = item.sourceQuote !== null ? item.sourceQuote : page;
    }
  }
  return record;
}

export function toClassificationResult(raw: ExtractionResponse): ClassificationResult {
  const warnings: string[] = [...raw.warnings];
  const statements: ClassifiedStatement[] = [];

  for (const stmt of raw.statements) {
    const factor = SCALE_TO_MILLIONS[stmt.unitScale];
    if (stmt.unitScale !== 'MILLIONS') {
      warnings.push(`${stmt.statementType}: converted ${stmt.unitScale} → MILLIONS (×${factor})`);
    }
    if (stmt.currency && stmt.currency.toUpperCase() !== 'USD') {
      warnings.push(`${stmt.statementType}: currency is ${stmt.currency} — values NOT converted to USD`);
    }

    const periods = stmt.periods.map((p) => {
      const folded = foldPeriodLineItems(p.lineItems, factor);
      const { normalized, warnings: itemWarnings } = validateLineItems(stmt.statementType, folded);
      warnings.push(...itemWarnings.map((w) => `${stmt.statementType} ${p.period}: ${w}`));
      dropDuplicateAliases(normalized, warnings);
      return {
        period: p.period,
        periodType: p.periodType,
        confidence: Math.max(0, Math.min(100, Math.round(p.confidence))),
        lineItems: normalized as Record<string, number | null>,
      };
    });

    statements.push({
      statementType: stmt.statementType,
      unitScale: 'MILLIONS', // post-conversion canonical scale
      currency: stmt.currency || 'USD',
      periods,
    });
  }

  return {
    statements,
    overallConfidence: Math.max(0, Math.min(100, Math.round(raw.overallConfidence))),
    warnings,
  };
}
```

**Note (post-review correction, 2026-07-27):** this block supersedes the plan's original Step 3 code — the first version wrapped `_source` as `` `p{page}: "{quote}"` ``, which would never literally appear in source document text and silently defeated `storeNode.ts`'s `scoreSourceMatch()` check; it also used unrounded reciprocal multiplication (float noise) and only exempted `_pct` (not `_ratio`/`_multiple`) from scaling. See the corresponding fix commit on `feat/phase1-ai-core` and the updated `EXTRACTION_SYSTEM_PROMPT` in Task 4 (ratio/multiple suffix rule).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/extraction-normalize.test.ts
```

Expected: 3 passed. (The alias-dedup assertion relies on `validateLineItems` renaming `total_revenue`→`revenue`; since `revenue` already exists, the alias is dropped — matching its documented "canonical wins" behavior. If the assertion fails because both keys survive, the fix belongs in `foldPeriodLineItems`: delete alias keys whose canonical target exists after `validateLineItems` returns.)

- [ ] **Step 5: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/extraction/normalize.ts apps/api/tests/extraction-normalize.test.ts
git commit -m "feat(extraction): deterministic scale/currency normalizer with provenance folding"
```

---

### Task 6: Claude extraction engine — `services/extraction/claudeEngine.ts`

**Files:**
- Create: `apps/api/src/services/extraction/claudeEngine.ts`
- Test: `apps/api/tests/claude-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/claude-engine.test.ts`:

```typescript
/**
 * Claude extraction engine tests. ai/client is mocked; validateStatements is
 * real (deterministic), so the repair path is exercised with genuinely
 * inconsistent numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let responses: string[] = [];

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    const text = responses.shift() ?? '{"statements":[],"overallConfidence":0,"warnings":[]}';
    return { text, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({
    beta: { files: { upload: vi.fn(async () => ({ id: 'file_test123' })) } },
  })),
}));

function isJson(revenue: number, cogs: number, grossProfit: number): string {
  return JSON.stringify({
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 90,
            lineItems: [
              { name: 'revenue', value: revenue, sourcePage: 1, sourceQuote: 'rev' },
              { name: 'cogs', value: cogs, sourcePage: 1, sourceQuote: 'cogs' },
              { name: 'gross_profit', value: grossProfit, sourcePage: 1, sourceQuote: 'gp' },
            ],
          },
        ],
      },
    ],
    overallConfidence: 90,
    warnings: [],
  });
}

beforeEach(() => {
  calls.length = 0;
  responses = [];
});

async function getEngine() {
  const mod = await import('../src/services/extraction/claudeEngine.js');
  return mod.extractWithClaude;
}

describe('extractWithClaude', () => {
  it('extracts a consistent PDF in one call (no repair)', async () => {
    responses = [isJson(100, 40, 60)]; // 100 - 40 = 60 ✓
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).not.toBeNull();
    expect(out!.repairUsed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(out!.classification.statements[0].periods[0].lineItems.revenue).toBe(100);
    // PDF path attaches the uploaded file, not raw text
    const content = calls[0].messages[0].content;
    expect(content.some((b: any) => b.type === 'document' && b.source?.file_id === 'file_test123')).toBe(true);
    expect(calls[0].extraBetas).toContain('files-api-2025-04-14');
  });

  it('runs exactly one repair pass when the validator fails, keeping the better result', async () => {
    responses = [isJson(100, 40, 90), isJson(100, 40, 60)]; // bad GP then fixed
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out!.repairUsed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[0].content.some((b: any) => typeof b.text === 'string' && b.text.includes('deterministic validator'))).toBe(true);
    expect(out!.classification.statements[0].periods[0].lineItems.gross_profit).toBe(60);
  });

  it('keeps the original when repair is worse, and never runs a second repair', async () => {
    responses = [isJson(100, 40, 90), isJson(100, 400, 90)]; // repair is worse
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(calls).toHaveLength(2); // exactly one repair, no loop
    expect(out!.classification.statements[0].periods[0].lineItems.cogs).toBe(40); // original kept
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/claude-engine.test.ts
```

Expected: FAIL — cannot find module `../src/services/extraction/claudeEngine.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/extraction/claudeEngine.ts`:

```typescript
/**
 * Claude structured-output extraction engine (Phase 1, spec 2026-07-11).
 *
 * One extraction call per document (native PDF via Files API, or Excel text),
 * strict JSON schema output, deterministic normalization, then AT MOST ONE
 * repair call driven by the existing validateStatements() checks. Replaces
 * the legacy 4-layer fallback + verify/cross-verify/self-correct scaffold
 * when EXTRACTION_ENGINE=claude.
 */

import { toFile } from '@anthropic-ai/sdk';
import { log } from '../../utils/logger.js';
import { validateStatements } from '../financialValidator.js';
import type { ClassificationResult } from '../financialClassifier.js';
import { extractTextFromExcel } from '../excelFinancialExtractor.js';
import { trackedClaudeMessage, getAnthropicClient, AIRefusalError } from '../ai/client.js';
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_USER_INSTRUCTION,
  buildRepairInstruction,
  extractionResponseZod,
} from './extractionSchema.js';
import { toClassificationResult } from './normalize.js';

const FILES_BETA = 'files-api-2025-04-14';

export interface ClaudeEngineInput {
  fileBuffer: Buffer;
  fileName: string;
  fileType: 'pdf' | 'excel' | 'image';
}

export interface ClaudeEngineResult {
  classification: ClassificationResult;
  /** Placeholder text for cache/UI parity — native PDF path has no text layer dump. */
  rawText: string;
  repairUsed: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

type ContentBlock = Record<string, unknown>;

function parseAndNormalize(text: string): ClassificationResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.error('claudeEngine: response was not valid JSON');
    return null;
  }
  const checked = extractionResponseZod.safeParse(parsed);
  if (!checked.success) {
    log.error('claudeEngine: response failed schema validation', {
      issues: checked.error.issues.slice(0, 5),
    });
    return null;
  }
  return toClassificationResult(checked.data);
}

function failureSummaries(classification: ClassificationResult): string[] {
  const validation = validateStatements(classification.statements);
  return validation.checks
    .filter((c) => !c.passed && c.severity === 'error')
    .map((c) => `${c.check}${c.period ? ` [${c.period}]` : ''}: ${c.message}`);
}

export async function extractWithClaude(input: ClaudeEngineInput): Promise<ClaudeEngineResult | null> {
  const { fileBuffer, fileName, fileType } = input;
  const usage = { inputTokens: 0, outputTokens: 0 };

  // ── Build the document content block ─────────────────────────────
  let documentBlocks: ContentBlock[];
  let rawText: string;

  if (fileType === 'excel') {
    const excelText = extractTextFromExcel(fileBuffer);
    if (!excelText || excelText.trim().length < 50) {
      log.warn('claudeEngine: excel file has no readable data', { fileName });
      return null;
    }
    rawText = excelText;
    documentBlocks = [{ type: 'text', text: `Document (${fileName}, converted from Excel):\n\n${excelText}` }];
  } else {
    // PDF (and image-PDF) path: upload once, reference by file_id.
    const client = getAnthropicClient();
    const uploaded = await client.beta.files.upload({
      file: await toFile(fileBuffer, fileName, { type: 'application/pdf' }),
      betas: [FILES_BETA],
    } as never);
    rawText = `[claude-native-pdf] ${fileName} — extracted via structured output; no text-layer dump`;
    documentBlocks = [
      { type: 'document', source: { type: 'file', file_id: (uploaded as { id: string }).id } },
    ];
  }

  const callEngine = async (extraInstruction?: string): Promise<ClassificationResult | null> => {
    try {
      const res = await trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        system: EXTRACTION_SYSTEM_PROMPT,
        extraBetas: fileType === 'excel' ? [] : [FILES_BETA],
        messages: [
          {
            role: 'user',
            content: [
              ...documentBlocks,
              { type: 'text', text: extraInstruction ?? EXTRACTION_USER_INSTRUCTION },
            ],
          },
        ],
        outputSchema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
      });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      return parseAndNormalize(res.text);
    } catch (err) {
      if (err instanceof AIRefusalError) {
        // Survived the server-side fallback chain — content outcome, not a bug.
        log.warn('claudeEngine: extraction refused by safety classifiers', {
          fileName,
          category: err.category,
        });
        return null;
      }
      throw err;
    }
  };

  // ── Pass 1: extraction ────────────────────────────────────────────
  const first = await callEngine();
  if (!first || first.statements.length === 0) {
    return first ? { classification: first, rawText, repairUsed: false, usage } : null;
  }

  // ── Pass 2 (max one): repair only if deterministic checks fail ────
  const firstFailures = failureSummaries(first);
  if (firstFailures.length === 0) {
    return { classification: first, rawText, repairUsed: false, usage };
  }

  log.info('claudeEngine: validator failures — running single repair pass', {
    fileName,
    failures: firstFailures.length,
  });
  const previousJson = JSON.stringify(first.statements);
  const repaired = await callEngine(buildRepairInstruction(firstFailures, previousJson));

  if (repaired && repaired.statements.length > 0) {
    const repairedFailures = failureSummaries(repaired);
    if (repairedFailures.length < firstFailures.length) {
      repaired.warnings.push(
        `Repair pass fixed ${firstFailures.length - repairedFailures.length}/${firstFailures.length} validation errors`,
      );
      return { classification: repaired, rawText, repairUsed: true, usage };
    }
  }

  first.warnings.push('Repair pass did not improve validation — original extraction kept');
  return { classification: first, rawText, repairUsed: true, usage };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/claude-engine.test.ts
```

Expected: 3 passed. (The repair-path tests rely on `validateStatements` flagging `revenue − cogs ≠ gross_profit` as an error-severity check; if the third test fails because the worse repair still has fewer *error* checks, adjust the fixture's bad values, not the engine.)

- [ ] **Step 5: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/extraction/claudeEngine.ts apps/api/tests/claude-engine.test.ts
git commit -m "feat(extraction): claude structured-output engine with single repair pass"
```

---

### Task 7: Wire the engine flag into the agent

**Files:**
- Modify: `apps/api/src/services/agents/financialAgent/state.ts` (ExtractionSource union, ~line 21)
- Modify: `apps/api/src/services/agents/financialAgent/nodes/extractNode.ts` (engine branch at top of the `try`, after the cache block)
- Modify: `apps/api/src/services/agents/financialAgent/nodes/verifyNode.ts` (skip guard, first statement of the exported function body)
- Modify: `apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts` (same skip guard)
- Modify: `apps/api/src/services/agents/financialAgent/graph.ts` (routing guard + export for test)
- Test: `apps/api/tests/extract-node-engine-flag.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/extract-node-engine-flag.test.ts`:

```typescript
/**
 * EXTRACTION_ENGINE flag wiring tests: extractNode routes to the claude
 * engine when flagged; graph routing never sends claude output to the GPT
 * self-correct loop; verify/cross-verify skip for claude.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const engineCalls: any[] = [];
vi.mock('../src/services/extraction/claudeEngine.js', () => ({
  extractWithClaude: vi.fn(async (input: any) => {
    engineCalls.push(input);
    return {
      classification: {
        statements: [
          {
            statementType: 'INCOME_STATEMENT',
            unitScale: 'MILLIONS',
            currency: 'USD',
            periods: [{ period: '2023', periodType: 'HISTORICAL', confidence: 91, lineItems: { revenue: 100 } }],
          },
        ],
        overallConfidence: 91,
        warnings: [],
      },
      rawText: '[claude-native-pdf] test.pdf',
      repairUsed: false,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }),
}));

// The cache hits Supabase — stub it out so the unit test stays offline.
vi.mock('../src/services/agents/financialAgent/extractionCache.js', () => ({
  hashContent: vi.fn(() => 'hash'),
  getCachedExtraction: vi.fn(async () => null),
  putCachedExtraction: vi.fn(async () => undefined),
}));

const savedEngine = process.env.EXTRACTION_ENGINE;
beforeEach(() => { engineCalls.length = 0; });
afterEach(() => {
  if (savedEngine === undefined) delete process.env.EXTRACTION_ENGINE;
  else process.env.EXTRACTION_ENGINE = savedEngine;
});

describe('extractNode engine flag', () => {
  it('EXTRACTION_ENGINE=claude routes to the claude engine and tags extractionSource', async () => {
    process.env.EXTRACTION_ENGINE = 'claude';
    const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
    const result = await extractNode({
      fileBuffer: Buffer.from('%PDF-fake'),
      fileName: 'test.pdf',
      fileType: 'pdf',
      forceExtraction: true,
    } as any);
    expect(engineCalls).toHaveLength(1);
    expect(result.extractionSource).toBe('claude');
    expect(result.status).toBe('validating');
    expect(result.statements).toHaveLength(1);
  });
});

describe('claude-source graph guards', () => {
  it('routeAfterValidate never self-corrects claude output', async () => {
    const { routeAfterValidate } = await import('../src/services/agents/financialAgent/graph.js');
    expect(routeAfterValidate({ status: 'self_correcting', extractionSource: 'claude' } as any)).toBe('store');
    expect(routeAfterValidate({ status: 'self_correcting', extractionSource: 'gpt4o' } as any)).toBe('self_correct');
  });

  it('verifyNode and crossVerifyNode skip claude extractions', async () => {
    const { verifyNode } = await import('../src/services/agents/financialAgent/nodes/verifyNode.js');
    const { crossVerifyNode } = await import('../src/services/agents/financialAgent/nodes/crossVerifyNode.js');
    const state = { extractionSource: 'claude', statements: [], rawText: 'x' } as any;
    const v = await verifyNode(state);
    const cv = await crossVerifyNode(state);
    expect(v.steps?.[0]?.message).toContain('Skipped');
    expect(cv.steps?.[0]?.message).toContain('Skipped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/extract-node-engine-flag.test.ts
```

Expected: FAIL — `routeAfterValidate` is not exported; extractNode ignores the flag; nodes don't skip.

- [ ] **Step 3: Modify `state.ts`** — change the `ExtractionSource` line (~line 21):

```typescript
export type ExtractionSource = 'gpt4o' | 'azure' | 'vision' | 'manual' | 'claude';
```

- [ ] **Step 4: Modify `extractNode.ts`** — insert this block as the FIRST statement inside the existing `try {` (immediately before the `// ── Excel Path ──` comment). It reuses the `steps`, `cacheResult`, and `step()` helpers already in scope:

```typescript
    // ── Claude structured-output engine (Phase 1, EXTRACTION_ENGINE=claude) ──
    if ((process.env.EXTRACTION_ENGINE || 'legacy') === 'claude') {
      steps.push(step('extract', 'EXTRACTION_ENGINE=claude — using structured-output engine'));
      const { extractWithClaude } = await import('../../../extraction/claudeEngine.js');
      const engineResult = await extractWithClaude({ fileBuffer, fileName, fileType });

      if (!engineResult || engineResult.classification.statements.length === 0) {
        return {
          status: 'failed',
          error: 'Claude engine found no financial statements (or the request was declined)',
          steps: [...steps, step('extract', 'Claude engine returned no statements')],
        };
      }

      const { classification, rawText: engineRawText, repairUsed } = engineResult;
      steps.push(
        step(
          'extract',
          `Claude engine extracted ${classification.statements.length} statement type(s)` +
            (repairUsed ? ' (1 repair pass used)' : ''),
          `tokens in/out: ${engineResult.usage.inputTokens}/${engineResult.usage.outputTokens}`,
        ),
      );

      cacheResult({
        rawText: engineRawText,
        extractionSource: 'claude',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
      });

      return {
        rawText: engineRawText,
        extractionSource: 'claude',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
        status: 'validating',
        steps,
      };
    }
```

If `CachedExtractionResult`'s field list differs from the object literal above (check `extractionCache.ts`), match its exact fields — the union change in Step 3 already makes `'claude'` a legal `extractionSource`.

- [ ] **Step 5: Modify `verifyNode.ts` and `crossVerifyNode.ts`** — insert as the first statement of each exported node function body:

In `verifyNode`:
```typescript
  if (state.extractionSource === 'claude') {
    return { steps: [step('verify', 'Skipped — structured-output engine carries in-schema provenance')] };
  }
```

In `crossVerifyNode` (it uses the same `step()` helper pattern; if its helper is named differently, mirror that file's convention):
```typescript
  if (state.extractionSource === 'claude') {
    return { steps: [step('cross_verify', 'Skipped — structured-output engine carries in-schema provenance')] };
  }
```

- [ ] **Step 6: Modify `graph.ts`** — replace the existing `routeAfterValidate` with an exported, claude-aware version:

```typescript
/** After validate: route based on status set by validate node */
export function routeAfterValidate(state: FinancialAgentStateType): string {
  // Claude engine repairs inside extract (max 1 pass, spec 2026-07-11) —
  // never route claude output into the GPT self-correct loop.
  if (state.extractionSource === 'claude') return 'store';
  if (state.status === 'self_correcting') return 'self_correct';
  return 'store'; // 'storing' or anything else → store
}
```

- [ ] **Step 7: Run the new test + the full agent suites**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test -- tests/extract-node-engine-flag.test.ts tests/agent-nodes.test.ts tests/agent-bounds.test.ts tests/financial-validator.test.ts tests/financial-extraction-cache.test.ts
```

Expected: all pass — the legacy path must be byte-for-byte untouched when the flag is absent.

- [ ] **Step 8: Typecheck and commit**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npx tsc --noEmit
cd "/Users/ganesh/AI CRM"
git add apps/api/src/services/agents/financialAgent/state.ts \
        apps/api/src/services/agents/financialAgent/graph.ts \
        apps/api/src/services/agents/financialAgent/nodes/extractNode.ts \
        apps/api/src/services/agents/financialAgent/nodes/verifyNode.ts \
        apps/api/src/services/agents/financialAgent/nodes/crossVerifyNode.ts \
        apps/api/tests/extract-node-engine-flag.test.ts
git commit -m "feat(extraction): EXTRACTION_ENGINE flag routes financial agent to claude engine"
```

---

### Task 8: Bake-off harness — `scripts/extraction-bakeoff.ts`

**Files:**
- Create: `apps/api/scripts/extraction-bakeoff.ts`

No unit test (operator script, real API calls). Guard rails: refuses to run without keys; prints per-file progress; writes a markdown report.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/extraction-bakeoff.ts`:

```typescript
/**
 * Extraction bake-off harness (Phase 1 acceptance gate, spec §3.3).
 *
 * Usage:
 *   cd apps/api
 *   npx tsx scripts/extraction-bakeoff.ts <dir-with-pdfs-and-xlsx> [--models claude-fable-5,claude-opus-4-8] [--skip-legacy]
 *
 * For each document, runs:
 *   - legacy: pdf-parse/excel text → classifyFinancials (needs OPENAI_API_KEY or OPENROUTER_API_KEY)
 *   - claude engine once per model in --models (needs ANTHROPIC_API_KEY)
 * and reports: statements/periods found, deterministic validator errors,
 * duration, token usage + cost. Writes bakeoff-results-<timestamp>.md.
 *
 * Hard gate (spec): fable-5 validator pass rate ≥ legacy. Cost is reported,
 * not gated.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import 'dotenv/config';

const PRICES: Record<string, { in: number; out: number }> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

interface RunResult {
  engine: string;
  file: string;
  ok: boolean;
  statements: number;
  periods: number;
  validatorErrors: number;
  validatorWarnings: number;
  overallPassed: boolean;
  durationMs: number;
  costUsd: number | null;
  note: string;
}

function costFor(model: string, inTok: number, outTok: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: npx tsx scripts/extraction-bakeoff.ts <dir> [--models m1,m2] [--skip-legacy]');
    process.exit(1);
  }
  const modelsArg = args.find((a) => a.startsWith('--models='))?.split('=')[1];
  const models = (modelsArg ?? 'claude-fable-5,claude-opus-4-8').split(',').map((m) => m.trim());
  const skipLegacy = args.includes('--skip-legacy');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required');
    process.exit(1);
  }
  if (!skipLegacy && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error('Legacy engine needs OPENAI_API_KEY or OPENROUTER_API_KEY (or pass --skip-legacy)');
    process.exit(1);
  }

  const { validateStatements } = await import('../src/services/financialValidator.js');
  const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');

  const files = readdirSync(dir).filter((f) => ['.pdf', '.xlsx', '.xls'].includes(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`No .pdf/.xlsx files in ${dir}`);
    process.exit(1);
  }
  console.log(`Bake-off: ${files.length} document(s), engines: ${skipLegacy ? '' : 'legacy, '}${models.join(', ')}\n`);

  const results: RunResult[] = [];

  const summarize = (
    engine: string,
    file: string,
    classification: { statements: Array<{ periods: unknown[] }> } | null,
    durationMs: number,
    costUsd: number | null,
    note = '',
  ): RunResult => {
    if (!classification || classification.statements.length === 0) {
      return { engine, file, ok: false, statements: 0, periods: 0, validatorErrors: 0, validatorWarnings: 0, overallPassed: false, durationMs, costUsd, note: note || 'no statements' };
    }
    const v = validateStatements(classification.statements as never);
    return {
      engine, file, ok: true,
      statements: classification.statements.length,
      periods: classification.statements.reduce((n, s) => n + s.periods.length, 0),
      validatorErrors: v.errorCount,
      validatorWarnings: v.warningCount,
      overallPassed: v.overallPassed,
      durationMs, costUsd, note,
    };
  };

  for (const file of files) {
    const buffer = readFileSync(join(dir, file));
    const fileType: 'pdf' | 'excel' = extname(file).toLowerCase() === '.pdf' ? 'pdf' : 'excel';

    if (!skipLegacy) {
      process.stdout.write(`  [legacy] ${file} ... `);
      const t0 = Date.now();
      try {
        let text: string;
        if (fileType === 'excel') {
          const { extractTextFromExcel } = await import('../src/services/excelFinancialExtractor.js');
          text = extractTextFromExcel(buffer);
        } else {
          const { createRequire } = await import('node:module');
          const require = createRequire(import.meta.url);
          const pdfParse = require('pdf-parse');
          text = (await pdfParse(buffer)).text ?? '';
        }
        const { classifyFinancials } = await import('../src/services/financialClassifier.js');
        const classification = await classifyFinancials(text);
        results.push(summarize('legacy', file, classification, Date.now() - t0, null));
        console.log('done');
      } catch (err) {
        results.push(summarize('legacy', file, null, Date.now() - t0, null, String(err)));
        console.log('ERROR');
      }
    }

    for (const model of models) {
      process.stdout.write(`  [${model}] ${file} ... `);
      process.env.AI_EXTRACTION_MODEL = model;
      const t0 = Date.now();
      try {
        const out = await extractWithClaude({ fileBuffer: buffer, fileName: file, fileType });
        const cost = out ? costFor(model, out.usage.inputTokens, out.usage.outputTokens) : null;
        results.push(summarize(model, file, out?.classification ?? null, Date.now() - t0, cost, out?.repairUsed ? 'repair pass used' : ''));
        console.log('done');
      } catch (err) {
        results.push(summarize(model, file, null, Date.now() - t0, null, String(err)));
        console.log('ERROR');
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────
  const engines = [...new Set(results.map((r) => r.engine))];
  const lines: string[] = ['# Extraction Bake-off Results', '', `Documents: ${files.length}`, ''];
  lines.push('| Engine | OK | Stmts | Periods | Validator pass | Errors | Avg ms | Total cost |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const engine of engines) {
    const rs = results.filter((r) => r.engine === engine);
    const okCount = rs.filter((r) => r.ok).length;
    const passCount = rs.filter((r) => r.overallPassed).length;
    const totalCost = rs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const avgMs = Math.round(rs.reduce((n, r) => n + r.durationMs, 0) / rs.length);
    lines.push(
      `| ${engine} | ${okCount}/${rs.length} | ${rs.reduce((n, r) => n + r.statements, 0)} | ${rs.reduce((n, r) => n + r.periods, 0)} | ${passCount}/${rs.length} | ${rs.reduce((n, r) => n + r.validatorErrors, 0)} | ${avgMs} | ${engine === 'legacy' ? 'n/a (not metered here)' : `$${totalCost.toFixed(3)}`} |`,
    );
  }
  lines.push('', '## Per-document detail', '');
  lines.push('| File | Engine | OK | Stmts | Periods | Errors | Warnings | ms | Cost | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.file} | ${r.engine} | ${r.ok ? '✓' : '✗'} | ${r.statements} | ${r.periods} | ${r.validatorErrors} | ${r.validatorWarnings} | ${r.durationMs} | ${r.costUsd === null ? '—' : `$${r.costUsd.toFixed(3)}`} | ${r.note} |`);
  }

  const outPath = `bakeoff-results-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(outPath, lines.join('\n'));
  console.log(`\n${lines.slice(4, 4 + engines.length + 2).join('\n')}\n\nFull report: apps/api/${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-check argument handling (no API calls)**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npx tsx scripts/extraction-bakeoff.ts
```

Expected: exits 1 with the usage line.

- [ ] **Step 3: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/scripts/extraction-bakeoff.ts
git commit -m "feat(extraction): bake-off harness comparing legacy vs claude engines"
```

---

### Task 9: Full suite, env documentation, and rollout checklist

**Files:**
- Modify: `apps/api/.env.example` (if the file exists)
- Modify: `progress.md` (session changelog entry, IST timestamp — repo convention)

- [ ] **Step 1: Run the entire API test suite**

```bash
cd "/Users/ganesh/AI CRM/apps/api" && npm test
```

Expected: everything green (same pass/fail set as before this plan, plus the 4 new test files passing; the 11 known pre-existing failures triaged in commit 8e45b44 are unrelated).

- [ ] **Step 2: Document the new env vars**

```bash
cd "/Users/ganesh/AI CRM/apps/api"
test -f .env.example && cat >> .env.example <<'EOF'

# ── Phase 1: Claude extraction engine (spec 2026-07-11) ──
# Engine flag: legacy (default) | claude
EXTRACTION_ENGINE=legacy
# Role model overrides (defaults: fable-5 / sonnet-5 / haiku-4.5)
# AI_EXTRACTION_MODEL=claude-opus-4-8
# AI_CHAT_MODEL=claude-sonnet-5
# AI_FAST_MODEL=claude-haiku-4-5
EOF
test -f .env.example && tail -12 .env.example || echo "(no .env.example — skip)"
```

- [ ] **Step 3: Append a progress.md changelog entry** (IST timestamp, problem/root-cause/fix format per repo convention) summarizing: Phase 1 engine built behind flag, migration SQL pending manual run, bake-off harness ready.

- [ ] **Step 4: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/.env.example progress.md
git commit -m "docs(phase1): env vars + progress entry for claude extraction engine"
```

- [ ] **Step 5: Rollout checklist (operator actions — record outcomes in progress.md)**

1. Run `apps/api/phase1-claude-extraction-migration.sql` in Supabase (Task 1 note). Verify: `SELECT model FROM "ModelPrice" WHERE provider='anthropic';` returns 4 rows.
2. Confirm Anthropic org retention ≥ 30 days (Console → data retention) — Fable 5 hard-fails otherwise.
3. Collect 5–10 representative real CIMs/financial PDFs + 2–3 Excel packages into a local folder (NOT committed).
4. Run the bake-off: `npx tsx scripts/extraction-bakeoff.ts <folder>`. Gate: `claude-fable-5` validator pass ≥ legacy. Compare fable-5 vs opus-4-8 cost/accuracy for the model decision.
5. If gate passes: set `EXTRACTION_ENGINE=claude` in Vercel env (and `ANTHROPIC_API_KEY` if not already in prod), deploy, and monitor `/internal/usage` for `financial_extraction` events with provider `anthropic`.
6. Two-week soak (spec decision 2026-07-11), then a follow-up cleanup plan deletes: `azureDocIntelligence.ts`, `llamaParse.ts`, `visionExtractor.ts`, `pdfExtractor.ts`, legacy branches of `extractNode.ts`, `verifyNode.ts`, `crossVerifyNode.ts`, `selfCorrectNode.ts`, and deps `@azure/ai-form-recognizer`, `@llamaindex/cloud`. The ~40 non-extraction call sites (`openai.ts`/`llm.ts` consumers) get their own migration plan.

---

## Self-review notes (spec coverage)

- Spec §3.1 client/tracked/models → Tasks 2–3. §3.2 extraction/normalization/repair/Excel/validator → Tasks 4–6. §3.3 flag + bake-off + deletion gate → Tasks 7–9. §3.4 call-site migration → explicitly deferred to a follow-up plan (scope check). DB prerequisites (extractionSource CHECK, ModelPrice rows) → Task 1. Fable 5 conditions (no thinking param, fallbacks beta, refusal handling, retention check) → Tasks 2, 3, 9.
- Known judgment calls encoded above: repair lives inside the engine (keeps `selfCorrectNode` untouched); `routeAfterValidate` guard is in `graph.ts` (fully read, safe to edit); provenance uses the legacy `_source` string convention so the existing UI renders it unchanged.
