# Phase 3-A: Memo Generation Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sections appear in the memo outline/editor as each one finishes generating, with a live status line replacing today's static "Analyzing deal data..." overlay text — instead of one 30-90 second wait followed by everything appearing at once.

**Architecture:** `pipeline.ts` gains `generateAllSectionsStreaming()`, an async generator that preserves today's batch concurrency (3 sections at once) while yielding a `section_complete` event the moment each one finishes, not waiting for the whole batch. `generateAllSections()` becomes a thin wrapper that drains this generator — unchanged behavior for its other caller (`memos-mutate.ts`'s create flow). The route converts to SSE (no flag — this is additive UX on an already-migrated, already-unflagged pipeline), and the frontend switches from `api.post()` to `api.stream()` (already built in Phase 2-A).

**Tech Stack:** Async generators, SSE (`res.write('data: ...\n\n')`), `api.stream()` (existing), Vitest + supertest.

---

### Task 1: `generateAllSectionsStreaming()` + `generateAllSections()` wrapper refactor

**Files:**
- Modify: `apps/api/src/services/agents/memoAgent/pipeline.ts`
- Modify: `apps/api/src/services/agents/memoAgent/index.ts`
- Create: `apps/api/tests/memo-pipeline-streaming.test.ts`

**Why:** The streaming primitive everything else in this plan depends on. Must preserve exact behavior for `generateAllSections()`'s existing caller and existing test suite (Phase 2-C) — verified by re-running those tests unchanged against the refactor, not just adding new ones.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/memo-pipeline-streaming.test.ts`:

```ts
/**
 * memoAgent/pipeline.ts — generateAllSectionsStreaming() tests (Phase 3-A).
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

const buildMemoContext = vi.fn();
vi.mock('../src/services/agents/memoAgent/context.js', async () => {
  const actual = await vi.importActual('../src/services/agents/memoAgent/context.js');
  return { ...actual, buildMemoContext: (...args: any[]) => buildMemoContext(...args) };
});

function fakeContext(): MemoContext {
  return {
    deal: { id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null, industry: null, revenue: 10, ebitda: 2, dealSize: null, irrProjected: null, mom: null, aiThesis: null, description: null, source: null },
    company: null,
    financials: [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 }, extractionConfidence: 90, extractionSource: 'ai', isActive: true }],
    documents: [],
    activity: [],
    team: { leadPartner: null, analyst: null, members: [] },
    dataAvailability: { hasFinancials: true, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
  };
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

// Two section types is enough to exercise a single batch (BATCH_SIZE=3)
// without the 2s inter-batch sleep slowing the test down.
const TWO_SECTIONS = ['EXECUTIVE_SUMMARY', 'RISK_ASSESSMENT'] as const;

function passingCritique() {
  return {
    text: JSON.stringify({
      overallPass: true,
      dimensions: [{ name: 'thesis_clarity', score: 4, pass: true }],
      sectionsNeedingRevision: [],
    }),
    model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
  };
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
  buildMemoContext.mockReset();
  buildMemoContext.mockResolvedValue(fakeContext());
  anthropicAvailable = true;
});

describe('generateAllSectionsStreaming', () => {
  it('yields section_start and section_complete for every section, then critique_start and done', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'section_start')).toHaveLength(2);
    expect(types.filter((t) => t === 'section_complete')).toHaveLength(2);
    expect(types).toContain('critique_start');
    expect(types.filter((t) => t === 'section_revised')).toHaveLength(0); // critique passed
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
    expect(events[events.length - 1].sections).toHaveLength(2);
  });

  it('yields section_revised only for sections the critique actually changed', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>original</p>', model: 'claude-sonnet-5' };
      }
      if (opts.operation === 'memo_critique') {
        return {
          text: JSON.stringify({
            overallPass: false,
            dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
            sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
          }),
          model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      // memo_revise
      return {
        text: JSON.stringify({ revisedSections: [{ type: 'EXECUTIVE_SUMMARY', content: '<h3>x</h3><p>revised</p>' }] }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    const revised = events.filter((e) => e.type === 'section_revised');
    expect(revised).toHaveLength(1);
    expect(revised[0].sectionType).toBe('EXECUTIVE_SUMMARY');
    expect(revised[0].section.content).toContain('revised');
  });

  it('a failed section still yields a normal section_complete with placeholder content, not an error event', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        throw new Error('Service unavailable');
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const completes = events.filter((e) => e.type === 'section_complete');
    expect(completes).toHaveLength(2);
    expect(completes[0].section.aiModel).toBe('error');
  });

  it('yields a single error event and nothing else when Anthropic is unavailable', async () => {
    anthropicAvailable = false;
    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS])) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'error', message: 'LLM is not available. Check API key configuration.' }]);
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('stops before starting more work once the signal is aborted', async () => {
    const controller = new AbortController();
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        controller.abort(); // simulate disconnect happening mid-batch
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });

    const { generateAllSectionsStreaming } = await getPipeline();
    const events: any[] = [];
    for await (const event of generateAllSectionsStreaming('deal-1', 'org-1', [...TWO_SECTIONS], { signal: controller.signal })) {
      events.push(event);
    }

    // The in-flight batch still completes (already started, not cancelled
    // mid-flight) but critique/revise never runs after abort is observed.
    expect(events.some((e) => e.type === 'critique_start')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('generateAllSections (wrapper, Phase 2-C behavior preserved)', () => {
  it('returns the final sections and context from the done event', async () => {
    trackedClaudeMessage.mockImplementation(async (opts: any) => {
      if (opts.operation === 'memo_section_generation') {
        return { text: '<h3>x</h3><p>ok</p>', model: 'claude-sonnet-5' };
      }
      return passingCritique();
    });
    const { generateAllSections } = await getPipeline();
    const result = await generateAllSections('deal-1', 'org-1', [...TWO_SECTIONS]);
    expect(result.sections).toHaveLength(2);
    expect(result.context).toBeDefined();
  });

  it('throws when Anthropic is unavailable, without calling trackedClaudeMessage', async () => {
    anthropicAvailable = false;
    const { generateAllSections } = await getPipeline();
    await expect(generateAllSections('deal-1', 'org-1')).rejects.toThrow('LLM is not available');
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-streaming.test.ts`
Expected: FAIL — `generateAllSectionsStreaming` isn't exported from `pipeline.ts` yet.

- [ ] **Step 3: Run the existing Phase 2-C pipeline tests to confirm the pre-refactor baseline**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-generation.test.ts tests/memo-pipeline-critique.test.ts`
Expected: PASS (6 + 5 tests) — this is the behavior the Task 1 refactor must not break. Re-run this exact command again after Step 5 to confirm.

- [ ] **Step 4: Implement**

In `apps/api/src/services/agents/memoAgent/pipeline.ts`, replace the body of `generateAllSections` (from `export async function generateAllSections(` through its closing `}`) with:

```ts
export type MemoGenerationStreamEvent =
  | { type: 'section_start'; sectionType: SectionType; index: number; total: number }
  | { type: 'section_complete'; sectionType: SectionType; section: GeneratedSection; index: number; total: number }
  | { type: 'critique_start' }
  | { type: 'section_revised'; sectionType: SectionType; section: GeneratedSection }
  | { type: 'done'; sections: GeneratedSection[]; context: MemoContext }
  | { type: 'error'; message: string };

/**
 * Streaming counterpart to generateAllSections(). Preserves the existing
 * batch concurrency (BATCH_SIZE sections in flight at once) but yields a
 * section_complete event the moment each one finishes, in real completion
 * order — not gated by waiting for the whole batch like Promise.all does.
 */
export async function* generateAllSectionsStreaming(
  dealId: string,
  orgId: string,
  sectionTypes?: SectionType[],
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<MemoGenerationStreamEvent> {
  if (!isAnthropicAvailable()) {
    yield { type: 'error', message: 'LLM is not available. Check API key configuration.' };
    return;
  }

  const types = sectionTypes ?? COMPREHENSIVE_IC_SECTIONS;

  log.info(`[memoAgent/pipeline] Building memo context for deal ${dealId}`);
  const context = await buildMemoContext(dealId, orgId);

  log.info(`[memoAgent/pipeline] Generating ${types.length} sections in batches of ${BATCH_SIZE}`);

  const sections: GeneratedSection[] = [];

  for (let i = 0; i < types.length; i += BATCH_SIZE) {
    if (opts.signal?.aborted) return;

    const batch = types.slice(i, i + BATCH_SIZE);

    // Start every section in this batch concurrently — kicking these off
    // is not gated by yield, so batch concurrency matches the old
    // Promise.all version exactly. Each promise is tagged with its index
    // in `pending` so we can identify which one won a given race.
    const pending = new Map(
      batch.map((sectionType, batchIndex) => [
        batchIndex,
        { sectionType, promise: generateSection(sectionType, context, undefined, i + batchIndex + 1) },
      ]),
    );

    for (const { sectionType } of pending.values()) {
      yield { type: 'section_start', sectionType, index: sections.length + 1, total: types.length };
    }

    // Yield section_complete in real completion order, not batch order.
    // generateSection() never rejects (placeholder-on-failure), so this
    // race is always won by a resolution, never a rejection.
    while (pending.size > 0) {
      const entries = [...pending.entries()];
      const winner = await Promise.race(
        entries.map(([key, { promise }]) => promise.then((section) => ({ key, section }))),
      );
      const { sectionType } = pending.get(winner.key)!;
      pending.delete(winner.key);
      sections.push(winner.section);
      yield { type: 'section_complete', sectionType, section: winner.section, index: sections.length, total: types.length };
    }

    if (i + BATCH_SIZE < types.length) {
      log.debug(`[memoAgent/pipeline] Batch ${Math.floor(i / BATCH_SIZE) + 1} complete, pausing ${BATCH_DELAY_MS}ms`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  const generated = sections.filter((s) => s.aiGenerated).length;
  const failed = sections.filter((s) => s.aiModel === 'error').length;
  log.info(
    `[memoAgent/pipeline] Completed: ${sections.length} total, ${generated} generated, ${failed} failed`,
  );

  if (opts.signal?.aborted) return;

  yield { type: 'critique_start' };
  const graded = await critiqueAndRevise(sections, context);
  for (const section of graded) {
    const original = sections.find((s) => s.type === section.type);
    if (original && original.content !== section.content) {
      yield { type: 'section_revised', sectionType: section.type as SectionType, section };
    }
  }

  yield { type: 'done', sections: graded, context };
}

/**
 * Non-streaming wrapper — drains generateAllSectionsStreaming() and
 * returns just the final result. Used by memos-mutate.ts's
 * create-with-autoGenerate flow, which doesn't need live progress.
 */
export async function generateAllSections(
  dealId: string,
  orgId: string,
  sectionTypes?: SectionType[],
): Promise<{ sections: GeneratedSection[]; context: MemoContext }> {
  for await (const event of generateAllSectionsStreaming(dealId, orgId, sectionTypes)) {
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') return { sections: event.sections, context: event.context };
  }
  throw new Error('Memo generation stream ended without a result');
}
```

This must be placed **before** `critiqueAndRevise`'s definition stays where it is (`generateAllSectionsStreaming` calls it, and hoisting makes the exact declaration order irrelevant for a top-level `export async function`, but keep it directly above the existing `// ─── Critique + Revise (Phase 2-C) ─────` comment block so the file still reads top-to-bottom as: `generateSection` → `generateAllSectionsStreaming` → `generateAllSections` → critique/revise).

In `apps/api/src/services/agents/memoAgent/index.ts`, update the re-export line:

```ts
export { generateAllSections, generateSection, generateAllSectionsStreaming } from './pipeline.js';
```

and the type re-export line:

```ts
export type { GeneratedSection, MemoGenerationStreamEvent } from './pipeline.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/memo-pipeline-streaming.test.ts tests/memo-pipeline-generation.test.ts tests/memo-pipeline-critique.test.ts`
Expected: PASS — all 9 new tests plus all 11 pre-existing Phase 2-C tests (6 + 5), unchanged.

Then run the full suite:

Run: `cd apps/api && npx vitest run`
Expected: previous baseline (811 passed, 44 skipped, 8 failed — the known pre-existing `mfa-bypass.test.ts`) plus 9 new passing tests, no new failures.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/agents/memoAgent/pipeline.ts apps/api/src/services/agents/memoAgent/index.ts apps/api/tests/memo-pipeline-streaming.test.ts
git commit -m "feat(memo): generateAllSectionsStreaming() — yield-as-completed generation events"
```

---

### Task 2: Route — `persistGeneratedSections()` extraction + SSE conversion

**Files:**
- Modify: `apps/api/src/routes/memos-generate.ts`
- Create: `apps/api/tests/memos-generate-streaming-route.test.ts`

**Why:** Delivers the streaming events over HTTP. Persistence logic is extracted (not duplicated) so the exact same batched-insert/update behavior that avoided the original N+1 problem stays in one place.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/memos-generate-streaming-route.test.ts`:

```ts
/**
 * POST /api/memos/:id/generate-all — SSE route tests (Phase 3-A).
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

let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  isAnthropicAvailable: () => anthropicAvailable,
}));

const generateAllSectionsStreaming = vi.fn();
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  generateAllSectionsStreaming: (...args: any[]) => generateAllSectionsStreaming(...args),
}));

function tableMock() {
  return (table: string) => {
    if (table === 'Memo') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'memo-1', dealId: 'deal-1' } }) }) }) }) };
    }
    if (table === 'MemoSection') {
      return {
        select: () => ({ eq: () => ({
          // First call (existing rows pre-fetch): no eq chain further, just resolves.
          then: (resolve: any) => resolve({ data: [] }),
          order: async () => ({ data: [{ id: 'sec-1', type: 'EXECUTIVE_SUMMARY', content: 'final', sortOrder: 1 }] }),
        }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
        insert: async () => ({ error: null }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/memos-generate.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memos', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  anthropicAvailable = true;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('POST /api/memos/:id/generate-all — SSE', () => {
  it('streams every generator event and ends with a persisted done frame', async () => {
    generateAllSectionsStreaming.mockReturnValue((async function* () {
      yield { type: 'section_start', sectionType: 'EXECUTIVE_SUMMARY', index: 1, total: 1 };
      yield { type: 'section_complete', sectionType: 'EXECUTIVE_SUMMARY', section: { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'draft', aiGenerated: true, aiModel: 'claude-sonnet-5' }, index: 1, total: 1 };
      yield { type: 'critique_start' };
      yield { type: 'done', sections: [{ type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'final', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 1 }], context: {} };
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"section_start"');
    expect(res.text).toContain('"type":"section_complete"');
    expect(res.text).toContain('"type":"critique_start"');
    // The done frame is re-shaped by the route (persisted rows), not forwarded raw.
    expect(res.text).toContain('"success":true');
    expect(res.text).toContain('"sec-1"');
  });

  it('returns 503 JSON (not SSE) when Anthropic is unavailable, without opening a stream', async () => {
    anthropicAvailable = false;
    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/json');
    expect(generateAllSectionsStreaming).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run tests/memos-generate-streaming-route.test.ts`
Expected: FAIL — the route still returns buffered JSON via `generateAllSections`, no SSE headers.

- [ ] **Step 3: Implement**

Replace the entire contents of `apps/api/src/routes/memos-generate.ts` with:

```ts
// ─── Memo regenerate-all-sections route ───────────────────────────
// POST /api/memos/:id/generate-all — re-runs the memo agent for all
// sections of a memo, streaming progress over SSE. Requires the memo
// to have a bound dealId.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { generateAllSectionsStreaming, GeneratedSection } from '../services/agents/memoAgent/index.js';
import { isAnthropicAvailable } from '../services/ai/client.js';
import { classifyAIError } from '../utils/aiErrors.js';

const router = Router();

// Pre-fetch ALL existing sections for this memo in ONE query, classify
// each generated section in-memory, then issue ONE batched insert for new
// rows plus parallel per-row updates for existing rows. Replaces the
// per-section `.single()` existence check that turned a 10-section
// regeneration into 10-20 sequential round-trips.
async function persistGeneratedSections(memoId: string, generated: GeneratedSection[]) {
  const { data: existingRows } = await supabase
    .from('MemoSection')
    .select('id, type')
    .eq('memoId', memoId);
  const existingByType = new Map<string, { id: string }>();
  for (const row of existingRows || []) {
    if (!existingByType.has(row.type)) existingByType.set(row.type, { id: row.id });
  }

  // Normalize type to match DB CHECK constraint (unchanged from prior code)
  const DB_TYPE_MAP: Record<string, string> = {
    'EXIT_ANALYSIS': 'EXIT_STRATEGY',
    'VALUE_CREATION_PLAN': 'VALUE_CREATION',
    'QUALITY_OF_EARNINGS': 'FINANCIAL_PERFORMANCE',
    'MANAGEMENT_ASSESSMENT': 'CUSTOM',
    'OPERATIONAL_DEEP_DIVE': 'CUSTOM',
  };

  let completed = 0;
  const updatePromises: Promise<any>[] = [];
  const toInsert: any[] = [];

  for (const gen of generated) {
    const updateData: any = {
      content: gen.content,
      aiGenerated: gen.aiGenerated,
      aiModel: gen.aiModel,
      updatedAt: new Date().toISOString(),
    };
    if (gen.tableData) updateData.tableData = gen.tableData;
    if (gen.chartConfig) updateData.chartConfig = gen.chartConfig;

    const existing = existingByType.get(gen.type);
    if (existing) {
      updatePromises.push(
        supabase.from('MemoSection').update(updateData).eq('id', existing.id)
      );
    } else {
      const normalizedType = DB_TYPE_MAP[gen.type] || gen.type;
      toInsert.push({
        memoId, type: normalizedType, title: gen.title,
        sortOrder: (gen as any).sortOrder || completed + 1,
        status: 'DRAFT', ...updateData,
      });
    }
    completed++;
  }

  await Promise.all(updatePromises);
  if (toInsert.length > 0) {
    await supabase.from('MemoSection').insert(toInsert);
  }

  const { data: refreshedSections } = await supabase
    .from('MemoSection')
    .select('*')
    .eq('memoId', memoId)
    .order('sortOrder', { ascending: true });

  return { completed, sections: refreshedSections || [] };
}

// POST /api/memos/:id/generate-all - Regenerate all sections, streamed over SSE
router.post('/:id/generate-all', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: memo } = await supabase
      .from('Memo')
      .select('id, dealId')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (!memo) return res.status(404).json({ error: 'Memo not found' });
    if (!memo.dealId) {
      return res.status(400).json({
        error: "This memo isn't attached to a deal — attach one before generating AI sections. Open the memo and pick a deal from the title bar, or recreate the memo via the Create Memo modal with a deal selected.",
        code: 'MEMO_MISSING_DEAL',
      });
    }
    if (!isAnthropicAvailable()) return res.status(503).json({ error: 'AI service unavailable' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const send = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of generateAllSectionsStreaming(memo.dealId, orgId, undefined, { signal: abortController.signal })) {
        if (event.type === 'done') {
          const { completed, sections } = await persistGeneratedSections(id, event.sections);
          send({ type: 'done', success: true, completed, total: event.sections.length, sections });
        } else {
          send(event);
        }
      }
    } catch (streamErr: any) {
      log.error('Generate-all streaming failed', streamErr);
      send({ type: 'error', message: classifyAIError(streamErr.message || 'Failed to regenerate memo') });
    } finally {
      res.end();
    }
  } catch (error: any) {
    log.error('Generate-all failed', error);
    res.status(500).json({ error: classifyAIError(error.message || 'Failed to regenerate memo') });
  }
});

export default router;
```

Note the `done` event is **not** forwarded verbatim — the route intercepts it, persists via `persistGeneratedSections()`, and emits its own richer `done` frame (`success`, `completed`, `total`, and the real persisted `sections` with DB ids) matching what the frontend already expects from the old JSON response shape. Every other event (`section_start`, `section_complete`, `critique_start`, `section_revised`, `error`) is forwarded as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/memos-generate-streaming-route.test.ts`
Expected: PASS (2 tests)

Then confirm nothing else in the suite regressed:

Run: `cd apps/api && npx vitest run`
Expected: previous count + 2, same 8 pre-existing `mfa-bypass.test.ts` failures, nothing new.

Run: `cd apps/api && npx tsc --noEmit`
Expected: same pre-existing errors as before this plan (5 total, unrelated to memo files) — no new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/memos-generate.ts apps/api/tests/memos-generate-streaming-route.test.ts
git commit -m "feat(memo): stream /generate-all over SSE, extract persistGeneratedSections()"
```

---

### Task 3: Frontend — incremental section reveal + live status line

**Files:**
- Modify: `apps/web-next/src/app/(app)/memo-builder/section-handlers.ts`
- Modify: `apps/web-next/src/app/(app)/memo-builder/page.tsx`
- Create: `apps/web-next/src/app/(app)/memo-builder/section-handlers.test.ts`

**Why:** Wires the SSE stream to the UI — sections upsert into the outline/editor as they complete, and the overlay's status text reflects live progress instead of one fixed string for the whole 30-90s wait.

- [ ] **Step 1: Write the failing test**

Create `apps/web-next/src/app/(app)/memo-builder/section-handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenerateAll } from "./section-handlers";
import type { MemoSection } from "./components";

const streamMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: { stream: (...args: unknown[]) => streamMock(...args) } }));

function makeDeps() {
  let sections: MemoSection[] = [];
  const setSections = vi.fn((updater: any) => {
    sections = typeof updater === "function" ? updater(sections) : updater;
  }) as any;
  const setEditingContent = vi.fn() as any;
  const setActiveSection = vi.fn() as any;
  const setGeneratingAll = vi.fn() as any;
  const setGenerationStatus = vi.fn() as any;
  const setError = vi.fn() as any;

  const deps: any = {
    selectedMemo: { id: "memo-1" },
    setSections,
    setEditingContent,
    setActiveSection,
    setGeneratingAll,
    setGenerationStatus,
    setError,
  };
  return { deps, getSections: () => sections, setGeneratingAll, setGenerationStatus, setError };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("createGenerateAll (streaming)", () => {
  it("upserts a section into state as soon as its section_complete event arrives", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: any) => {
      onEvent({ type: "section_start", sectionType: "EXECUTIVE_SUMMARY", index: 1, total: 2 });
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 2,
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ type: "EXECUTIVE_SUMMARY", content: "<p>draft</p>" });
  });

  it("updates the same section in place (not duplicated) on a later section_revised event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: any) => {
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 1,
      });
      onEvent({
        type: "section_revised",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>revised</p>", aiGenerated: true },
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toBe("<p>revised</p>");
  });

  it("replaces state wholesale with the persisted rows on the final done event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: any) => {
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 1,
      });
      onEvent({
        type: "done",
        success: true,
        completed: 1,
        total: 1,
        sections: [{ id: "sec-real-id", type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>final</p>", aiGenerated: true, sortOrder: 1 }],
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("sec-real-id");
    expect(sections[0].content).toBe("<p>final</p>");
  });

  it("updates the status line through section_start, critique_start, and clears it when done", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: any) => {
      onEvent({ type: "section_start", sectionType: "EXECUTIVE_SUMMARY", index: 1, total: 1 });
      onEvent({ type: "critique_start" });
      onEvent({ type: "done", success: true, completed: 1, total: 1, sections: [] });
    });

    const { deps, setGenerationStatus } = makeDeps();
    await createGenerateAll(deps)();

    const calls = setGenerationStatus.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((s: string | null) => s?.includes("executive summary"))).toBe(true);
    expect(calls).toContain("Reviewing memo quality...");
    expect(calls[calls.length - 1]).toBeNull(); // cleared in finally
  });

  it("sets an error on an error event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: any) => {
      onEvent({ type: "error", message: "LLM is not available. Check API key configuration." });
    });
    const { deps, setError } = makeDeps();
    await createGenerateAll(deps)();
    expect(setError).toHaveBeenCalledWith("LLM is not available. Check API key configuration.");
  });

  it("sets generatingAll(true) then (false) around the call, and clears generationStatus in finally", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps, setGeneratingAll, setGenerationStatus } = makeDeps();
    await createGenerateAll(deps)();
    expect(setGeneratingAll).toHaveBeenNthCalledWith(1, true);
    expect(setGeneratingAll).toHaveBeenLastCalledWith(false);
    expect(setGenerationStatus).toHaveBeenLastCalledWith(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/app/\(app\)/memo-builder/section-handlers.test.ts`
Expected: FAIL — `createGenerateAll` still calls `api.post` once and awaits a single JSON response; `setGenerationStatus` isn't a recognized dep yet.

- [ ] **Step 3: Implement**

In `apps/web-next/src/app/(app)/memo-builder/section-handlers.ts`, add `setGenerationStatus` to the `SectionDeps` interface:

```ts
interface SectionDeps {
  selectedMemo: Memo | null;
  sections: MemoSection[];
  editingContent: Record<string, string>;
  activeSection: string | null;
  addSectionType: string;
  addSectionTitle: string;
  addSectionAI: boolean;
  setSections: Dispatch<SetStateAction<MemoSection[]>>;
  setEditingContent: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSection: Dispatch<SetStateAction<string | null>>;
  setGeneratingSection: Dispatch<SetStateAction<string | null>>;
  setSavingSection: Dispatch<SetStateAction<string | null>>;
  setShowAddSection: Dispatch<SetStateAction<boolean>>;
  setAddSectionTitle: Dispatch<SetStateAction<string>>;
  setAddSectionType: Dispatch<SetStateAction<string>>;
  setAddingSectionLoading: Dispatch<SetStateAction<boolean>>;
  setPendingDeleteSection: Dispatch<SetStateAction<{ id: string; title: string } | null>>;
  setGeneratingAll: Dispatch<SetStateAction<boolean>>;
  setGenerationStatus: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}
```

Replace `createGenerateAll` entirely with:

```ts
export function createGenerateAll(deps: SectionDeps) {
  const {
    selectedMemo, setSections, setEditingContent, setActiveSection,
    setGeneratingAll, setGenerationStatus, setError,
  } = deps;

  return async () => {
    if (!selectedMemo) return;
    setGeneratingAll(true);
    setGenerationStatus(null);

    const upsertSection = (generated: {
      type: string; title: string; content: string; aiGenerated: boolean;
      tableData?: any; chartConfig?: any;
    }) => {
      setSections((prev) => {
        const idx = prev.findIndex((s) => s.type === generated.type);
        const patch: Partial<MemoSection> = {
          content: generated.content,
          aiGenerated: generated.aiGenerated,
          ...(generated.tableData !== undefined ? { tableData: generated.tableData } : {}),
          ...(generated.chartConfig !== undefined ? { chartConfig: generated.chartConfig } : {}),
        };
        if (idx === -1) {
          return [...prev, {
            id: `pending-${generated.type}`,
            type: generated.type,
            title: generated.title,
            sortOrder: prev.length + 1,
            aiGenerated: generated.aiGenerated,
            content: generated.content,
          } as MemoSection];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch };
        return next;
      });
    };

    try {
      await api.stream(`/memos/${selectedMemo.id}/generate-all`, {}, (event) => {
        const e = event as Record<string, any>;
        if (e.type === "section_start") {
          const label = String(e.sectionType).replaceAll("_", " ").toLowerCase();
          setGenerationStatus(`Generating ${label}... (${e.index}/${e.total})`);
        } else if (e.type === "section_complete") {
          setGenerationStatus(`${e.section.title} ready (${e.index}/${e.total})`);
          upsertSection(e.section);
        } else if (e.type === "critique_start") {
          setGenerationStatus("Reviewing memo quality...");
        } else if (e.type === "section_revised") {
          setGenerationStatus(`Revising ${e.section.title}...`);
          upsertSection(e.section);
        } else if (e.type === "done" && e.sections) {
          const sorted = [...e.sections].sort((a: MemoSection, b: MemoSection) => a.sortOrder - b.sortOrder);
          setSections(sorted);
          const contentMap: Record<string, string> = {};
          sorted.forEach((s: MemoSection) => { contentMap[s.id] = s.content || ""; });
          setEditingContent(contentMap);
          setActiveSection(sorted[0]?.id || null);
        } else if (e.type === "error") {
          setError(e.message || "Failed to generate all sections");
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate all sections");
    } finally {
      setGeneratingAll(false);
      setGenerationStatus(null);
    }
  };
}
```

In `apps/web-next/src/app/(app)/memo-builder/page.tsx`, add the new state near `generatingAll` (around line 118):

```ts
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
```

Add `setGenerationStatus` to `sectionDeps` (around line 216, next to `setGeneratingAll`):

```ts
    setGeneratingAll,
    setGenerationStatus,
    setError,
  };
```

Update the `overlayStatus` computation (around line 293) to use the live status once generation is running:

```ts
  const overlayStatus = autoCreating
    ? "Setting up memo from deal context..."
    : creatingMemo
    ? "Creating memo..."
    : generatingAll
    ? (generationStatus ?? "Generating all memo sections...")
    : null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/app/\(app\)/memo-builder/section-handlers.test.ts`
Expected: PASS (6 tests)

Then the full frontend suite and typecheck:

Run: `cd apps/web-next && npx vitest run`
Expected: previous count + 6, no regressions.

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: no new errors from `section-handlers.ts` or `page.tsx`. (Pre-existing worktree-environment `@types/react` version mismatches unrelated to this change may still appear — see prior phases' notes; verify any new errors are specifically about lines this task touched before treating them as real.)

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/\(app\)/memo-builder/section-handlers.ts apps/web-next/src/app/\(app\)/memo-builder/page.tsx apps/web-next/src/app/\(app\)/memo-builder/section-handlers.test.ts
git commit -m "feat(memo): live section reveal + status line during generate-all"
```

---

### Task 4: Manual verification (not a coding task)

Same environment caveat as every prior phase this session: no local Supabase or `ANTHROPIC_API_KEY` credentials exist in this sandboxed worktree, so an actual end-to-end run (click "Generate All" on a real memo, watch sections populate live, confirm the status line transitions through generation → critique → done, confirm a tab-close mid-generation aborts cleanly without persisting anything) is not possible here. Document this gap explicitly. The test suites (Tasks 1-3, all passing with mocked `trackedClaudeMessage`/`api.stream`) and `tsc --noEmit` are the best available static verification. Whoever has real credentials should run one full "Generate All" click before merging, watching specifically for: (a) sections genuinely appearing incrementally rather than all at once (network tab should show the SSE frames arriving over time, not buffered), (b) the outline sidebar and editor both reacting to the incremental `sections` state updates without visual glitches, (c) closing the tab mid-generation actually aborts the backend work (check server logs for the abort, not a completed generation after the client disconnected).

---

## Rollout

No feature flag — same reasoning as Phase 2-C: the underlying generation pipeline is already migrated and unflagged, so this is a purely additive UX layer, not a parallel-engine swap with a legacy path to protect. Ships in place. Rollback, if ever needed, is a straight `git revert` of these three commits.
