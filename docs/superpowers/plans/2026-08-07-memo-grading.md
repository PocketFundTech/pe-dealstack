# Phase 2-C: Rubric-Graded Memos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate memo section generation off the legacy `llm.ts`/OpenAI stack onto `trackedClaudeMessage()` (Phase 1's Anthropic client), and add a self-critique + targeted-revise pass that grades the assembled memo against a fixed IC-memo rubric before returning it.

**Architecture:** `memoAgent/pipeline.ts`'s `generateSection()` swaps its LLM call from `getChatModel().invoke()` to `trackedClaudeMessage()` — same behavior, new engine. A new `critiqueAndRevise()` function runs once at the end of `generateAllSections()`: one structured-output call grades the whole assembled memo against four rubric dimensions, and if it flags any section, one more structured-output call revises just those sections. Both new calls are best-effort — any failure (timeout, malformed output, LLM unavailable) returns the original ungraded sections, never blocks memo creation.

**Tech Stack:** `trackedClaudeMessage()` (`services/ai/client.ts`), hand-written JSON schemas for structured output (`outputSchema`), Vitest.

---

### Task 1: `trackedClaudeMessage` — optional `signal`, and an Anthropic availability check

**Files:**
- Modify: `apps/api/src/services/ai/client.ts`
- Test: `apps/api/tests/ai-client.test.ts`

**Why:** The critique/revise calls need the same bounded-timeout `AbortController` + `Promise.race` pattern used everywhere else in this codebase (`generateSection`'s per-section timeout, `dealChatAgent`'s recursion/timeout bounds) — but `ClaudeCallOptions` has no `signal` field today, so a timeout can only race client-side without actually cancelling the in-flight HTTP request. Also, migrating `generateAllSections`'s availability gate off `isLLMAvailable()` (which checks `OPENAI_API_KEY`/Gemini — the wrong provider once this pipeline is on Anthropic) needs a real Anthropic-aware check; none exists yet (`getAnthropicClient()` throws rather than returning a boolean).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/tests/ai-client.test.ts`, inside the existing `describe('trackedClaudeMessage', ...)` block (after the last `it(...)`, before the closing `});`):

```ts
  it('forwards an AbortSignal to the stream request when provided', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    const controller = new AbortController();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: controller.signal,
    });
    expect(streamCalls[0].signal).toBe(controller.signal);
  });

  it('omits signal from the request when not provided', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect('signal' in streamCalls[0]).toBe(false);
  });
```

Add a new top-level `describe` block after the closing `});` of `describe('trackedClaudeMessage', ...)`, at the end of the file:

```ts

describe('isAnthropicAvailable', () => {
  it('is true when ANTHROPIC_API_KEY is set and false when it is not', async () => {
    const { isAnthropicAvailable } = await getClient();
    expect(isAnthropicAvailable()).toBe(true); // set in beforeEach
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAnthropicAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/ai-client.test.ts`
Expected: FAIL — `signal` assertions fail (field doesn't exist on the request yet), and `isAnthropicAvailable` fails with "is not a function" (not exported yet).

- [ ] **Step 3: Implement**

In `apps/api/src/services/ai/client.ts`, add `signal` to the `ClaudeCallOptions` interface:

```ts
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
  signal?: AbortSignal;
}
```

Wire it into the request, right after the existing `outputSchema` block:

```ts
  if (opts.system) request.system = opts.system;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.outputSchema) {
    request.output_config = { format: { type: 'json_schema', schema: opts.outputSchema } };
  }
  if (opts.signal) request.signal = opts.signal;
```

Add the availability check right after `getAnthropicClient`/`_resetAnthropicClient`:

```ts
/** True when ANTHROPIC_API_KEY is configured — cheap check, no client construction. */
export function isAnthropicAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/ai-client.test.ts`
Expected: PASS (all tests, including the 3 pre-existing `trackedClaudeMessage` ones)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ai/client.ts apps/api/tests/ai-client.test.ts
git commit -m "feat(memo): trackedClaudeMessage gets optional signal + isAnthropicAvailable check"
```

---

### Task 2: `memo` AI role

**Files:**
- Modify: `apps/api/src/services/ai/models.ts`
- Test: `apps/api/tests/ai-models.test.ts`

**Why:** Memo generation needs its own model-tiering slot, independent of `chat` (which deal chat, now live via PR #92, depends on) — same reasoning as why `extraction`, `chat`, and `fast` are already separate roles.

- [ ] **Step 1: Write the failing tests**

In `apps/api/tests/ai-models.test.ts`, change the `ENV_KEYS` line to include the new env var:

```ts
const ENV_KEYS = ['AI_EXTRACTION_MODEL', 'AI_CHAT_MODEL', 'AI_FAST_MODEL', 'AI_MEMO_MODEL'] as const;
```

Add two new tests inside `describe('getModelConfig', ...)`, after the existing `'keys fable plumbing off the resolved model, not the role'` test, before the closing `});`:

```ts

  it('defaults memo to sonnet 5 with 4000 max tokens and no fallback plumbing', async () => {
    const { getModelConfig } = await getModels();
    const cfg = getModelConfig('memo');
    expect(cfg.model).toBe('claude-sonnet-5');
    expect(cfg.maxTokens).toBe(4000);
    expect(cfg.fallbacks).toBeUndefined();
    expect(cfg.betas).toEqual([]);
  });

  it('honors the memo env override', async () => {
    process.env.AI_MEMO_MODEL = 'claude-opus-4-8';
    const { getModelConfig } = await getModels();
    expect(getModelConfig('memo').model).toBe('claude-opus-4-8');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/ai-models.test.ts`
Expected: FAIL — `getModelConfig('memo')` throws or returns `undefined` fields since `'memo'` isn't a valid `AiRole` yet (TypeScript would also fail to compile the test file, which vitest surfaces as a test failure via esbuild transform error).

- [ ] **Step 3: Implement**

In `apps/api/src/services/ai/models.ts`, update the role type and its three lookup maps:

```ts
export type AiRole = 'extraction' | 'chat' | 'fast' | 'memo';
```

```ts
const DEFAULTS: Record<AiRole, string> = {
  extraction: 'claude-fable-5',
  chat: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5',
  memo: 'claude-sonnet-5',
};

const ENV_OVERRIDES: Record<AiRole, string> = {
  extraction: 'AI_EXTRACTION_MODEL',
  chat: 'AI_CHAT_MODEL',
  fast: 'AI_FAST_MODEL',
  memo: 'AI_MEMO_MODEL',
};

const MAX_TOKENS: Record<AiRole, number> = {
  extraction: 64000, // large multi-period JSON output
  chat: 16000,
  fast: 4096,
  memo: 4000,
};
```

Also update the file's top-of-file doc comment to list the new role (small, but keeps the "single source of truth" comment accurate):

```ts
/**
 * AI role → Anthropic model map (Phase 1 AI core swap).
 * Single source of truth replacing utils/aiModels.ts tiers for new call sites.
 *
 * Roles (spec 2026-07-11, memo added 2026-08-07):
 *   extraction → claude-fable-5 (founder decision; env-downgradable)
 *   chat       → claude-sonnet-5
 *   fast       → claude-haiku-4-5
 *   memo       → claude-sonnet-5 (section generation + rubric critique/revise)
 *
 * Fable 5 request shaping handled here so call sites never branch:
 *   - never send a `thinking` param (explicit disable 400s on Fable 5)
 *   - server-side refusal fallback to claude-opus-4-8
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/ai-models.test.ts`
Expected: PASS (all tests, including the 6 pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ai/models.ts apps/api/tests/ai-models.test.ts
git commit -m "feat(memo): add memo AI role (claude-sonnet-5, AI_MEMO_MODEL override)"
```

---

### Task 3: Migrate `generateSection` to `trackedClaudeMessage`

**Files:**
- Modify: `apps/api/src/services/agents/memoAgent/pipeline.ts`
- Create: `apps/api/tests/memo-pipeline-generation.test.ts`

**Why:** Mechanical engine swap — same batching, retry, placeholder, and HTML/JSON post-processing behavior, just calling `trackedClaudeMessage()` instead of `getChatModel().invoke()`. `generateSection`/`generateAllSections` have zero existing test coverage (confirmed: no test file imports them directly; the 4 route-level tests that reference `memoAgent` all mock `memoAgent/index.js` wholesale) — this task adds real coverage as part of the migration.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/memo-pipeline-generation.test.ts`:

```ts
/**
 * memoAgent/pipeline.ts — generateSection/generateAllSections tests
 * (Phase 2-C: migrated to trackedClaudeMessage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';

const trackedClaudeMessage = vi.fn();
let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => anthropicAvailable,
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

function baseContext(overrides: Partial<MemoContext> = {}): MemoContext {
  return {
    deal: {
      id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null,
      industry: 'Software', revenue: 10, ebitda: 2, dealSize: 50,
      irrProjected: null, mom: null, aiThesis: null, description: null, source: null,
    },
    company: null,
    financials: [
      { statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 }, extractionConfidence: 90, extractionSource: 'ai', isActive: true },
    ],
    documents: [],
    activity: [],
    team: { leadPartner: null, analyst: null, members: [] },
    dataAvailability: { hasFinancials: true, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
    ...overrides,
  };
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
  anthropicAvailable = true;
  delete process.env.MEMO_SECTION_TIMEOUT_MS;
});

describe('generateSection', () => {
  it('calls trackedClaudeMessage with role memo and returns the served model as aiModel', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '<h3>Overview</h3><p>Strong company.</p>',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 100 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext(), undefined, 1);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.role).toBe('memo');
    expect(call.maxTokens).toBe(2000);
    expect(call.messages).toEqual([{ role: 'user', content: expect.stringContaining('Executive Summary') }]);

    expect(section.aiGenerated).toBe(true);
    expect(section.aiModel).toBe('claude-sonnet-5');
    expect(section.content).toContain('<h3>Overview</h3>');
  });

  it('returns a placeholder without calling the LLM when financials are required but missing', async () => {
    const { generateSection } = await getPipeline();
    const section = await generateSection(
      'FINANCIAL_PERFORMANCE',
      baseContext({ financials: [], dataAvailability: { hasFinancials: false, hasDocuments: false, hasDetailedDocs: false, hasCIM: false } }),
    );
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
    expect(section.aiGenerated).toBe(false);
    expect(section.aiModel).toBe('placeholder');
  });

  it('parses tableData out of a JSON response for table-bearing sections', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '```json\n{"content":"<p>See table.</p>","tableData":{"rows":[["Revenue","10"]]}}\n```',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 100 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('FINANCIAL_PERFORMANCE', baseContext());
    expect(section.content).toContain('See table');
    expect(section.tableData).toEqual({ rows: [['Revenue', '10']] });
  });

  it('retries once on a 429 and succeeds on the second attempt', async () => {
    trackedClaudeMessage
      .mockRejectedValueOnce(new Error('429 Rate limit exceeded'))
      .mockResolvedValueOnce({
        text: '<h3>Overview</h3><p>ok</p>',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 500, outputTokens: 100 },
      });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(trackedClaudeMessage).toHaveBeenCalledTimes(2);
    expect(section.aiGenerated).toBe(true);
  });

  it('returns an error placeholder (not a throw) when the LLM call fails after retries', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('Service unavailable'));
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(section.aiGenerated).toBe(false);
    expect(section.aiModel).toBe('error');
    expect(captureAgentError).toHaveBeenCalled();
  });
});

describe('generateAllSections', () => {
  it('throws when Anthropic is unavailable, without calling trackedClaudeMessage', async () => {
    anthropicAvailable = false;
    const { generateAllSections } = await getPipeline();
    await expect(generateAllSections('deal-1', 'org-1')).rejects.toThrow('LLM is not available');
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-generation.test.ts`
Expected: FAIL — `pipeline.ts` still imports `getChatModel` from `llm.js`, so `trackedClaudeMessage` is never called; the "Anthropic unavailable" test fails since `generateAllSections` still checks `isLLMAvailable()` (mocked away from a module the test doesn't touch).

- [ ] **Step 3: Implement**

In `apps/api/src/services/agents/memoAgent/pipeline.ts`, replace the import block:

```ts
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildMemoContext, formatContextForLLM, MemoContext } from './context.js';
import {
  MEMO_SYSTEM_PROMPT,
  SECTION_PROMPTS,
  SectionType,
  COMPREHENSIVE_IC_SECTIONS,
} from './prompts.js';
import { getChatModel, isLLMAvailable } from '../../llm.js';
import { MODEL_REASONING } from '../../../utils/aiModels.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { resolveTimeoutMs } from '../agentBounds.js';
```

with:

```ts
import { buildMemoContext, formatContextForLLM, MemoContext } from './context.js';
import {
  MEMO_SYSTEM_PROMPT,
  SECTION_PROMPTS,
  SectionType,
  COMPREHENSIVE_IC_SECTIONS,
} from './prompts.js';
import { trackedClaudeMessage, isAnthropicAvailable } from '../../ai/client.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { resolveTimeoutMs } from '../agentBounds.js';
```

(`HumanMessage`/`SystemMessage` and `MODEL_REASONING` become unused once the call site below changes — dropped. `getChatModel`/`isLLMAvailable` from `llm.js` are replaced by the Anthropic equivalents.)

Replace the body of `generateSection` from `try {` through the matching `} catch (err: any) {` with:

```ts
  try {
    const sectionPrompt = customPrompt ?? promptConfig.prompt;
    const contextText = formatContextForLLM(context);

    const formatInstruction =
      includeTableData || includeChartConfig
        ? '\n\nReturn your response as valid JSON matching the structure described in the prompt above.'
        : '\n\nReturn your response as clean HTML only (no markdown, no code fences).';

    const userPrompt = `${sectionPrompt}\n\n---\n\n## Deal Context\n\n${contextText}${formatInstruction}`;

    // Bound the LLM call — AbortSignal is now forwarded all the way to the
    // in-flight Anthropic request (Task 1), not just raced client-side.
    const timeoutMs = resolveTimeoutMs(SECTION_TIMEOUT_MS, 'MEMO_SECTION_TIMEOUT_MS');
    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Memo section ${sectionType} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let result: { text: string; model: string };
    try {
      result = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_section_generation',
          role: 'memo',
          system: MEMO_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 2000,
          signal: abortController.signal,
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const rawText = result.text;

    let content = rawText;
    let tableData: any = undefined;
    let chartConfig: any = undefined;

    if (includeTableData || includeChartConfig) {
      // Strip markdown code fences if present
      const stripped = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      try {
        const parsed = JSON.parse(stripped);
        content = parsed.content ?? rawText;
        if (parsed.tableData !== undefined) tableData = parsed.tableData;
        if (parsed.chartConfig !== undefined) chartConfig = parsed.chartConfig;
      } catch (err) {
        // JSON parse failed — use raw text as content
        log.warn(`[memoAgent/pipeline] JSON parse failed for section ${sectionType}, using raw text`, { error: err instanceof Error ? err.message : String(err) });
        content = rawText;
      }
    }

    return {
      type: sectionType,
      title,
      content: ensureHtmlFormatting(content),
      ...(tableData !== undefined ? { tableData } : {}),
      ...(chartConfig !== undefined ? { chartConfig } : {}),
      aiGenerated: true,
      aiModel: result.model,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    };
  } catch (err: any) {
```

(The `catch` block body itself — the 429-retry branch, `log.error`, `captureAgentError`, and the final `makePlaceholder(...)` call — is unchanged; only the code that precedes it, above, changes.)

In `generateAllSections`, change the gate:

```ts
  if (!isLLMAvailable()) {
    throw new Error('LLM is not available. Check API key configuration.');
  }
```

to:

```ts
  if (!isAnthropicAvailable()) {
    throw new Error('LLM is not available. Check API key configuration.');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-generation.test.ts`
Expected: PASS (all 6 tests)

Then run the full suite to confirm nothing else broke:

Run: `cd apps/api && npx vitest run`
Expected: same pre-existing baseline (795 passed, 44 skipped, 8 failed — all 8 the known `mfa-bypass.test.ts`), no new failures.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/agents/memoAgent/pipeline.ts apps/api/tests/memo-pipeline-generation.test.ts
git commit -m "feat(memo): migrate generateSection to trackedClaudeMessage (memo role)"
```

---

### Task 4: `critiqueAndRevise` — rubric grading + targeted revision

**Files:**
- Modify: `apps/api/src/services/agents/memoAgent/pipeline.ts`
- Create: `apps/api/tests/memo-pipeline-critique.test.ts`

**Why:** The actual "rubric-graded" behavior — a critique pass over the whole assembled memo, and a targeted revise pass only when it's needed. Best-effort: any failure returns the original sections, matching the financial-extraction verify node's non-blocking precedent.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/memo-pipeline-critique.test.ts`:

```ts
/**
 * memoAgent/pipeline.ts — critiqueAndRevise tests (Phase 2-C).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';
import type { GeneratedSection } from '../src/services/agents/memoAgent/pipeline.js';

const trackedClaudeMessage = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => true,
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

const context: MemoContext = {
  deal: {
    id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null,
    industry: 'Software', revenue: 10, ebitda: 2, dealSize: 50,
    irrProjected: null, mom: null, aiThesis: null, description: null, source: null,
  },
  company: null,
  financials: [],
  documents: [],
  activity: [],
  team: { leadPartner: null, analyst: null, members: [] },
  dataAvailability: { hasFinancials: false, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
};

function sections(): GeneratedSection[] {
  return [
    { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: '<p>Weak thesis.</p>', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 1 },
    { type: 'RISK_ASSESSMENT', title: 'Risk Assessment', content: '<p>Generic risks.</p>', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 2 },
  ];
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
});

describe('critiqueAndRevise', () => {
  it('returns sections unchanged when the critique passes', async () => {
    trackedClaudeMessage.mockResolvedValueOnce({
      text: JSON.stringify({
        overallPass: true,
        dimensions: [
          { name: 'thesis_clarity', score: 4, pass: true },
          { name: 'financial_grounding', score: 4, pass: true },
          { name: 'risk_coverage', score: 4, pass: true },
          { name: 'actionability', score: 4, pass: true },
        ],
        sectionsNeedingRevision: [],
      }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 800, outputTokens: 100 },
    });
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1); // critique only, no revise call
    expect(result).toEqual(original);
  });

  it('revises only the flagged sections when the critique fails', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [
            { name: 'thesis_clarity', score: 2, pass: false, issue: 'No clear recommendation' },
            { name: 'financial_grounding', score: 4, pass: true },
            { name: 'risk_coverage', score: 4, pass: true },
            { name: 'actionability', score: 4, pass: true },
          ],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 800, outputTokens: 120 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          revisedSections: [
            { type: 'EXECUTIVE_SUMMARY', content: '<h3>Recommendation</h3><p>BUY — strong thesis.</p>' },
          ],
        }),
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 600, outputTokens: 80 },
      });
    const { critiqueAndRevise } = await getPipeline();
    const result = await critiqueAndRevise(sections(), context);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(2);
    expect(result.find((s) => s.type === 'EXECUTIVE_SUMMARY')?.content).toContain('BUY');
    // Untouched section stays byte-identical
    expect(result.find((s) => s.type === 'RISK_ASSESSMENT')?.content).toBe('<p>Generic risks.</p>');
  });

  it('silently skips a revised section type that does not match any real section', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          revisedSections: [{ type: 'NOT_A_REAL_SECTION', content: '<p>hallucinated</p>' }],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      });
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original); // nothing matched, nothing changed, no throw
  });

  it('returns original sections unchanged when the critique call fails', async () => {
    trackedClaudeMessage.mockRejectedValueOnce(new Error('timeout'));
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original);
    expect(captureAgentError).toHaveBeenCalled();
  });

  it('returns original sections unchanged when the revise call fails', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockRejectedValueOnce(new Error('timeout'));
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original);
    expect(captureAgentError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-critique.test.ts`
Expected: FAIL — `critiqueAndRevise` isn't exported from `pipeline.ts` yet ("does not provide an export named 'critiqueAndRevise'").

- [ ] **Step 3: Implement**

Append to the end of `apps/api/src/services/agents/memoAgent/pipeline.ts` (after `generateAllSections`'s closing `}`):

```ts

// ─── Critique + Revise (Phase 2-C) ─────────────────────────────────────────
// One critique pass over the assembled memo, one targeted revise pass if it
// flags anything. Best-effort — any failure returns the original sections
// unchanged; a memo is never blocked by a grading failure (same non-blocking
// precedent as financialAgent/nodes/verifyNode.ts).

const CRITIQUE_TIMEOUT_MS = 30_000;
const REVISE_TIMEOUT_MS = 30_000;

const CRITIQUE_SYSTEM_PROMPT = `You are grading an Investment Committee memo against a fixed rubric before it reaches an analyst. Score honestly — a 3/5 pass bar is deliberately lenient; only fail a dimension for a real, specific problem.

Score each dimension 1-5 and mark it "pass" at 3 or above:
- thesis_clarity: does the memo state a clear, consistent investment thesis and recommendation, and do the sections support it rather than contradict it?
- financial_grounding: do cited numbers match across sections and against the verified deal data provided below? Are they plausible, not fabricated?
- risk_coverage: are the risks raised substantive and specific to this deal, not generic boilerplate?
- actionability: is the recommendation clear enough for an IC to act on (BUY/PASS/CONDITIONAL plus rationale), not vague hedging?

For any dimension that fails, name the specific section type(s) that need revision in sectionsNeedingRevision, using the exact section type strings shown in the memo (e.g. "EXECUTIVE_SUMMARY"). If every dimension passes, sectionsNeedingRevision must be empty and overallPass must be true.`;

const REVISE_SYSTEM_PROMPT = `You are revising specific sections of an Investment Committee memo to fix problems a grading pass identified. Keep the same HTML formatting conventions as the rest of the memo (h3 sub-headings, p tags, strong for key metrics). Only return the sections listed as needing revision, using their exact section type string — do not invent new sections or touch ones that weren't flagged. Fix the specific issue described for each section; don't rewrite unrelated content.`;

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    overallPass: { type: 'boolean' },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['thesis_clarity', 'financial_grounding', 'risk_coverage', 'actionability'] },
          score: { type: 'integer', minimum: 1, maximum: 5 },
          pass: { type: 'boolean' },
          issue: { type: 'string' },
        },
        required: ['name', 'score', 'pass'],
      },
    },
    sectionsNeedingRevision: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['overallPass', 'dimensions', 'sectionsNeedingRevision'],
};

const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    revisedSections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['type', 'content'],
      },
    },
  },
  required: ['revisedSections'],
};

interface CritiqueVerdict {
  overallPass: boolean;
  dimensions: Array<{ name: string; score: number; pass: boolean; issue?: string }>;
  sectionsNeedingRevision: string[];
}

interface ReviseResult {
  revisedSections: Array<{ type: string; content: string }>;
}

/**
 * Grade the assembled memo against a fixed rubric; revise only the flagged
 * sections if it fails. Best-effort — see module comment above.
 */
export async function critiqueAndRevise(
  sections: GeneratedSection[],
  context: MemoContext,
): Promise<GeneratedSection[]> {
  try {
    const memoText = sections
      .map((s) => `### Section: ${s.type} (${s.title})\n${s.content}`)
      .join('\n\n');
    const contextText = formatContextForLLM(context);

    const critiqueTimeoutMs = resolveTimeoutMs(CRITIQUE_TIMEOUT_MS, 'MEMO_CRITIQUE_TIMEOUT_MS');
    const critiqueController = new AbortController();
    let critiqueTimeoutHandle: NodeJS.Timeout | undefined;
    const critiqueTimeoutPromise = new Promise<never>((_, reject) => {
      critiqueTimeoutHandle = setTimeout(() => {
        critiqueController.abort();
        reject(new Error(`Memo critique timed out after ${critiqueTimeoutMs}ms`));
      }, critiqueTimeoutMs);
    });

    let critiqueResult: { text: string };
    try {
      critiqueResult = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_critique',
          role: 'memo',
          system: CRITIQUE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `## Verified Deal Data\n\n${contextText}\n\n## Memo Sections\n\n${memoText}`,
          }],
          outputSchema: CRITIQUE_SCHEMA,
          maxTokens: 2000,
          signal: critiqueController.signal,
        }),
        critiqueTimeoutPromise,
      ]);
    } finally {
      if (critiqueTimeoutHandle) clearTimeout(critiqueTimeoutHandle);
    }

    const verdict: CritiqueVerdict = JSON.parse(critiqueResult.text);

    if (verdict.overallPass || verdict.sectionsNeedingRevision.length === 0) {
      log.info('[memoAgent/pipeline] Memo passed critique', {
        dimensions: verdict.dimensions.map((d) => `${d.name}:${d.score}`),
      });
      return sections;
    }

    log.warn('[memoAgent/pipeline] Memo failed critique, revising flagged sections', {
      sectionsNeedingRevision: verdict.sectionsNeedingRevision,
      failedDimensions: verdict.dimensions.filter((d) => !d.pass).map((d) => `${d.name}:${d.issue}`),
    });

    const flaggedSections = sections.filter((s) => verdict.sectionsNeedingRevision.includes(s.type));
    if (flaggedSections.length === 0) return sections;

    const issuesText = verdict.dimensions
      .filter((d) => !d.pass)
      .map((d) => `- ${d.name}: ${d.issue ?? 'below rubric bar'}`)
      .join('\n');
    const flaggedText = flaggedSections
      .map((s) => `### Section: ${s.type} (${s.title})\n${s.content}`)
      .join('\n\n');

    const reviseTimeoutMs = resolveTimeoutMs(REVISE_TIMEOUT_MS, 'MEMO_REVISE_TIMEOUT_MS');
    const reviseController = new AbortController();
    let reviseTimeoutHandle: NodeJS.Timeout | undefined;
    const reviseTimeoutPromise = new Promise<never>((_, reject) => {
      reviseTimeoutHandle = setTimeout(() => {
        reviseController.abort();
        reject(new Error(`Memo revise timed out after ${reviseTimeoutMs}ms`));
      }, reviseTimeoutMs);
    });

    let reviseResult: { text: string; model: string };
    try {
      reviseResult = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_revise',
          role: 'memo',
          system: REVISE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `## Issues Found\n\n${issuesText}\n\n## Sections Needing Revision\n\n${flaggedText}`,
          }],
          outputSchema: REVISE_SCHEMA,
          maxTokens: 6000,
          signal: reviseController.signal,
        }),
        reviseTimeoutPromise,
      ]);
    } finally {
      if (reviseTimeoutHandle) clearTimeout(reviseTimeoutHandle);
    }

    const revised: ReviseResult = JSON.parse(reviseResult.text);
    const revisedByType = new Map(revised.revisedSections.map((r) => [r.type, r.content]));

    return sections.map((s) => {
      const newContent = revisedByType.get(s.type);
      if (newContent === undefined) return s; // not flagged, or a hallucinated type — leave untouched
      return { ...s, content: ensureHtmlFormatting(newContent), aiModel: reviseResult.model };
    });
  } catch (err: any) {
    log.warn(`[memoAgent/pipeline] Critique/revise failed, returning ungraded memo: ${err?.message}`);
    captureAgentError(err, { agent: 'memoAgent', node: 'pipeline.critique' }, 'warning');
    return sections;
  }
}
```

Then wire it into `generateAllSections`, replacing its final `return { sections, context };` with:

```ts
  const graded = await critiqueAndRevise(sections, context);

  return { sections: graded, context };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-critique.test.ts`
Expected: PASS (all 5 tests)

Then confirm the full suite, including both new memo-pipeline test files together:

Run: `cd apps/api && npx vitest run`
Expected: 795 + 6 + 5 = 806 passed, 44 skipped, 8 failed (still only the pre-existing `mfa-bypass.test.ts`).

Run: `cd apps/api && npx tsc --noEmit`
Expected: no new errors beyond the already-known pre-existing ones (3 `stop_details` errors in `client.ts`'s untouched `trackedClaudeMessage` catch branch, 2 `memos-generate`/`memos-mutate` `PostgrestFilterBuilder` errors — both confirmed pre-existing and unrelated to this branch).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/agents/memoAgent/pipeline.ts apps/api/tests/memo-pipeline-critique.test.ts
git commit -m "feat(memo): add rubric critique + targeted revise pass to generateAllSections"
```

---

### Task 5: Manual verification (not a coding task)

Same environment caveat as Phases 1, 2-A, and 2-B: no local Supabase or `ANTHROPIC_API_KEY` credentials exist in this sandboxed worktree, so a genuine end-to-end run (generate a real memo, confirm the critique/revise actually improves a deliberately-weak section, confirm `UsageEvent` rows record `memo_section_generation`/`memo_critique`/`memo_revise` operations) is not possible here. Document this gap explicitly rather than claim it's verified — the test suite (Tasks 1-4, all passing with mocked `trackedClaudeMessage`) and `tsc --noEmit` are the best available static verification in this environment. Whoever has real credentials should run one full memo generation before merging, watching for: (a) the critique/revise pair actually firing when a section is deliberately vague, (b) no memo ever coming back empty or broken even if `ANTHROPIC_API_KEY` is temporarily invalid mid-run.

---

## Rollout

No feature flag — see the design spec's "Sequencing" section for why (this is a mechanical in-place migration plus a non-blocking additive step, not a parallel-engine swap with a legacy fallback to gate). Rollback, if ever needed, is a straight `git revert` of Task 3/4's commits. Once merged, watch `UsageEvent` rows for `operation IN ('memo_section_generation', 'memo_critique', 'memo_revise')` to confirm real-world cost and how often the revise path actually fires.
