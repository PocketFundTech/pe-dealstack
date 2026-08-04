# Streaming Deal Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deal chat agent's LangGraph/legacy-LLM implementation with a direct Anthropic Tool Runner loop, streaming tool activity and answer text to the browser over SSE.

**Architecture:** `services/ai/client.ts` gains `trackedClaudeStream()` (Tool Runner + streaming, sibling to the existing buffered `trackedClaudeMessage()`). `dealChatAgent` gets a new `runDealChatAgentStreaming()` async generator that drives it and yields typed SSE events; the 14 existing tools are ported from LangChain `tool()` wrappers to `betaZodTool()` wrappers around the same business logic, with an `emit()` callback added to the 6 tools whose results currently drive `sideEffects`/`updates`/`action` so those fire inline instead of via post-hoc `ToolMessage` scanning. The route branches on `DEAL_CHAT_ENGINE` to either keep today's buffered JSON or open an SSE response; the frontend gets a new `api.stream()` method and a rewritten `sendPrompt` that renders incrementally and sends conversation history.

**Tech Stack:** `@anthropic-ai/sdk` Tool Runner (`client.beta.messages.toolRunner`, `betaZodTool`), Express SSE (`res.write`), Next.js `fetch` + `ReadableStream`, Vitest.

---

## File Structure

**Modified:**
- `apps/api/src/services/ai/client.ts` — add `trackedClaudeStream()`
- `apps/api/src/services/agents/dealChatAgent/tools/*.ts` (13 files) — LangChain `tool()` → `betaZodTool()`; 6 of them gain an `emit` param
- `apps/api/src/services/agents/dealChatAgent/tools.ts` — barrel signature gains `emit`
- `apps/api/src/services/agents/dealChatAgent/index.ts` — new `runDealChatAgentStreaming()`, `TOOL_LABELS`; existing `runDealChatAgent()` untouched (legacy path). Bounds stay inline (like today), not via the shared `runWithAgentBounds` — that helper's `Promise.race`-over-one-invoker shape doesn't fit a generator that must keep yielding until an external signal or timeout interrupts it mid-stream; `agentBounds.ts` itself is not modified.
- `apps/api/src/routes/deals-chat-ai.ts` — `DEAL_CHAT_ENGINE` branch, SSE response path
- `apps/api/src/app.ts` — no changes (existing mount/middleware chain already covers `/api/deals/*/chat`)
- `apps/web-next/src/lib/api.ts` — add `api.stream()`
- `apps/web-next/src/app/(app)/deals/[id]/deal-page-handlers.ts` — `sendPrompt` rewrite (streaming-aware, sends history)
- `apps/web-next/src/app/(app)/deals/[id]/components.tsx` — `ChatMessage` gains `streaming?: boolean`
- `apps/web-next/src/app/(app)/deals/[id]/deal-tabs.tsx` — gate `<AIMessageActions>` on `!msg.streaming` so Copy/Helpful buttons don't appear on a still-streaming message
- `apps/api/tests/dealChatAgent-bounds.test.ts` — full rewrite (was LangGraph-specific)
- `apps/api/tests/document-delimiters.test.ts` — update the one block that calls `.invoke()` on `searchDocuments`

**New:**
- `apps/api/tests/deal-chat-stream.test.ts` — `trackedClaudeStream()` + `runDealChatAgentStreaming()`
- `apps/api/tests/deal-chat-tools-emit.test.ts` — the 6 emit-wired tools
- `apps/web-next/src/lib/api.test.ts` — extended with `api.stream()` cases (file exists, adding to it)
- `apps/web-next/src/app/(app)/deals/[id]/deal-page-handlers.test.ts` — new, `sendPrompt` streaming behavior

---

### Task 1: `trackedClaudeStream()` — streaming Tool Runner wrapper

**Files:**
- Modify: `apps/api/src/services/ai/client.ts`
- Test: `apps/api/tests/deal-chat-stream.test.ts` (this task's tests only — more added in Task 4)

`trackedClaudeMessage()` (the existing function) awaits `stream.finalMessage()` before returning — fine for extraction, wrong for chat where callers need the raw event stream. This task adds a sibling that returns the Tool Runner itself (an async-iterable of per-iteration message streams) plus a `recordUsage` callback the caller invokes once it has summed usage across every iteration — usage can't be recorded automatically here since a multi-tool-call run spans several underlying API calls, not one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/deal-chat-stream.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toolRunnerCalls: any[] = [];
let nextRunnerIterations: any[] = []; // array of arrays of stream events

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        toolRunner: (req: any) => {
          toolRunnerCalls.push(req);
          return (async function* () {
            for (const events of nextRunnerIterations) {
              yield (async function* () {
                for (const e of events) yield e;
              })();
            }
          })();
        },
      },
    };
  }
  return { default: MockAnthropic };
});

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

async function getClient() {
  return await import('../src/services/ai/client.js');
}

beforeEach(() => {
  toolRunnerCalls.length = 0;
  recorded.length = 0;
  nextRunnerIterations = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('trackedClaudeStream', () => {
  it('calls toolRunner with role-resolved model, stream:true, and passed tools/system/messages', async () => {
    nextRunnerIterations = [[{ type: 'message_stop' }]];
    const { trackedClaudeStream } = await getClient();
    const { runner } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'noop' }],
    });
    for await (const stream of runner) {
      for await (const _event of stream) {
        // drain
      }
    }
    expect(toolRunnerCalls[0]).toMatchObject({
      model: 'claude-sonnet-5',
      stream: true,
      system: 'sys',
      tools: [{ name: 'noop' }],
    });
  });

  it('recordUsage() writes a UsageEvent with the resolved model and given token counts', async () => {
    nextRunnerIterations = [[{ type: 'message_stop' }]];
    const { trackedClaudeStream } = await getClient();
    const { recordUsage } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    await recordUsage({ inputTokens: 300, outputTokens: 50 }, 'success');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'deal_chat',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      promptTokens: 300,
      completionTokens: 50,
      status: 'success',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/deal-chat-stream.test.ts
```

Expected: FAIL — `trackedClaudeStream is not exported`.

- [ ] **Step 3: Add `trackedClaudeStream()` to `apps/api/src/services/ai/client.ts`**

Add below the existing `trackedClaudeMessage()` function (do not modify that function):

```ts
export interface ClaudeStreamOptions {
  operation: string;
  role: AiRole;
  system?: string;
  messages: unknown[];
  tools: unknown[];
  signal?: AbortSignal;
}

export interface ClaudeStreamHandle {
  runner: AsyncIterable<AsyncIterable<any>>;
  recordUsage: (usage: { inputTokens: number; outputTokens: number }, status: 'success' | 'error') => Promise<void>;
}

export function trackedClaudeStream(opts: ClaudeStreamOptions): ClaudeStreamHandle {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const start = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: opts.messages,
    tools: opts.tools,
    betas: cfg.betas,
    stream: true,
  };
  if (opts.system) request.system = opts.system;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.signal) request.signal = opts.signal;

  const runner = client.beta.messages.toolRunner(request as never);

  const recordUsage = async (
    usage: { inputTokens: number; outputTokens: number },
    status: 'success' | 'error',
  ): Promise<void> => {
    await recordUsageEvent({
      operation: opts.operation,
      provider: 'anthropic',
      model: cfg.model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      status,
      durationMs: Date.now() - start,
    });
  };

  return { runner, recordUsage };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/deal-chat-stream.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ai/client.ts apps/api/tests/deal-chat-stream.test.ts
git commit -m "feat(deal-chat): trackedClaudeStream() — streaming Tool Runner wrapper"
```

---

### Task 2: Shared `ToolEmit` type + port the 6 side-effect tools

**Files:**
- Create: `apps/api/src/services/agents/dealChatAgent/types.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/addNote.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/triggerFinancialExtraction.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/navigation.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/changeDealStage.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/updateDealField.ts`
- Test: `apps/api/tests/deal-chat-tools-emit.test.ts`

The Tool Runner executes each tool's `run()` internally and doesn't surface raw tool-result content back to the caller (unlike the current LangGraph code, which scans `ToolMessage`s after the whole run completes). So the 6 tools whose JSON results today drive `sideEffects`/`updates`/`action` (`addNote`, `triggerFinancialExtraction`, `scrollToSection`, `suggestAction`, `changeDealStage`, `updateDealField`) each take a new `emit: ToolEmit` parameter and call it right where they build their success-path return value — the return value sent back to Claude is unchanged, `emit()` is purely a side-channel to the streaming loop.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/deal-chat-tools-emit.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('makeAddNoteTool emits a side_effect on success', () => {
  it('calls emit({type:"side_effect", effect:{type:"note_added"}}) after inserting', async () => {
    mockSupabase.from.mockImplementation(() => ({ insert: async () => ({ error: null }) }));
    const { makeAddNoteTool } = await import('../src/services/agents/dealChatAgent/tools/addNote.js');
    const emitted: any[] = [];
    const tool = makeAddNoteTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ content: 'called the seller', type: 'CALL_LOGGED' });
    expect(JSON.parse(result)).toEqual({ success: true, type: 'note_added' });
    expect(emitted).toEqual([{ type: 'side_effect', effect: { type: 'note_added' } }]);
  });

  it('does not emit on failure', async () => {
    mockSupabase.from.mockImplementation(() => ({ insert: async () => { throw new Error('db down'); } }));
    const { makeAddNoteTool } = await import('../src/services/agents/dealChatAgent/tools/addNote.js');
    const emitted: any[] = [];
    const tool = makeAddNoteTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ content: 'x', type: 'NOTE_ADDED' });
    expect(JSON.parse(result).success).toBe(false);
    expect(emitted).toEqual([]);
  });
});

describe('makeChangeDealStageTool emits an update on success', () => {
  it('calls emit({type:"update", update:{field:"stage",...}}) after the stage change', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { stage: 'INITIAL_REVIEW' } }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });
    const { makeChangeDealStageTool } = await import('../src/services/agents/dealChatAgent/tools/changeDealStage.js');
    const emitted: any[] = [];
    const tool = makeChangeDealStageTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ stage: 'DUE_DILIGENCE' });
    expect(JSON.parse(result)).toEqual({ success: true, field: 'stage', value: 'DUE_DILIGENCE', previousStage: 'INITIAL_REVIEW' });
    expect(emitted).toEqual([{ type: 'update', update: { field: 'stage', value: 'DUE_DILIGENCE', previousStage: 'INITIAL_REVIEW' } }]);
  });
});

describe('makeSuggestActionTool emits an action', () => {
  it('calls emit({type:"action", action:{...}})', async () => {
    const { makeSuggestActionTool } = await import('../src/services/agents/dealChatAgent/tools/navigation.js');
    const emitted: any[] = [];
    const tool = makeSuggestActionTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ actionType: 'create_memo', label: 'Create Memo' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ type: 'create_memo', label: 'Create Memo', description: undefined, url: '/memo-builder?dealId=deal-1&fromChat=1' });
    expect(emitted).toEqual([{ type: 'action', action: parsed }]);
  });
});

describe('makeScrollToSectionTool emits a side_effect', () => {
  it('calls emit({type:"side_effect", effect:{type:"scroll_to", section}})', async () => {
    const { makeScrollToSectionTool } = await import('../src/services/agents/dealChatAgent/tools/navigation.js');
    const emitted: any[] = [];
    const tool = makeScrollToSectionTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ section: 'financials' });
    expect(JSON.parse(result)).toEqual({ type: 'scroll_to', section: 'financials' });
    expect(emitted).toEqual([{ type: 'side_effect', effect: { type: 'scroll_to', section: 'financials' } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/deal-chat-tools-emit.test.ts
```

Expected: FAIL — `makeAddNoteTool` still returns a LangChain `tool()` object with no `.run()` method, and takes 2 args not 3.

- [ ] **Step 3: Create the shared type file**

```ts
// apps/api/src/services/agents/dealChatAgent/types.ts
export type ToolEmitEvent =
  | { type: 'side_effect'; effect: { type: string; [key: string]: unknown } }
  | { type: 'update'; update: { field: string; value: unknown; [key: string]: unknown } }
  | { type: 'action'; action: { type: string; label: string; url: string; [key: string]: unknown } };

export type ToolEmit = (event: ToolEmitEvent) => void;
```

- [ ] **Step 4: Port `addNote.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/addNote.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

export function makeAddNoteTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'add_note',
    description: 'Add a note, call log, email log, or meeting note to the deal activity feed.',
    inputSchema: z.object({
      content: z.string().describe('The note content'),
      type: z.enum(['NOTE_ADDED', 'CALL_LOGGED', 'EMAIL_SENT', 'MEETING_SCHEDULED']).default('NOTE_ADDED').describe('Type of activity'),
    }),
    run: async ({ content, type }) => {
      try {
        await supabase.from('Activity').insert({
          dealId,
          type: type || 'NOTE_ADDED',
          title: type === 'CALL_LOGGED' ? 'Call Logged' : type === 'EMAIL_SENT' ? 'Email Logged' : type === 'MEETING_SCHEDULED' ? 'Meeting Scheduled' : 'Note Added',
          description: content,
        });
        emit({ type: 'side_effect', effect: { type: 'note_added' } });
        return JSON.stringify({ success: true, type: 'note_added' });
      } catch (error) {
        log.error('addNote tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to add note' });
      }
    },
  });
}
```

- [ ] **Step 5: Port `triggerFinancialExtraction.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/triggerFinancialExtraction.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

export function makeTriggerFinancialExtractionTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'trigger_financial_extraction',
    description: 'Check which documents are available for financial extraction and guide the user to trigger it.',
    inputSchema: z.object({}),
    run: async () => {
      try {
        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type, fileUrl')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false })
          .limit(5);

        if (!docs || docs.length === 0) {
          return 'No documents found for this deal. Please upload a CIM or financial document first.';
        }

        const financialDoc = docs.find(d => d.type === 'FINANCIALS' || d.type === 'CIM') || docs[0];
        const payload = {
          success: true,
          type: 'extraction_triggered',
          documentName: financialDoc.name,
          message: `Financial extraction queued for "${financialDoc.name}". Use the Extract Financials button on the page to run it, or navigate to the financials section.`,
        };
        emit({ type: 'side_effect', effect: { type: 'extraction_triggered', documentName: payload.documentName, message: payload.message } });
        return JSON.stringify(payload);
      } catch (error) {
        log.error('triggerFinancialExtraction tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to trigger extraction' });
      }
    },
  });
}
```

- [ ] **Step 6: Port `navigation.ts` (both tools)**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/navigation.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { ToolEmit } from '../types.js';

export function makeSuggestActionTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'suggest_action',
    description: 'Suggest navigation to another page: create memo, open data room, upload document, view financials, change deal stage.',
    inputSchema: z.object({
      actionType: z.enum(['create_memo', 'open_data_room', 'upload_document', 'view_financials', 'change_stage']),
      label: z.string().describe('Button label text'),
      description: z.string().optional().describe('Brief explanation of what happens'),
    }),
    run: async ({ actionType, label, description }) => {
      const urlMap: Record<string, string> = {
        create_memo: `/memo-builder?dealId=${dealId}&fromChat=1`,
        open_data_room: `/data-room/${dealId}`,
        upload_document: `/data-room/${dealId}`,
        view_financials: `/deals/${dealId}`,
        change_stage: `/deals/${dealId}`,
      };
      const payload = {
        type: actionType,
        label,
        description,
        url: urlMap[actionType] || `/deals/${dealId}`,
      };
      emit({ type: 'action', action: payload });
      return JSON.stringify(payload);
    },
  });
}

export function makeScrollToSectionTool(_dealId: string, _orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'scroll_to_section',
    description: 'Scroll the deal page to a specific section. Use when the user asks to see or navigate to financials, analysis, documents, activity, or risks.',
    inputSchema: z.object({
      section: z.enum(['financials', 'analysis', 'activity', 'documents', 'risks']).describe('Section to scroll to'),
    }),
    run: async ({ section }) => {
      emit({ type: 'side_effect', effect: { type: 'scroll_to', section } });
      return JSON.stringify({ type: 'scroll_to', section });
    },
  });
}
```

- [ ] **Step 7: Port `changeDealStage.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/changeDealStage.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

export function makeChangeDealStageTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'change_deal_stage',
    description: 'Change the deal pipeline stage. Use when the user asks to advance, move back, or close a deal. Stages flow: INITIAL_REVIEW → DUE_DILIGENCE → IOI_SUBMITTED → LOI_NEGOTIATION → CLOSING → CLOSED_WON. Terminal stages: CLOSED_WON, CLOSED_LOST, PASSED.',
    inputSchema: z.object({
      stage: z.enum([
        'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED',
        'LOI_NEGOTIATION', 'CLOSING', 'CLOSED_WON', 'CLOSED_LOST', 'PASSED',
      ]),
      reason: z.string().optional().describe('Optional reason for the stage change'),
    }),
    run: async ({ stage, reason }) => {
      try {
        const { data: deal } = await supabase.from('Deal').select('stage').eq('id', dealId).single();
        if (!deal) return JSON.stringify({ success: false, error: 'Deal not found' });

        const previousStage = deal.stage;
        if (previousStage === stage) {
          return JSON.stringify({ success: false, error: `Deal is already at stage: ${stage}` });
        }

        await supabase.from('Deal').update({ stage, updatedAt: new Date().toISOString() }).eq('id', dealId);
        await supabase.from('Activity').insert({
          dealId,
          type: 'STAGE_CHANGED',
          title: 'Deal Stage Changed',
          description: `${previousStage} → ${stage}${reason ? '. Reason: ' + reason : ''}`,
        });

        emit({ type: 'update', update: { field: 'stage', value: stage, previousStage } });
        return JSON.stringify({ success: true, field: 'stage', value: stage, previousStage });
      } catch (error) {
        log.error('changeDealStage tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to change deal stage' });
      }
    },
  });
}
```

- [ ] **Step 8: Port `updateDealField.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/updateDealField.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

export function makeUpdateDealFieldTool(dealId: string, orgId: string, emit: ToolEmit) {
  return betaZodTool({
    name: 'update_deal_field',
    description: 'Update a field on the current deal. Use when the user asks to change deal properties like name, metrics, team assignments, etc.',
    inputSchema: z.object({
      field: z.enum([
        'leadPartner', 'analyst', 'source', 'priority', 'industry', 'description',
        'name', 'currency', 'revenue', 'ebitda', 'dealSize', 'irrProjected', 'mom',
        'targetCloseDate', 'grossMargin',
      ]),
      value: z.string().describe('New value. For leadPartner/analyst this can be a user ID, email, or full name — the tool resolves it to a real org member and returns an error if no unique match. For numeric fields (revenue, ebitda, dealSize, irrProjected, mom, grossMargin) pass the number in millions. For targetCloseDate use ISO date (YYYY-MM-DD).'),
      userName: z.string().optional().describe('Name of user being assigned (for confirmation message)'),
    }),
    run: async ({ field, value, userName }) => {
      try {
        if (field === 'leadPartner' || field === 'analyst') {
          const role = field === 'leadPartner' ? 'LEAD' : 'MEMBER';
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          let resolvedUserId: string | null = null;
          let resolvedName: string | null = userName ?? null;
          if (UUID_RE.test(value)) {
            const { data } = await supabase.from('User').select('id, name').eq('id', value).eq('organizationId', orgId).maybeSingle();
            if (data) { resolvedUserId = data.id; resolvedName = resolvedName ?? data.name; }
          } else if (value.includes('@')) {
            const { data } = await supabase.from('User').select('id, name').ilike('email', value).eq('organizationId', orgId).maybeSingle();
            if (data) { resolvedUserId = data.id; resolvedName = resolvedName ?? data.name; }
          } else {
            const { data: exact } = await supabase.from('User').select('id, name').ilike('name', value).eq('organizationId', orgId).limit(1).maybeSingle();
            if (exact) {
              resolvedUserId = exact.id; resolvedName = resolvedName ?? exact.name;
            } else {
              const { data: fuzzy } = await supabase.from('User').select('id, name').ilike('name', `%${value}%`).eq('organizationId', orgId).limit(2);
              if (fuzzy && fuzzy.length === 1) {
                resolvedUserId = fuzzy[0].id; resolvedName = resolvedName ?? fuzzy[0].name;
              } else if (fuzzy && fuzzy.length > 1) {
                return JSON.stringify({ success: false, error: `"${value}" matches multiple users (${fuzzy.map(u => u.name).join(', ')}). Be more specific.` });
              }
            }
          }

          if (!resolvedUserId) {
            return JSON.stringify({ success: false, error: `Could not find a team member matching "${value}". Try the user's full name or email.` });
          }

          const { data: existingMember } = await supabase.from('DealTeamMember').select('id').eq('dealId', dealId).eq('userId', resolvedUserId).maybeSingle();
          if (existingMember) {
            const { error: updErr } = await supabase.from('DealTeamMember').update({ role }).eq('id', existingMember.id);
            if (updErr) { log.error('updateDealField team-role update failed', updErr); return JSON.stringify({ success: false, error: 'Failed to update team member role.' }); }
          } else {
            const { error: insErr } = await supabase.from('DealTeamMember').insert({ dealId, userId: resolvedUserId, role });
            if (insErr) { log.error('updateDealField team-member insert failed', insErr); return JSON.stringify({ success: false, error: 'Failed to add team member.' }); }
          }

          const dealUpdate: Record<string, string> =
            field === 'leadPartner'
              ? { assignedTo: resolvedUserId, updatedAt: new Date().toISOString() }
              : { updatedAt: new Date().toISOString() };
          const { error: dealErr } = await supabase.from('Deal').update(dealUpdate).eq('id', dealId).eq('organizationId', orgId);
          if (dealErr) { log.error('updateDealField deal-row update failed', dealErr); return JSON.stringify({ success: false, error: 'Failed to persist on the deal record.' }); }

          await supabase.from('Activity').insert({
            dealId,
            type: 'TEAM_MEMBER_ADDED',
            title: `${field === 'leadPartner' ? 'Lead Partner' : 'Analyst'} Updated`,
            description: `${resolvedName || 'Team member'} assigned as ${field === 'leadPartner' ? 'Lead Partner' : 'Analyst'}`,
          });

          emit({ type: 'update', update: { field, value: resolvedUserId, userName: resolvedName } });
          return JSON.stringify({ success: true, field, value: resolvedUserId, userName: resolvedName });
        }

        const updateData: Record<string, any> = {};
        const numericFields = ['revenue', 'ebitda', 'dealSize', 'irrProjected', 'mom', 'grossMargin'];
        updateData[field] = numericFields.includes(field) ? parseFloat(value) : value;
        updateData.updatedAt = new Date().toISOString();

        await supabase.from('Deal').update(updateData).eq('id', dealId);
        await supabase.from('Activity').insert({
          dealId,
          type: 'STATUS_UPDATED',
          title: `${field.charAt(0).toUpperCase() + field.slice(1)} Updated`,
          description: `Changed to: ${value}`,
        });

        emit({ type: 'update', update: { field, value } });
        return JSON.stringify({ success: true, field, value });
      } catch (error) {
        log.error('updateDealField tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to update deal field' });
      }
    },
  });
}
```

- [ ] **Step 9: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/deal-chat-tools-emit.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/agents/dealChatAgent/types.ts apps/api/src/services/agents/dealChatAgent/tools/addNote.ts apps/api/src/services/agents/dealChatAgent/tools/triggerFinancialExtraction.ts apps/api/src/services/agents/dealChatAgent/tools/navigation.ts apps/api/src/services/agents/dealChatAgent/tools/changeDealStage.ts apps/api/src/services/agents/dealChatAgent/tools/updateDealField.ts apps/api/tests/deal-chat-tools-emit.test.ts
git commit -m "feat(deal-chat): port emit-wired tools to betaZodTool (add_note, trigger_financial_extraction, navigation, change_deal_stage, update_deal_field)"
```

---

### Task 3: Port the 8 plain-string tools + update `tools.ts` barrel + fix `document-delimiters.test.ts`

**Files:**
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/compareDeals.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/draftEmail.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/generateMeetingPrep.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/getAnalysisSummary.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/getDealActivity.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/getDealFinancials.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/listDocuments.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools/searchDocuments.ts`
- Modify: `apps/api/src/services/agents/dealChatAgent/tools.ts`
- Modify: `apps/api/tests/document-delimiters.test.ts:261-300`

These 8 tools never produce `sideEffects`/`updates`/`action` — they return plain markdown strings, so only the wrapper changes; every business-logic line stays byte-identical.

- [ ] **Step 1: Write the failing test** (extends the existing `document-delimiters.test.ts` block, which currently calls LangChain's `.invoke()`)

Replace the block at `apps/api/tests/document-delimiters.test.ts:261-300`:

```ts
describe('dealChatAgent.searchDocuments — wraps each snippet (non-RAG branch)', () => {
  // ...existing setup/mocks above this block are unchanged...
  it('wraps content in <document> delimiters', async () => {
    const { makeSearchDocumentsTool } = await import('../src/services/agents/dealChatAgent/tools/searchDocuments.js');
    const t = makeSearchDocumentsTool('deal-1', 'org-1');
    const result = await t.run({ query: 'revenue' });
    expect(result).toContain('<document name="CIM-Acme.pdf">');
  });
});
```

(Only the invocation line changes — `(t as any).invoke({...})` → `await t.run({...})`; the rest of the describe block's mocks/setup are untouched.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/document-delimiters.test.ts
```

Expected: FAIL — `makeSearchDocumentsTool` still returns a LangChain object with no `.run()` method.

- [ ] **Step 3: Port `compareDeals.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/compareDeals.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export function makeCompareDealsTool(dealId: string, orgId: string) {
  return betaZodTool({
    name: 'compare_deals',
    description: 'Compare the current deal against other deals in the portfolio. Optionally compare with a specific deal by name. Shows metrics side-by-side, portfolio averages, and rankings.',
    inputSchema: z.object({
      targetDealName: z.string().optional().describe('Name of a specific deal to compare against (e.g., "Neen AI", "Buffer"). Leave empty for general portfolio comparison.'),
    }),
    run: async ({ targetDealName }) => {
      try {
        const { data: currentDeal } = await supabase
          .from('Deal')
          .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
          .eq('id', dealId)
          .single();

        if (!currentDeal) return 'Deal not found.';

        const { data: allOrgDeals } = await supabase
          .from('Deal')
          .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
          .eq('organizationId', orgId)
          .neq('id', dealId)
          .order('updatedAt', { ascending: false })
          .limit(20);

        if (!allOrgDeals || allOrgDeals.length === 0) return 'No other deals in the portfolio to compare against.';

        let targetDeal = null;
        if (targetDealName) {
          const nameSearch = targetDealName.toLowerCase();
          targetDeal = allOrgDeals.find(d => d.name.toLowerCase().includes(nameSearch));

          if (!targetDeal) {
            const { data: found } = await supabase
              .from('Deal')
              .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
              .eq('organizationId', orgId)
              .ilike('name', `%${targetDealName}%`)
              .limit(1);
            targetDeal = found?.[0] || null;
          }
        }

        const parts: string[] = [`**Comparison: ${currentDeal.name}**\n`];

        parts.push('**Current Deal:**');
        parts.push(`  Industry: ${currentDeal.industry || 'N/A'}, Revenue: $${currentDeal.revenue || 0}M, EBITDA: $${currentDeal.ebitda || 0}M`);
        parts.push(`  Deal Size: $${currentDeal.dealSize || 0}M, IRR: ${currentDeal.irrProjected || 'N/A'}%, MoM: ${currentDeal.mom || 'N/A'}x\n`);

        if (targetDeal) {
          parts.push(`**${targetDeal.name}:**`);
          parts.push(`  Industry: ${targetDeal.industry || 'N/A'}, Revenue: $${targetDeal.revenue || 0}M, EBITDA: $${targetDeal.ebitda || 0}M`);
          parts.push(`  Deal Size: $${targetDeal.dealSize || 0}M, IRR: ${targetDeal.irrProjected || 'N/A'}%, MoM: ${targetDeal.mom || 'N/A'}x`);
          parts.push(`  Stage: ${targetDeal.stage}\n`);
        } else if (targetDealName) {
          parts.push(`Note: Could not find a deal matching "${targetDealName}" in the portfolio.\n`);
        }

        const withRevenue = allOrgDeals.filter(d => d.revenue);
        const withEbitda = allOrgDeals.filter(d => d.ebitda);
        const avgRevenue = withRevenue.length > 0 ? withRevenue.reduce((s, d) => s + (d.revenue || 0), 0) / withRevenue.length : 0;
        const avgEbitda = withEbitda.length > 0 ? withEbitda.reduce((s, d) => s + (d.ebitda || 0), 0) / withEbitda.length : 0;

        parts.push(`**Portfolio Averages (${allOrgDeals.length} deals):**`);
        parts.push(`  Avg Revenue: $${avgRevenue.toFixed(1)}M, Avg EBITDA: $${avgEbitda.toFixed(1)}M`);

        const sameIndustry = allOrgDeals.filter(d => d.industry === currentDeal.industry);
        if (sameIndustry.length > 0) {
          parts.push(`\n**Same Industry (${currentDeal.industry}, ${sameIndustry.length} deals):**`);
          for (const d of sameIndustry.slice(0, 5)) {
            parts.push(`  - ${d.name}: Revenue $${d.revenue || 0}M, EBITDA $${d.ebitda || 0}M, ${d.stage}`);
          }
        }

        if (currentDeal.revenue && withRevenue.length >= 3) {
          const rank = withRevenue.filter(d => (d.revenue || 0) < currentDeal.revenue!).length;
          const percentile = Math.round((rank / withRevenue.length) * 100);
          parts.push(`\nRevenue Percentile: ${percentile}th (${rank + 1} of ${withRevenue.length + 1})`);
        }

        return parts.join('\n');
      } catch (error) {
        log.error('compareDeals tool error', error);
        return 'Error comparing deals.';
      }
    },
  });
}
```

- [ ] **Step 4: Port `draftEmail.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/draftEmail.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { log } from '../../../../utils/logger.js';
import { generateEmailDraft } from '../../emailDrafter/index.js';

export function makeDraftEmailTool(dealId: string, orgId: string) {
  return betaZodTool({
    name: 'draft_email',
    description: 'Draft a professional email related to this deal. Returns subject line, body, and compliance check.',
    inputSchema: z.object({
      recipient: z.string().describe('Who the email is for (e.g., "management team", "broker", "legal counsel")'),
      purpose: z.string().describe('Purpose of the email (e.g., "request additional financials", "schedule site visit", "follow up on LOI")'),
      tone: z.enum(['formal', 'casual', 'direct']).default('formal').describe('Email tone'),
    }),
    run: async ({ recipient, purpose, tone }) => {
      try {
        const result = await generateEmailDraft({
          organizationId: orgId,
          dealId,
          purpose,
          context: recipient,
          tone: tone || 'formal',
        });

        if (result.status === 'failed') {
          return `Email draft failed: ${result.error || 'Unknown error'}`;
        }

        const parts = [`**Subject:** ${result.subject}\n`, result.draft];
        if (result.suggestions.length) parts.push(`\n**Suggestions:** ${result.suggestions.join('; ')}`);
        if (!result.isCompliant && result.complianceIssues.length) parts.push(`\n**Compliance Notes:** ${result.complianceIssues.join('; ')}`);

        return parts.join('\n');
      } catch (error) {
        log.error('draftEmail tool error', error);
        return 'Failed to draft email. Please try again.';
      }
    },
  });
}
```

- [ ] **Step 5: Port `generateMeetingPrep.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/generateMeetingPrep.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { log } from '../../../../utils/logger.js';
import { generateMeetingPrep } from '../../meetingPrep/index.js';

export function makeGenerateMeetingPrepTool(dealId: string, orgId: string) {
  return betaZodTool({
    name: 'generate_meeting_prep',
    description: 'Generate a meeting preparation brief for this deal. Includes talking points, questions, risks, and suggested agenda.',
    inputSchema: z.object({
      attendees: z.string().optional().describe('Who the meeting is with (e.g., "CEO of target company")'),
      topics: z.string().optional().describe('Key topics to cover'),
    }),
    run: async ({ attendees, topics }) => {
      try {
        const brief = await generateMeetingPrep({
          dealId,
          organizationId: orgId,
          meetingTopic: [attendees, topics].filter(Boolean).join('. '),
        });

        const parts = [`## ${brief.headline}\n`, `**Deal Summary:** ${brief.dealSummary}\n`];
        if (brief.contactProfile) parts.push(`**Contact:** ${brief.contactProfile}\n`);
        if (brief.keyTalkingPoints.length) parts.push(`**Talking Points:**\n${brief.keyTalkingPoints.map(p => `- ${p}`).join('\n')}\n`);
        if (brief.questionsToAsk.length) parts.push(`**Questions to Ask:**\n${brief.questionsToAsk.map(q => `- ${q}`).join('\n')}\n`);
        if (brief.risksToAddress.length) parts.push(`**Risks to Address:**\n${brief.risksToAddress.map(r => `- ${r}`).join('\n')}\n`);
        if (brief.suggestedAgenda.length) parts.push(`**Suggested Agenda:**\n${brief.suggestedAgenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);

        return parts.join('\n');
      } catch (error) {
        log.error('generateMeetingPrep tool error', error);
        return 'Failed to generate meeting prep. Please try again.';
      }
    },
  });
}
```

- [ ] **Step 6: Port `getAnalysisSummary.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/getAnalysisSummary.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { analyzeFinancials } from '../../../analysis/index.js';

export function makeGetAnalysisSummaryTool(dealId: string, _orgId: string) {
  return betaZodTool({
    name: 'get_analysis_summary',
    description: 'Run and fetch the PE analysis summary: Quality of Earnings score, red flags, key financial ratios. Use when the user asks about QoE, red flags, analysis results, or financial health.',
    inputSchema: z.object({}),
    run: async () => {
      try {
        const { data: statements } = await supabase
          .from('FinancialStatement')
          .select('*')
          .eq('dealId', dealId)
          .eq('isActive', true);

        if (!statements || statements.length === 0) {
          return 'No financial statements available for analysis. Extract financials first.';
        }

        const analysis = await analyzeFinancials(dealId, statements);
        const parts: string[] = [];

        if (analysis.qoe) {
          parts.push(`**Quality of Earnings Score: ${analysis.qoe.score}/100**`);
          parts.push(analysis.qoe.summary);
          if (analysis.qoe.flags?.length) {
            parts.push(`\nQoE Flags:\n${analysis.qoe.flags.map((f: any) => `- [${f.severity}] ${f.label}: ${f.description}`).join('\n')}`);
          }
        }

        if (analysis.redFlags?.length) {
          parts.push(`\n**Red Flags (${analysis.redFlags.length}):**`);
          for (const rf of analysis.redFlags.slice(0, 8)) {
            parts.push(`- [${rf.severity}] ${rf.title}: ${rf.detail}`);
          }
        }

        if (analysis.ratios?.length) {
          parts.push(`\n**Key Ratios:**`);
          for (const group of analysis.ratios.slice(0, 5)) {
            parts.push(`\n*${group.category}:*`);
            for (const r of group.ratios.slice(0, 4)) {
              const latest = r.periods?.[0];
              const val = latest?.value != null ? latest.value.toFixed(2) : '—';
              parts.push(`- ${r.name}: ${val}${r.unit || ''} (${r.trend})`);
            }
          }
        }

        return parts.join('\n') || 'Analysis ran but produced no results.';
      } catch (error) {
        log.error('getAnalysisSummary tool error', error);
        return 'Error running analysis.';
      }
    },
  });
}
```

- [ ] **Step 7: Port `getDealActivity.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/getDealActivity.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export function makeGetDealActivityTool(dealId: string, _orgId: string) {
  return betaZodTool({
    name: 'get_deal_activity',
    description: 'Fetch recent activity timeline for the deal — document uploads, status changes, team updates, chat history, etc.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Max activities to return (default 15)'),
    }),
    run: async ({ limit }) => {
      try {
        const { data: activities } = await supabase
          .from('Activity')
          .select('type, title, description, createdAt')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false })
          .limit(limit || 15);

        if (!activities || activities.length === 0) return 'No activities recorded for this deal.';

        const parts: string[] = [`**Recent Activity (${activities.length} items):**\n`];
        for (const a of activities) {
          const date = new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          parts.push(`- [${date}] **${a.type}**: ${a.title}${a.description ? ` — ${a.description}` : ''}`);
        }
        return parts.join('\n');
      } catch (error) {
        log.error('getDealActivity tool error', error);
        return 'Error fetching activity.';
      }
    },
  });
}
```

- [ ] **Step 8: Port `getDealFinancials.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/getDealFinancials.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export function makeGetDealFinancialsTool(dealId: string, _orgId: string) {
  return betaZodTool({
    name: 'get_deal_financials',
    description: 'Fetch extracted financial statements and deal-level metrics (revenue, EBITDA, IRR, MoM). Use when user asks about financials, numbers, revenue trends, or analysis.',
    inputSchema: z.object({}),
    run: async () => {
      try {
        const { data: statements } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, extractedData, confidence, extractionSource, isActive')
          .eq('dealId', dealId)
          .order('period', { ascending: false });

        if (!statements || statements.length === 0) {
          return 'No financial statements extracted for this deal yet.';
        }

        const activeStatements = statements.filter(s => s.isActive);
        const inactiveStatements = statements.filter(s => !s.isActive);
        const summary: string[] = [`Found ${statements.length} financial statements (${activeStatements.length} active, ${inactiveStatements.length} pending review):`];

        const byType: Record<string, typeof statements> = {};
        for (const s of statements) {
          byType[s.statementType] = byType[s.statementType] || [];
          byType[s.statementType].push(s);
        }

        for (const [type, stmts] of Object.entries(byType)) {
          summary.push(`\n**${type}** (${stmts.length} periods):`);
          for (const s of stmts.slice(0, 5)) {
            const data = s.extractedData as any;
            const items = Array.isArray(data) ? data : [];
            const revenue = items.find((i: any) => i.label?.toLowerCase().includes('revenue'));
            const ebitda = items.find((i: any) => i.label?.toLowerCase().includes('ebitda'));
            const lineCount = items.length;
            const statusNote = s.isActive ? '' : ' (pending merge review)';

            summary.push(`  - ${s.period}: ${lineCount} line items, confidence ${s.confidence}%, source: ${s.extractionSource}${statusNote}`);
            if (revenue) summary.push(`    Revenue: $${revenue.value}M`);
            if (ebitda) summary.push(`    EBITDA: $${ebitda.value}M`);
          }
        }

        const { data: deal } = await supabase.from('Deal').select('revenue, ebitda, dealSize, irrProjected, mom').eq('id', dealId).single();
        if (deal) {
          summary.push('\n**Deal-Level Metrics:**');
          if (deal.revenue) summary.push(`  Revenue: $${deal.revenue}M`);
          if (deal.ebitda) summary.push(`  EBITDA: $${deal.ebitda}M`);
          if (deal.dealSize) summary.push(`  Deal Size: $${deal.dealSize}M`);
          if (deal.irrProjected) summary.push(`  Projected IRR: ${deal.irrProjected}%`);
          if (deal.mom) summary.push(`  MoM: ${deal.mom}x`);
        }

        return summary.join('\n');
      } catch (error) {
        log.error('getDealFinancials tool error', error);
        return 'Error fetching financial data.';
      }
    },
  });
}
```

- [ ] **Step 9: Port `listDocuments.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/listDocuments.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export function makeListDocumentsTool(dealId: string, _orgId: string) {
  return betaZodTool({
    name: 'list_documents',
    description: 'List all documents uploaded to this deal with file details and AI analysis status.',
    inputSchema: z.object({}),
    run: async () => {
      try {
        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type, fileSize, createdAt, aiAnalyzedAt, confidence')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false });

        if (!docs || docs.length === 0) return 'No documents uploaded for this deal.';

        const parts = [`**Documents (${docs.length}):**\n`];
        for (const doc of docs) {
          const size = doc.fileSize ? `${(doc.fileSize / 1024).toFixed(0)} KB` : 'unknown size';
          const date = new Date(doc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const aiStatus = doc.aiAnalyzedAt ? `AI analyzed (${doc.confidence ? Math.round(doc.confidence * 100) + '%' : 'done'})` : 'Not analyzed';
          parts.push(`- **${doc.name}** — ${size}, uploaded ${date}, ${aiStatus}`);
        }
        return parts.join('\n');
      } catch (error) {
        log.error('listDocuments tool error', error);
        return 'Error fetching documents.';
      }
    },
  });
}
```

- [ ] **Step 10: Port `searchDocuments.ts`**

```ts
// apps/api/src/services/agents/dealChatAgent/tools/searchDocuments.ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { searchDocumentChunks, buildRAGContext, isRAGEnabled } from '../../../../rag.js';
import { log } from '../../../../utils/logger.js';
import { wrapDocumentContent } from '../../guardrails.js';

export function makeSearchDocumentsTool(dealId: string, _orgId: string) {
  return betaZodTool({
    name: 'search_documents',
    description: 'Search through all uploaded deal documents using semantic search. Use this when the user asks about specific information from documents, CIMs, financial reports, etc.',
    inputSchema: z.object({
      query: z.string().describe('The search query — what information to find in the documents'),
    }),
    run: async ({ query }) => {
      try {
        if (!isRAGEnabled()) {
          const { data: docs } = await supabase
            .from('Document')
            .select('id, name, type, extractedText')
            .eq('dealId', dealId)
            .not('extractedText', 'is', null);

          if (!docs || docs.length === 0) return 'No documents found for this deal.';

          const queryLower = query.toLowerCase();
          const relevant = docs.filter(d =>
            d.extractedText?.toLowerCase().includes(queryLower) ||
            d.name.toLowerCase().includes(queryLower)
          );

          if (relevant.length === 0) return 'No relevant content found in documents.';

          return relevant.map(d => {
            const text = d.extractedText || '';
            const idx = text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 200);
            const end = Math.min(text.length, idx + queryLower.length + 500);
            return wrapDocumentContent(text.slice(start, end), d.name);
          }).join('\n\n');
        }

        const searchResults = await searchDocumentChunks(query, dealId, 8, 0.4);
        if (searchResults.length === 0) return 'No relevant content found in documents.';

        const { data: docs } = await supabase.from('Document').select('id, name, type').eq('dealId', dealId);

        return wrapDocumentContent(buildRAGContext(searchResults, docs || []), 'rag-results');
      } catch (error) {
        log.error('searchDocuments tool error', error);
        return 'Error searching documents.';
      }
    },
  });
}
```

- [ ] **Step 11: Update the `tools.ts` barrel**

```ts
// apps/api/src/services/agents/dealChatAgent/tools.ts
import { makeSearchDocumentsTool } from './tools/searchDocuments.js';
import { makeGetDealFinancialsTool } from './tools/getDealFinancials.js';
import { makeCompareDealsTool } from './tools/compareDeals.js';
import { makeGetDealActivityTool } from './tools/getDealActivity.js';
import { makeUpdateDealFieldTool } from './tools/updateDealField.js';
import { makeChangeDealStageTool } from './tools/changeDealStage.js';
import { makeAddNoteTool } from './tools/addNote.js';
import { makeTriggerFinancialExtractionTool } from './tools/triggerFinancialExtraction.js';
import { makeGenerateMeetingPrepTool } from './tools/generateMeetingPrep.js';
import { makeDraftEmailTool } from './tools/draftEmail.js';
import { makeGetAnalysisSummaryTool } from './tools/getAnalysisSummary.js';
import { makeListDocumentsTool } from './tools/listDocuments.js';
import { makeSuggestActionTool, makeScrollToSectionTool } from './tools/navigation.js';
import type { ToolEmit } from './types.js';

/** Create all deal chat tools with dealId/orgId baked in via closures. */
export function getDealChatTools(dealId: string, orgId: string, emit: ToolEmit) {
  return [
    makeSearchDocumentsTool(dealId, orgId),
    makeGetDealFinancialsTool(dealId, orgId),
    makeCompareDealsTool(dealId, orgId),
    makeGetDealActivityTool(dealId, orgId),
    makeUpdateDealFieldTool(dealId, orgId, emit),
    makeChangeDealStageTool(dealId, orgId, emit),
    makeAddNoteTool(dealId, orgId, emit),
    makeTriggerFinancialExtractionTool(dealId, orgId, emit),
    makeGenerateMeetingPrepTool(dealId, orgId),
    makeDraftEmailTool(dealId, orgId),
    makeGetAnalysisSummaryTool(dealId, orgId),
    makeListDocumentsTool(dealId, orgId),
    makeScrollToSectionTool(dealId, orgId, emit),
    makeSuggestActionTool(dealId, orgId, emit),
  ];
}
```

- [ ] **Step 12: Run tests to verify everything passes**

```bash
cd apps/api && npx vitest run tests/document-delimiters.test.ts tests/deal-chat-tools-emit.test.ts
```

Expected: PASS (document-delimiters.test.ts's full suite + the 5 emit tests from Task 2).

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/services/agents/dealChatAgent/tools/compareDeals.ts apps/api/src/services/agents/dealChatAgent/tools/draftEmail.ts apps/api/src/services/agents/dealChatAgent/tools/generateMeetingPrep.ts apps/api/src/services/agents/dealChatAgent/tools/getAnalysisSummary.ts apps/api/src/services/agents/dealChatAgent/tools/getDealActivity.ts apps/api/src/services/agents/dealChatAgent/tools/getDealFinancials.ts apps/api/src/services/agents/dealChatAgent/tools/listDocuments.ts apps/api/src/services/agents/dealChatAgent/tools/searchDocuments.ts apps/api/src/services/agents/dealChatAgent/tools.ts apps/api/tests/document-delimiters.test.ts
git commit -m "feat(deal-chat): port remaining 8 plain-string tools to betaZodTool, update tools.ts barrel"
```

---

### Task 4: `runDealChatAgentStreaming()` + `TOOL_LABELS` + bounds

**Files:**
- Modify: `apps/api/src/services/agents/dealChatAgent/index.ts`
- Test: `apps/api/tests/dealChatAgent-bounds.test.ts` (full rewrite — the old version mocks `createReactAgent`, which no longer exists in this code path)

On any terminal failure — genuine error, iteration cap exceeded, or timeout/client-disconnect abort — the generator yields exactly one `error` event and returns, no `done` event. On success it yields `side_effect`/`update`/`action` events (from whatever the tools' `emit()` calls collected) followed by one `done` event. The route (Task 5) is responsible for accumulating `text_delta`s into the persisted message regardless of which terminal event arrives — the generator's job is just to emit correctly-typed events, not to make persistence decisions.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/dealChatAgent-bounds.test.ts (full replacement)
import { describe, it, expect, vi, beforeEach } from 'vitest';

let nextRunnerIterations: any[] = [];
let shouldHang = false;

const trackedClaudeStream = vi.fn((opts: any) => {
  const runner = (async function* () {
    for (const events of nextRunnerIterations) {
      if (shouldHang) {
        await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          );
        });
      }
      yield (async function* () {
        for (const e of events) yield e;
      })();
    }
  })();
  return { runner, recordUsage: vi.fn(async () => {}) };
});

vi.mock('../src/services/ai/client.js', () => ({ trackedClaudeStream }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true, getChatModel: () => ({}) }));
vi.mock('../src/services/agents/dealChatAgent/tools.js', () => ({ getDealChatTools: () => [] }));
vi.mock('../src/services/ai/models.js', () => ({ getModelConfig: () => ({ model: 'claude-sonnet-5', maxTokens: 16000, betas: [] }) }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

beforeEach(() => {
  process.env.DEAL_CHAT_AGENT_TIMEOUT_MS = '150';
  nextRunnerIterations = [];
  shouldHang = false;
  trackedClaudeStream.mockClear();
});

async function drain(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('runDealChatAgentStreaming bounds', () => {
  it('passes an AbortSignal to trackedClaudeStream', async () => {
    nextRunnerIterations = [[
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    expect(trackedClaudeStream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('completes a fast run and yields a done event with the accumulated text', async () => {
    nextRunnerIterations = [[
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fast reply' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const done = events.find((e) => e.type === 'done');
    expect(done.response).toBe('fast reply');
    expect(done.truncated).toBe(false);
  });

  it('yields an error event when the run never resolves within the timeout', async () => {
    shouldHang = true;
    nextRunnerIterations = [[{ type: 'message_start', message: { usage: { input_tokens: 0 } } }]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const start = Date.now();
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const elapsed = Date.now() - start;
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/timed out/i);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it('stops after the iteration cap and yields an error event', async () => {
    nextRunnerIterations = Array.from({ length: 15 }, () => [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
    ]);
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toMatch(/maximum number of tool calls/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/dealChatAgent-bounds.test.ts
```

Expected: FAIL — `runDealChatAgentStreaming is not exported`.

- [ ] **Step 3: Add the implementation to `dealChatAgent/index.ts`**

Add these imports alongside the existing ones (do not remove any existing import — `runDealChatAgent()` stays as the `legacy`-flag implementation):

```ts
import { trackedClaudeStream } from '../../ai/client.js';
import { getModelConfig } from '../../ai/models.js';
import type { ToolEmit, ToolEmitEvent } from './types.js';
```

Add below the existing `runDealChatAgent()` function:

```ts
const TOOL_LABELS: Record<string, string> = {
  search_documents: 'Searching documents...',
  get_deal_financials: 'Pulling financials...',
  compare_deals: 'Comparing deals...',
  get_deal_activity: 'Checking activity...',
  update_deal_field: 'Updating deal...',
  change_deal_stage: 'Changing stage...',
  add_note: 'Adding note...',
  trigger_financial_extraction: 'Checking documents...',
  generate_meeting_prep: 'Preparing meeting brief...',
  draft_email: 'Drafting email...',
  get_analysis_summary: 'Running analysis...',
  list_documents: 'Listing documents...',
  scroll_to_section: 'Navigating...',
  suggest_action: 'Preparing suggestion...',
};

export type DealChatStreamEvent =
  | { type: 'tool_start'; tool: string; label: string }
  | { type: 'text_delta'; text: string }
  | ToolEmitEvent
  | { type: 'done'; response: string; model: string; truncated: boolean; updates?: any[]; action?: any; sideEffects?: any[] }
  | { type: 'error'; message: string };

export async function* runDealChatAgentStreaming(
  input: DealChatInput,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<DealChatStreamEvent> {
  if (!isLLMAvailable()) {
    yield { type: 'error', message: 'AI service unavailable. Please configure an API key.' };
    return;
  }

  const sideEffects: Array<{ type: string; [key: string]: any }> = [];
  const updates: any[] = [];
  let action: any = null;
  const emit: ToolEmit = (event) => {
    if (event.type === 'side_effect') sideEffects.push(event.effect);
    if (event.type === 'update') updates.push(event.update);
    if (event.type === 'action') action = event.action;
  };

  const tools = getDealChatTools(input.dealId, input.orgId, emit);
  const system = `${DEAL_AGENT_SYSTEM_PROMPT}\n${SHARED_GUARDRAILS}\n\nCurrent Deal Context:\n${input.dealContext}\n\nDeal ID: ${input.dealId}\nOrganization ID: ${input.orgId}`;
  const history = (input.history ?? []).slice(-10).map((h) => ({ role: h.role, content: h.content }));
  const messages = [...history, { role: 'user', content: input.message }];

  const timeoutMs = getAgentTimeoutMs();
  const internalController = new AbortController();
  const timeoutHandle = setTimeout(() => internalController.abort(), timeoutMs);
  const onExternalAbort = () => internalController.abort();
  opts.signal?.addEventListener('abort', onExternalAbort);

  const cleanup = () => {
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  };

  let fullText = '';
  const usage = { inputTokens: 0, outputTokens: 0 };

  const { runner, recordUsage } = trackedClaudeStream({
    operation: 'deal_chat',
    role: 'chat',
    system,
    messages,
    tools,
    signal: internalController.signal,
  });

  let iterationCount = 0;
  try {
    for await (const messageStream of runner) {
      iterationCount++;
      if (iterationCount > AGENT_RECURSION_LIMIT) {
        internalController.abort();
        cleanup();
        await recordUsage(usage, 'error');
        yield { type: 'error', message: 'Reached the maximum number of tool calls for this response. Please try rephrasing or asking a more specific question.' };
        return;
      }
      for await (const event of messageStream) {
        if (event.type === 'message_start') {
          usage.inputTokens += event.message?.usage?.input_tokens ?? 0;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const toolName = event.content_block.name;
          yield { type: 'tool_start', tool: toolName, label: TOOL_LABELS[toolName] ?? `Using ${toolName}...` };
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          fullText += event.delta.text;
          yield { type: 'text_delta', text: event.delta.text };
        }
        if (event.type === 'message_delta' && event.usage) {
          usage.outputTokens += event.usage.output_tokens ?? 0;
        }
      }
    }
  } catch (error: any) {
    cleanup();
    if (internalController.signal.aborted) {
      await recordUsage(usage, 'error');
      yield { type: 'error', message: `Response timed out after ${timeoutMs}ms. Please try again.` };
      return;
    }
    await recordUsage(usage, 'error');
    captureAgentError(error, { agent: 'dealChatAgent', node: 'stream' });
    yield { type: 'error', message: classifyAIError(error.message || 'Unknown error') };
    return;
  }

  cleanup();
  await recordUsage(usage, 'success');

  for (const effect of sideEffects) yield { type: 'side_effect', effect };
  for (const update of updates) yield { type: 'update', update };
  if (action) yield { type: 'action', action };

  yield {
    type: 'done',
    response: fullText || 'I apologize, I was unable to generate a response.',
    model: getModelConfig('chat').model,
    truncated: false,
    ...(updates.length > 0 && { updates }),
    ...(action && { action }),
    ...(sideEffects.length > 0 && { sideEffects }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/dealChatAgent-bounds.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/agents/dealChatAgent/index.ts apps/api/tests/dealChatAgent-bounds.test.ts
git commit -m "feat(deal-chat): runDealChatAgentStreaming() — Tool Runner streaming loop with bounds"
```

---

### Task 5: Route — `DEAL_CHAT_ENGINE` flag + SSE response path

**Files:**
- Modify: `apps/api/src/routes/deals-chat-ai.ts:12` (import), `:250-288` (agent call + persistence + response)
- Test: `apps/api/tests/deals-chat-streaming-route.test.ts`

Everything through line 248 (input validation, org-scope check, deal load, context building, financial markdown) is untouched — only the final "run the agent and respond" block changes. On the `streaming` branch, any failure after `res.writeHead` is logged, not re-thrown to the outer catch (which would try to call `res.status(500).json(...)` on a response whose headers are already committed).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/deals-chat-streaming-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiChat: vi.fn(async () => {}) } }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true }));
vi.mock('../src/services/chatHelpers.js', () => ({ generateFallbackResponse: () => 'fallback' }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => ({ id: 'deal-1' })),
}));

const runDealChatAgent = vi.fn();
const runDealChatAgentStreaming = vi.fn();
vi.mock('../src/services/agents/dealChatAgent/index.js', () => ({ runDealChatAgent, runDealChatAgentStreaming }));

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'deal-1', name: 'Acme', stage: 'DILIGENCE', status: 'ACTIVE', organizationId: 'org-1', company: null, teamMembers: [] }, error: null }) }) }) };
    }
    if (table === 'User') {
      return {
        select: () => ({
          eq: () => ({ order: async () => ({ data: [] }), single: async () => ({ data: null }) }),
        }),
      };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: {} } }) }) }) };
    }
    if (table === 'FinancialStatement') {
      return { select: () => ({ eq: () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }) }) };
    }
    if (table === 'ChatMessage') {
      return { insert: async (row: any) => { insertedRows.push(row); return { error: null }; } };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

let insertedRows: any[] = [];

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-chat-ai.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows = [];
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.DEAL_CHAT_ENGINE;
});

describe('POST /api/deals/:dealId/chat — DEAL_CHAT_ENGINE=streaming', () => {
  it('streams SSE events and persists the accumulated assistant text', async () => {
    process.env.DEAL_CHAT_ENGINE = 'streaming';
    runDealChatAgentStreaming.mockReturnValue((async function* () {
      yield { type: 'tool_start', tool: 'search_documents', label: 'Searching documents...' };
      yield { type: 'text_delta', text: 'Hello' };
      yield { type: 'text_delta', text: ' there' };
      yield { type: 'done', response: 'Hello there', model: 'claude-sonnet-5', truncated: false };
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"tool_start"');
    expect(res.text).toContain('"type":"text_delta"');
    expect(res.text).toContain('"type":"done"');

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow.content).toBe('Hello there');
    expect(assistantRow.metadata.truncated).toBeUndefined();
  });

  it('persists the partial text with metadata.truncated on an error event', async () => {
    process.env.DEAL_CHAT_ENGINE = 'streaming';
    runDealChatAgentStreaming.mockReturnValue((async function* () {
      yield { type: 'text_delta', text: 'partial answ' };
      yield { type: 'error', message: 'Response timed out after 30000ms. Please try again.' };
    })());

    const app = await buildApp();
    await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow.content).toBe('partial answ');
    expect(assistantRow.metadata.truncated).toBe(true);
  });
});

describe('POST /api/deals/:dealId/chat — DEAL_CHAT_ENGINE unset (legacy)', () => {
  it('calls runDealChatAgent and returns buffered JSON, unchanged', async () => {
    runDealChatAgent.mockResolvedValue({ response: 'ok', model: 'gpt-4o (ReAct agent)' });
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ response: 'ok', model: 'gpt-4o (ReAct agent)' });
    expect(runDealChatAgentStreaming).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/deals-chat-streaming-route.test.ts
```

Expected: FAIL — the route has no `streaming` branch yet, and `res.headers['content-type']` for the streaming case is `application/json`.

- [ ] **Step 3: Add the import**

```ts
// apps/api/src/routes/deals-chat-ai.ts:12
import { runDealChatAgent, runDealChatAgentStreaming } from '../services/agents/dealChatAgent/index.js';
```

- [ ] **Step 4: Replace lines 250-288** (from the `// Run the ReAct agent` comment through the end of the route handler)

```ts
    const dealContext = contextParts.join('\n');
    const userId = req.user?.id || null;

    if (process.env.DEAL_CHAT_ENGINE === 'streaming') {
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

      let fullText = '';
      let finalModel = '';
      let truncated = false;
      let finalUpdates: any[] | undefined;
      let finalAction: any;

      try {
        for await (const event of runDealChatAgentStreaming(
          { dealId, orgId: deal.organizationId, message, dealContext, history: history.slice(-10) },
          { signal: abortController.signal },
        )) {
          if (event.type === 'text_delta') fullText += event.text;
          if (event.type === 'update') finalUpdates = [...(finalUpdates ?? []), event.update];
          if (event.type === 'action') finalAction = event.action;
          if (event.type === 'done') { finalModel = event.model; truncated = event.truncated; }
          if (event.type === 'error') truncated = true;
          send(event);
        }

        await supabase.from('ChatMessage').insert({ dealId, userId, role: 'user', content: message });
        await supabase.from('ChatMessage').insert({
          dealId,
          userId,
          role: 'assistant',
          content: fullText,
          metadata: {
            model: finalModel || 'claude-sonnet-5',
            ...(truncated && { truncated: true }),
            ...(finalUpdates && { updates: finalUpdates }),
            ...(finalAction && { action: finalAction }),
          },
        });

        await AuditLog.aiChat(req, `Deal: ${deal.name} (streaming)`);
      } catch (streamErr) {
        log.error('Deal chat streaming failed after headers sent', streamErr);
      } finally {
        res.end();
      }
      return;
    }

    // Run the ReAct agent (legacy path)
    const result = await runDealChatAgent({
      dealId,
      orgId: deal.organizationId,
      message,
      dealContext,
      history: history.slice(-10),
    });

    await supabase.from('ChatMessage').insert({
      dealId,
      userId,
      role: 'user',
      content: message,
    });

    await supabase.from('ChatMessage').insert({
      dealId,
      userId,
      role: 'assistant',
      content: result.response,
      metadata: {
        model: result.model,
        ...(result.updates && { updates: result.updates }),
        ...(result.action && { action: result.action }),
      },
    });

    await AuditLog.aiChat(req, `Deal: ${deal.name} (ReAct agent)`);

    res.json(result);
  } catch (error) {
    log.error('Error in deal chat', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

export default router;
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/deals-chat-streaming-route.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Run the existing `input-caps.test.ts` route-level suite to confirm the legacy path and validation are untouched**

```bash
cd apps/api && npx vitest run tests/input-caps.test.ts
```

Expected: PASS — unchanged, since it mocks `runDealChatAgent` directly and only exercises the Zod-validation branch.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/deals-chat-ai.ts apps/api/tests/deals-chat-streaming-route.test.ts
git commit -m "feat(deal-chat): DEAL_CHAT_ENGINE flag + SSE response path in deals-chat-ai.ts"
```

---

### Task 6: Frontend — `api.stream()`

**Files:**
- Modify: `apps/web-next/src/lib/api.ts`
- Modify: `apps/web-next/src/lib/api.test.ts:105-106` (append tests inside the existing `describe("api wrapper", ...)` block, reusing its `beforeEach`/`afterEach`)

`request()` unconditionally calls `res.json()`, so a sibling `requestStream()` duplicates its header-building and error handling (401 → redirect, 404 → `NotFoundError`, non-OK → `ApiError`, MFA lockout) but returns after reading the body as SSE instead of JSON. `getAuthHeaders()` is reused verbatim, not reimplemented.

- [ ] **Step 1: Write the failing tests** (append inside `describe("api wrapper", ...)`, right before its closing `});` at line 106)

```ts
  it("api.stream parses SSE data lines and calls onEvent for each", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"tool_start","tool":"search_documents"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"text_delta","text":"Hi"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"done","response":"Hi"}\n\n'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events: unknown[] = [];
    await api.stream("/deals/d1/chat", { message: "hi" }, (e) => events.push(e));

    expect(events).toEqual([
      { type: "tool_start", tool: "search_documents" },
      { type: "text_delta", text: "Hi" },
      { type: "done", response: "Hi" },
    ]);
  });

  it("api.stream handles an SSE frame split across two chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text_'));
        controller.enqueue(encoder.encode('delta","text":"ok"}\n\n'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const events: unknown[] = [];
    await api.stream("/deals/d1/chat", { message: "hi" }, (e) => events.push(e));

    expect(events).toEqual([{ type: "text_delta", text: "ok" }]);
  });

  it("api.stream throws ApiError before reading the body when the response is non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(api.stream("/deals/d1/chat", { message: "hi" }, () => {})).rejects.toThrow("boom");
  });

  it("api.stream throws NotFoundError on 404, same contract as api.get/post", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(api.stream("/deals/d1/chat", { message: "hi" }, () => {})).rejects.toBeInstanceOf(NotFoundError);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-next && npx vitest run src/lib/api.test.ts
```

Expected: FAIL — `api.stream is not a function`.

- [ ] **Step 3: Add `requestStream()` and `api.stream` to `apps/web-next/src/lib/api.ts`**

Insert above the `export const api = {` line (line 112):

```ts
export type StreamEventHandler = (event: Record<string, unknown>) => void;

async function requestStream(path: string, body: unknown, onEvent: StreamEventHandler): Promise<void> {
  if (mfaLockoutActive) {
    triggerMfaLockout("Two-factor authentication is required by your organization");
  }

  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { ...headers, Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (res.status === 404) {
    throw new NotFoundError(`Not found: ${path}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({} as Record<string, unknown>));
    const message =
      (errBody as { error?: string; message?: string }).error ||
      (errBody as { message?: string }).message ||
      res.statusText ||
      `API error ${res.status}`;
    const code = (errBody as { code?: string }).code;

    if (res.status === 403 && code === "MFA_REQUIRED") {
      triggerMfaLockout(message);
    }

    throw new ApiError(message, res.status, code);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          onEvent(JSON.parse(dataLine.slice(6)));
        } catch (err) {
          console.warn("[api.stream] failed to parse SSE frame:", err);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
```

Then extend the `api` export:

```ts
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  stream: (path: string, body: unknown, onEvent: StreamEventHandler) => requestStream(path, body, onEvent),
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web-next && npx vitest run src/lib/api.test.ts
```

Expected: PASS (all existing tests + 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/api.ts apps/web-next/src/lib/api.test.ts
git commit -m "feat(deal-chat): api.stream() — SSE-aware fetch method in the shared API client"
```

---

### Task 7: Frontend — `sendPrompt` streaming rewrite + history fix

**Files:**
- Modify: `apps/web-next/src/app/(app)/deals/[id]/deal-page-handlers.ts:186-318` (the `sendPrompt` function; `clearChatHistory` below it is untouched)
- Modify: `apps/web-next/src/app/(app)/deals/[id]/components.tsx:76-82` (`ChatMessage` type)
- Modify: `apps/web-next/src/app/(app)/deals/[id]/deal-tabs.tsx` (gate `AIMessageActions`)
- Test: `apps/web-next/src/app/(app)/deals/[id]/deal-page-handlers.test.ts`

`sendPrompt` now calls `api.stream()` instead of `api.post()`. It appends an empty assistant message on the first `tool_start`/`text_delta` (whichever arrives first), appends text as `text_delta`s arrive, and applies `update`/`action`/`side_effect` handling identical to today's — the only change from the old post-response code is that it now runs per-event instead of all at once after one `await`. It also sends the last 10 local messages as `history` on every call, closing the gap where the backend's `history` param was accepted but never populated.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-next/src/app/(app)/deals/[id]/deal-page-handlers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendPrompt } from "./deal-page-handlers";
import type { ChatMessage } from "./components";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));

const streamMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: { stream: (...args: unknown[]) => streamMock(...args) } }));

function makeDeps() {
  let messages: ChatMessage[] = [];
  const setMessages = vi.fn((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messages = updater(messages);
  });
  const setChatSending = vi.fn();
  const showToast = vi.fn();
  const loadDeal = vi.fn(async () => {});
  return {
    deps: { dealId: "deal-1", chatSending: false, setChatSending, setMessages, showToast, loadDeal },
    getMessages: () => messages,
    setChatSending,
    showToast,
    loadDeal,
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("sendPrompt (streaming)", () => {
  it("appends the user message immediately, then builds the assistant message incrementally from text_delta events", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "text_delta", text: "Hello" });
      onEvent({ type: "text_delta", text: " there" });
      onEvent({ type: "done", response: "Hello there", model: "claude-sonnet-5", truncated: false });
    });

    const { deps, getMessages } = makeDeps();
    await sendPrompt("hi", deps);

    const messages = getMessages();
    expect(messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Hello there", streaming: false });
  });

  it("sends the last 10 prior messages as history, excluding the new message being sent", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps } = makeDeps();
    deps.setMessages((prev) => [
      ...prev,
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "reply" },
    ]);

    await sendPrompt("second question", deps);

    const [, body] = streamMock.mock.calls[0];
    expect(body).toEqual({
      message: "second question",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
    });
  });

  it("shows the tool's label as placeholder content, then replaces it with the first text_delta", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "tool_start", tool: "get_deal_financials", label: "Pulling financials..." });
      onEvent({ type: "text_delta", text: "Revenue is $10M" });
      onEvent({ type: "done", response: "Revenue is $10M", model: "claude-sonnet-5", truncated: false });
    });
    const { deps, getMessages } = makeDeps();
    await sendPrompt("what's our revenue?", deps);

    const assistantMsg = getMessages().find((m) => m.role === "assistant");
    // Final content is the streamed answer, not the tool label — the label
    // is a placeholder only, replaced (not appended to) by the first delta.
    expect(assistantMsg?.content).toBe("Revenue is $10M");
  });

  it("shows a toast and refreshes the deal on an update event", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "text_delta", text: "ok" });
      onEvent({ type: "update", update: { field: "stage", value: "DUE_DILIGENCE" } });
      onEvent({ type: "done", response: "ok", model: "claude-sonnet-5", truncated: false });
    });
    const { deps, showToast, loadDeal } = makeDeps();
    await sendPrompt("advance the deal", deps);

    expect(showToast).toHaveBeenCalledWith("Changes have been applied", "success", { title: "Deal Updated" });
    expect(loadDeal).toHaveBeenCalled();
  });

  it("appends an error-styled message and marks streaming false on an error event with no prior text", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "error", message: "Response timed out after 30000ms. Please try again." });
    });
    const { deps, getMessages } = makeDeps();
    await sendPrompt("hi", deps);

    const assistantMsg = getMessages().find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("⚠️");
    expect(assistantMsg?.content).toContain("Response timed out");
  });

  it("sets setChatSending(true) then setChatSending(false) around the call", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps, setChatSending } = makeDeps();
    await sendPrompt("hi", deps);
    expect(setChatSending).toHaveBeenNthCalledWith(1, true);
    expect(setChatSending).toHaveBeenLastCalledWith(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-next && npx vitest run src/app/\(app\)/deals/\[id\]/deal-page-handlers.test.ts
```

Expected: FAIL — `sendPrompt` still calls `api.post`, not `api.stream`.

- [ ] **Step 3: Add `streaming?: boolean` to `ChatMessage`**

```ts
// apps/web-next/src/app/(app)/deals/[id]/components.tsx:76-82
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  action?: ChatAction;
  streaming?: boolean;
}
```

- [ ] **Step 4: Gate `AIMessageActions` on `!msg.streaming` in `deal-tabs.tsx`**

Find the line `<AIMessageActions content={msg.content} />` (unconditional, inside the assistant-message render branch) and wrap it:

```tsx
{!msg.streaming && <AIMessageActions content={msg.content} />}
```

- [ ] **Step 5: Rewrite `sendPrompt`** (replace `deal-page-handlers.ts:211-318`, i.e. everything from `export async function sendPrompt` through its closing `}` — leave the `ChatResponseShape` interface above it and `clearChatHistory` below it untouched)

```ts
export async function sendPrompt(
  text: string,
  deps: SendPromptDeps,
): Promise<void> {
  const { dealId, chatSending, setChatSending, setMessages, showToast, loadDeal } = deps;
  const trimmed = text.trim();
  if (!trimmed || chatSending) return;

  const userMsg: ChatMessage = {
    id: `temp-${Date.now()}`,
    role: "user",
    content: trimmed,
    createdAt: new Date().toISOString(),
  };

  // Snapshot history BEFORE appending the new message, so we don't send the
  // question we're about to ask as if it were a prior turn.
  let historySnapshot: Array<{ role: "user" | "assistant"; content: string }> = [];
  setMessages((prev) => {
    historySnapshot = prev.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    return [...prev, userMsg];
  });
  setChatSending(true);

  const assistantId = `ai-${Date.now()}`;
  let assistantStarted = false;
  let hasStreamedText = false;

  try {
    await api.stream(
      `/deals/${dealId}/chat`,
      { message: trimmed, history: historySnapshot },
      (event) => {
        const e = event as Record<string, any>;

        if (e.type === "tool_start") {
          // Shows the tool's label as transient status text (e.g. "Searching
          // documents...") until real answer text starts arriving. If a
          // second tool runs before any text streamed, replace the label
          // rather than stacking placeholders.
          if (!assistantStarted) {
            assistantStarted = true;
            setMessages((prev) => [
              ...prev,
              { id: assistantId, role: "assistant", content: e.label, createdAt: new Date().toISOString(), streaming: true },
            ]);
          } else if (!hasStreamedText) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: e.label } : m)));
          }
        }

        if (e.type === "text_delta") {
          if (!assistantStarted) {
            assistantStarted = true;
            hasStreamedText = true;
            setMessages((prev) => [
              ...prev,
              { id: assistantId, role: "assistant", content: e.text, createdAt: new Date().toISOString(), streaming: true },
            ]);
          } else if (!hasStreamedText) {
            // First real text after a tool_start placeholder — replace the
            // label instead of appending to it.
            hasStreamedText = true;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: e.text } : m)));
          } else {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + e.text } : m)),
            );
          }
        }

        if (e.type === "action") {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, action: e.action } : m)));
        }

        if (e.type === "update") {
          showToast("Changes have been applied", "success", { title: "Deal Updated" });
          loadDeal().catch((err) => console.warn("[deal] loadDeal after update failed:", err));
        }

        if (e.type === "side_effect") {
          if (e.effect.type === "note_added") {
            showToast("Activity feed updated", "success", { title: "Note Added" });
            loadDeal().catch((err) => console.warn("[deal] loadDeal after side-effect failed:", err));
          }
          if (e.effect.type === "extraction_triggered") {
            showToast(e.effect.message || "Financial extraction queued", "info", { title: "Extraction" });
          }
          if (e.effect.type === "scroll_to") {
            const sectionMap: Record<string, string> = {
              financials: "financials-section",
              analysis: "analysis-section",
              activity: "activity-feed",
              documents: "documents-list",
              risks: "key-risks-list",
            };
            const elId = e.effect.section ? sectionMap[e.effect.section] : undefined;
            const el = elId ? document.getElementById(elId) : null;
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }

        if (e.type === "done") {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
        }

        if (e.type === "error") {
          if (assistantStarted) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, streaming: false, content: m.content ? `${m.content}\n\n⚠️ ${e.message}` : `⚠️ ${e.message}` }
                  : m,
              ),
            );
          } else {
            setMessages((prev) => [
              ...prev,
              { id: assistantId, role: "assistant", content: `⚠️ ${e.message}`, createdAt: new Date().toISOString() },
            ]);
          }
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong";
    const isServerError = msg.includes("API error 5") || msg.includes("API error 429");
    setMessages((prev) => [
      ...prev,
      {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: isServerError
          ? "The server is temporarily unavailable. Please try again in a moment."
          : `Sorry, I couldn't process your request. ${msg}`,
      },
    ]);
  } finally {
    setChatSending(false);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd apps/web-next && npx vitest run src/app/\(app\)/deals/\[id\]/deal-page-handlers.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 7: Type-check the frontend**

```bash
cd apps/web-next && npx tsc --noEmit
```

Expected: no new errors from files touched in this task.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/\(app\)/deals/\[id\]/deal-page-handlers.ts apps/web-next/src/app/\(app\)/deals/\[id\]/components.tsx apps/web-next/src/app/\(app\)/deals/\[id\]/deal-tabs.tsx apps/web-next/src/app/\(app\)/deals/\[id\]/deal-page-handlers.test.ts
git commit -m "feat(deal-chat): sendPrompt streams incrementally and sends conversation history"
```

---

### Task 8: Manual verification (not automated — required before flipping the flag anywhere)

**Files:** none — this is a manual QA pass in a running dev server.

- [ ] **Step 1: Start the stack**

```bash
cd apps/api && npm run dev &
cd apps/web-next && DEAL_CHAT_ENGINE=streaming npm run dev
```

(`DEAL_CHAT_ENGINE=streaming` set in `apps/api`'s environment, since that's where the flag is read — export it in whichever shell/`.env.local` actually starts the API process.)

- [ ] **Step 2: Open a deal page, ask a question that triggers at least one tool call** (e.g. "what's our revenue and EBITDA?" — triggers `get_deal_financials`)

Confirm: a "Pulling financials..." status appears before any answer text, the answer then streams in visibly token-by-token (not all at once), and Copy/Helpful buttons don't appear until streaming finishes.

- [ ] **Step 3: Ask a question that changes deal state** (e.g. "move this deal to due diligence")

Confirm: the stage-change toast appears, the deal page's stage badge updates (via `loadDeal()`), and the assistant's confirmation text still streamed normally.

- [ ] **Step 4: Reload the page**

Confirm: both messages from Steps 2-3 are still present via `GET /:dealId/chat/history`, with the assistant text matching exactly what was shown while streaming (validates `ChatMessage` persistence).

- [ ] **Step 5: Ask a follow-up question that only makes sense with context from Step 2** (e.g. "is that higher or lower than last quarter?")

Confirm the agent's answer references the actual numbers from Step 2 rather than asking "which metric?" — validates the history fix actually reaches the agent.

- [ ] **Step 6: Close the browser tab mid-response** (ask a longer question, close the tab before it finishes), then reopen the deal page

Confirm no zombie session — check API logs for the `req.on('close', ...)` abort firing, and confirm no partial/duplicate `ChatMessage` row was left in a bad state.

---

## Rollout (not a coding task — operator checklist, mirrors the two prior phases' rollout sections)

1. Deploy with `DEAL_CHAT_ENGINE` unset (defaults to `legacy`) — this PR ships dark.
2. Flip `DEAL_CHAT_ENGINE=streaming` for internal/test accounts only first; watch `/internal/usage` for `deal_chat` operation entries with `provider: anthropic` and the expected model, and Sentry for any new `dealChatAgent` tags.
3. Compare a handful of real conversations against what the same questions would have produced on `legacy` — confirm tool selection and answer quality are at parity (new model, new orchestration — worth a real side-by-side, not just "it doesn't crash").
4. Flip broadly; soak two weeks.
5. Post-soak cleanup (separate follow-up, not part of this plan): delete `runDealChatAgent()` and its inline bounds wrapper from `dealChatAgent/index.ts`, drop the `@langchain/langgraph/prebuilt` and `@langchain/core/messages` imports there, remove `getChatModel`'s `'deal_chat'` call site from `services/llm.ts` if nothing else uses it, and check whether `@langchain/langgraph`/`@langchain/core`/`@langchain/openai` are still needed anywhere else in the repo (the still-LangGraph `memoAgent` and `firmResearchAgent`'s Phase-1 fast pass both still depend on them as of this writing — don't remove the packages themselves, just this call site's usage).
