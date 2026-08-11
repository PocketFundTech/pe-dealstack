# Phase 2-C: Rubric-Graded Memos — Design Spec

## Problem

Investment memo generation (`memoAgent/pipeline.ts`) is the last AI surface in the memo builder still on the legacy `llm.ts`/OpenAI stack — Phase 1 moved extraction there, Phase 2-A moved deal chat. It also has no quality gate: each of the 12 IC sections is generated once, independently, and returned as-is. A section can cite numbers that don't match another section, give a recommendation the risk section doesn't support, or simply be thin — and nothing catches that before the memo reaches the analyst.

This is the third and final sub-project of Phase 2 (agent runtime), after 2-A (streaming deal chat, PR #92, merged) and 2-B (research/signals on Managed Agents, PR #90, open).

## Goals

- Migrate memo section generation (`pipeline.ts`) from `getChatModel()`/`llm.ts` onto `trackedClaudeMessage()` (Phase 1's Anthropic client), same tracked-usage/model-tiering discipline as extraction and deal chat.
- Add a self-critique pass: after all sections generate, grade the assembled memo against a fixed IC-memo rubric (thesis clarity, financial-data grounding, risk coverage, actionability).
- If the critique flags failing sections, run one targeted revision pass and merge the results back in before returning.
- Keep memo generation's existing behavior — batching, placeholders, retry-on-429, HTML formatting — intact; this is a mechanical engine swap plus one new step, not a rewrite.

## Non-Goals

- The memo chat agent (`memoAgent/index.ts`, `runMemoChatAgent` — LangGraph ReAct for interactive post-generation editing) stays on the legacy stack. Out of scope for this project; a future migration can reuse the deal-chat streaming work as a template.
- No per-section grading — the critique reads the whole assembled memo once, not each section in isolation (cheaper, and it's the only way to catch cross-section inconsistencies).
- No bounded retry/self-correct loop — one revise pass, then return whatever we have. Not the financial-extraction verify node's up-to-3-retries shape.
- No user-visible score. The rubric verdict drives an internal revise decision and gets structured-logged for observability; it is not stored on the `Memo`/`MemoSection` rows and not rendered in the UI. Surfacing it later is a separate, smaller follow-up if wanted.
- No rubric configurability. The four dimensions and their pass bar are fixed in code, not per-org settings.
- No prompt rewrites to the 12 existing `SECTION_PROMPTS` — those stay as they are.

## Design

### 3.1 New AI role: `memo`

`services/ai/models.ts` gets a fourth `AiRole`:

```ts
export type AiRole = 'extraction' | 'chat' | 'fast' | 'memo';
```

- Default model: `claude-sonnet-5` (same tier as `chat` — long-form structured writing, not the heavier extraction workload).
- Env override: `AI_MEMO_MODEL`.
- `maxTokens: 4000` role default. Individual calls can still override via `ClaudeCallOptions.maxTokens` (section generation keeps the legacy 2000-token cap; the revise call passes an explicit larger cap — see 3.4).

A dedicated role (rather than reusing `chat`) keeps memo generation's model/token tuning independent of live deal chat, which now depends on the `chat` role in production-adjacent code (PR #92). Mirrors how each Phase 2 sub-project got its own role/config surface.

### 3.2 `trackedClaudeMessage` gets an optional `signal`

`ClaudeCallOptions` (`services/ai/client.ts`) gains one new optional field:

```ts
export interface ClaudeCallOptions {
  // ...existing fields unchanged...
  signal?: AbortSignal;
}
```

Wired the same way `trackedClaudeStream` already wires it: `if (opts.signal) request.signal = opts.signal;` before the `client.beta.messages.stream(request as never)` call. This is additive and optional — every existing caller (extraction, and now deal chat's non-streaming paths, if any) is unaffected. It exists so the new critique/revise calls can use the same bounded-timeout `AbortController` + `Promise.race` pattern already used everywhere else in this pipeline (`generateSection`'s per-section timeout, `dealChatAgent`'s recursion/timeout bounds) instead of a timeout that only races client-side without actually cancelling the in-flight request.

### 3.3 `generateSection` migrates to `trackedClaudeMessage`

Same external behavior, new engine — mechanical swap:

- Replace `getChatModel(0.7, 2000, 'memo_generation')` + `model.invoke([...], {signal})` with one `trackedClaudeMessage({ operation: 'memo_section_generation', role: 'memo', system: MEMO_SYSTEM_PROMPT, messages: [{role:'user', content: userPrompt}], maxTokens: 2000, signal: abortController.signal })` call.
- The existing `Promise.race([..., timeoutPromise])` + `AbortController` wrapper in `generateSection` stays exactly as it is — it now passes its `abortController.signal` into `trackedClaudeMessage` instead of into `model.invoke`.
- `response.content` (LangChain message shape) becomes `result.text` (`ClaudeCallResult.text`) — same string, different accessor.
- The 429-retry branch (`err.message.includes('429')`), `BATCH_SIZE`/`BATCH_DELAY_MS` batching in `generateAllSections`, JSON/markdown-fence stripping for `includeTableData`/`includeChartConfig` sections, and `ensureHtmlFormatting` all stay untouched — none of that is engine-specific.
- `aiModel: MODEL_REASONING` (a legacy `utils/aiModels.ts` constant) becomes `aiModel: result.model` (the actual Claude model that served the response, matching how deal chat and extraction already record real model IDs instead of a static label).

### 3.4 Critique + revise, appended to `generateAllSections`

New function in `pipeline.ts`:

```ts
async function critiqueAndRevise(
  sections: GeneratedSection[],
  context: MemoContext,
): Promise<GeneratedSection[]>
```

Called once, at the end of `generateAllSections`, after all batches finish — before the function returns.

**Step 1 — critique.** One `trackedClaudeMessage` call:
- `operation: 'memo_critique'`, `role: 'memo'`
- `system`: the critique system prompt (rubric definition, below)
- `messages`: one user message containing every generated section's type, title, and content, concatenated with clear delimiters
- `outputSchema`: `CRITIQUE_SCHEMA` (below) — structured verdict, no free text
- `maxTokens: 2000` (output is a small structured verdict even though the input is the whole memo)
- Bounded by the same `AbortController` + `resolveTimeoutMs(CRITIQUE_TIMEOUT_MS, 'MEMO_CRITIQUE_TIMEOUT_MS')` pattern as section generation, `CRITIQUE_TIMEOUT_MS = 30_000`.

Parse `result.text` as JSON into the verdict. If `overallPass` is `true` or `sectionsNeedingRevision` is empty, return `sections` unchanged — no revise call, no extra cost on a memo that already clears the bar.

**Step 2 — revise (only if Step 1 flagged something).** One more `trackedClaudeMessage` call:
- `operation: 'memo_revise'`, `role: 'memo'`
- `system`: the revise system prompt
- `messages`: the critique's `dimensions`/issues plus the full content of just the flagged sections (not the whole memo — targeted, cheaper)
- `outputSchema`: `REVISE_SCHEMA` (below)
- `maxTokens: 6000` (may need to return full HTML for several sections)
- Same bounded-timeout pattern, `REVISE_TIMEOUT_MS = 30_000`.

Parse `result.text`, merge each `revisedSections[].content` back into the matching entry of `sections` by `type` (leaving `title`, `aiGenerated`, `sortOrder` untouched; update `aiModel` to the revise call's `result.model` for the sections that changed). Any `type` in the response that doesn't match a real generated section (a hallucinated/misspelled type) is skipped silently — never throws, never inserts a stray section.

**Failure handling — best-effort, non-blocking**, matching the financial-extraction verify node's established precedent ("if verification fails, pipeline continues normally"): the entire `critiqueAndRevise` body is wrapped in try/catch. On any failure — LLM unavailable, timeout, malformed JSON from either call — log via `log.warn` + `captureAgentError(err, { agent: 'memoAgent', node: 'pipeline.critique' }, 'warning')` and return the original `sections` array unchanged. A memo is never blocked or degraded by a grading failure.

**Rubric dimensions** (`CRITIQUE_SCHEMA`):

```json
{
  "type": "object",
  "properties": {
    "overallPass": { "type": "boolean" },
    "dimensions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "enum": ["thesis_clarity", "financial_grounding", "risk_coverage", "actionability"]
          },
          "score": { "type": "integer", "minimum": 1, "maximum": 5 },
          "pass": { "type": "boolean" },
          "issue": { "type": "string" }
        },
        "required": ["name", "score", "pass"]
      }
    },
    "sectionsNeedingRevision": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["overallPass", "dimensions", "sectionsNeedingRevision"]
}
```

Pass bar: each dimension needs `score >= 3` (of 5) to pass; `overallPass` is true only if every dimension passes. The critique system prompt defines the four dimensions concretely:
- **thesis_clarity** — does the memo state a clear, consistent investment thesis and recommendation, and do the sections support it (not contradict it)?
- **financial_grounding** — do cited numbers match across sections, and are they plausible given the deal context (same discipline as deal chat's Financial Data Protocol — quote real figures, never fabricate)?
- **risk_coverage** — are the risks raised substantive and specific to this deal, not generic boilerplate?
- **actionability** — is the recommendation section clear enough for an IC to act on (BUY/PASS/CONDITIONAL plus rationale), not vague hedging?

`REVISE_SCHEMA`:

```json
{
  "type": "object",
  "properties": {
    "revisedSections": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["type", "content"]
      }
    }
  },
  "required": ["revisedSections"]
}
```

### 3.5 No changes outside `pipeline.ts` and `models.ts`/`client.ts`

`memoAgent/index.ts`'s re-exports (`generateAllSections`, `generateSection`) keep their existing signatures and return shape (`{ sections: GeneratedSection[]; context: MemoContext }`) — `critiqueAndRevise` is an internal step, invisible to callers. `routes/memos-generate.ts` (the only caller) needs no changes. `prompts.ts` (the 12 `SECTION_PROMPTS`) and `context.ts` (`buildMemoContext`/`formatContextForLLM`) are untouched.

### 3.6 What doesn't change

- `BATCH_SIZE = 3` / `BATCH_DELAY_MS = 2000` batching in `generateAllSections` — kept as-is even though Claude's rate limits differ from OpenAI's; changing rate-limit assumptions is a separate concern from this migration and out of scope here.
- The 429-retry branch in `generateSection` — Anthropic can also 429; the check is on `err.message`, engine-agnostic, no change needed.
- `ensureHtmlFormatting`, markdown-fence stripping for `includeTableData`/`includeChartConfig` sections, `makePlaceholder` — all string/JSON post-processing, untouched.
- Temperature control (`getChatModel(0.7, ...)`) is dropped, not replicated — `trackedClaudeMessage` has no temperature parameter, matching how Phase 1 migrated the other ~40 legacy call sites (mechanical migration, no per-call sampling control on the new stack).

## Testing

TDD, matching Phase 1/2-A/2-B conventions:
- `services/ai/client.ts`: extend the existing `trackedClaudeMessage` test file with cases covering the new `signal` field being forwarded when present, and omitted (no `request.signal` key) when absent.
- `services/ai/models.ts`: extend the existing model-config test file with the `memo` role's default model, env override, and max tokens.
- `memoAgent/pipeline.ts`:
  - `generateSection` tests updated to mock `trackedClaudeMessage` instead of `getChatModel`/`model.invoke`, asserting the same behaviors (placeholder on missing financials, 429 retry, JSON/table parsing, HTML formatting) still hold post-migration.
  - New tests for `critiqueAndRevise`: passes through unchanged when critique returns `overallPass: true`; calls revise and merges results when it returns `false` with flagged sections; returns original sections unchanged on a critique-call failure (mocked rejection) and on a revise-call failure; confirms only flagged sections' `content`/`aiModel` change, others stay byte-identical.
  - `generateAllSections` integration test: confirms `critiqueAndRevise` is invoked exactly once, after all batches, with the full section list.
- No frontend changes — no new tests needed there.

## Risks

- **Structured-output schema drift**: same Zod-v4/`betaZodTool()` limitation hit in 2-A doesn't apply here — `outputSchema` on `trackedClaudeMessage` takes a hand-written JSON schema directly (`Record<string, unknown>`), no Zod involved. Low risk.
- **Cost**: worst case (every memo fails critique) adds 2 extra Claude calls per memo generation (critique + revise), on top of the existing ~12 section calls. Best case (memo passes) adds 1. Given `UsageEvent` tracking is already wired through `trackedClaudeMessage`, this is visible in existing cost dashboards without new plumbing.
- **False positives from the critique model**: a good memo could get flagged unnecessarily, causing a needless revise call. Mitigated by the non-blocking failure design (worst outcome is one extra call, never a broken memo) and the `score >= 3` bar being deliberately lenient (mid-scale, not a high bar).
- **Shared-file touch**: `client.ts` and `models.ts` are used by extraction (Phase 1) and deal chat (Phase 2-A, now live-merged). Both changes here are purely additive (new optional field, new role) — no existing call sites change behavior.

## Sequencing

1. `client.ts`: add optional `signal` to `ClaudeCallOptions` + wiring, with tests.
2. `models.ts`: add `memo` role, with tests.
3. `pipeline.ts`: migrate `generateSection` to `trackedClaudeMessage`, with tests (mechanical swap, same behavior).
4. `pipeline.ts`: add `critiqueAndRevise` + `CRITIQUE_SCHEMA`/`REVISE_SCHEMA` + prompts, wired into `generateAllSections`, with tests.
5. Manual verification (same caveat as 2-A: no local Supabase/Anthropic credentials in this sandboxed environment — document the gap rather than claim it).

No feature flag — unlike 2-A/2-B, there's no legacy code path left running in parallel to fall back to (the LangChain memo *chat* agent is separate and untouched; memo *generation* has exactly one implementation, which this project replaces in place). Rollback, if ever needed, is a straight `git revert`.
