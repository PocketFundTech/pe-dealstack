# Phase 2-A — Streaming Deal Chat: Design Spec

**Date:** 2026-08-05
**Status:** Draft for review
**Scope:** Replace the deal chat agent's LangGraph/legacy-LLM implementation with a direct Anthropic Tool Runner loop, and stream both tool activity and answer text to the frontend over SSE. Builds on the Phase 1 AI core swap (`services/ai/client.ts`, `models.ts`, PR #87, not yet merged). Phase 2-B (Research & Signals, PR #90) and Phase 2-C (rubric-graded memos) are separate sub-projects, out of scope here — this branch does not depend on either.

---

## 1. Problem (from codebase research, 2026-08-05)

- **Deal chat never migrated in Phase 1.** `dealChatAgent/index.ts` still builds a LangGraph `createReactAgent()` (`@langchain/langgraph/prebuilt`) on top of `getChatModel(0.7, 2500, 'deal_chat')` from the legacy `services/llm.ts` — a `ChatOpenAI` instance pointed either directly at OpenAI or, via `LLM_CHAT_PROVIDER`, at OpenRouter's OpenAI-compatible endpoint to reach Anthropic models. This is exactly the "two parallel LLM abstractions" problem Phase 1's design spec was written to kill; deal chat was explicitly named as one of the ~40 remaining call sites deferred to a later phase.
- **No streaming anywhere in the stack.** `agent.invoke({messages}, {...})` is a single awaited call (`dealChatAgent/index.ts:196`); the route (`deals-chat-ai.ts:283`) does one `res.json(result)`. The frontend (`deal-page-handlers.ts:211-320`) posts `{message}`, awaits the full response, and appends one fully-formed message. Even Phase 1's own `services/ai/client.ts` only streams internally to avoid a request timeout — it buffers to `finalMessage()` before returning plain text to its caller, so there's no existing precedent in this codebase for exposing token deltas to an HTTP client.
- **One structural head start:** the Next.js↔Express proxy (`apps/web-next/src/lib/api-adapter.ts`) was already built with a `ReadableStream`-backed response shim specifically so a future SSE route would work — its own header comment says as much. Nothing exercises that path today.
- **Multi-turn context may not actually reach the agent today.** The route's Zod schema accepts an optional `history` array and `runDealChatAgent` honors it (`dealChatAgent/index.ts:161-169`), but the frontend's `sendPrompt` posts only `{message}` — no evidence in the current handler code that recent turns are ever sent. Left as-is, streaming chat would ship with the same silent context gap.

## 2. Goals

1. Deal chat runs entirely on the Anthropic SDK (Phase 1's client conventions) — no LangGraph, no LangChain `ChatOpenAI`/OpenRouter indirection for this call site.
2. Tool activity and answer text both stream to the browser over SSE, end-to-end (Express route → Next.js proxy → frontend), with live per-tool status text while multi-tool answers are in progress.
3. All 14 existing tools keep their current business logic and org-scoping; only the wrapper (LangChain `tool()` → `betaZodTool()`) changes.
4. The frontend sends recent conversation history on every request, closing the gap in §1.
5. Existing safety bounds (30s timeout, max iteration count, `aiLimiter` 10/min) are preserved under the new implementation; a client disconnect stops the loop instead of burning tokens after nobody's listening.
6. Ships behind `DEAL_CHAT_ENGINE=legacy|streaming` (default `legacy`), legacy LangGraph path fully intact until soaked.

## Non-goals (Phase 2-A)

- Phase 2-B (Managed Agents for research/signals) and Phase 2-C (rubric-graded memos) — separate, unrelated specs; this branch has no dependency on Phase 2-B's Managed Agents code.
- The separate, apparently-unused `/api/conversations` chat API (`routes/chat.ts`, on the even-older `openai.ts`/`trackedChatCompletion` layer) — not touched. Worth a follow-up cleanup ticket, not this one.
- No change to the 14 tools' business logic, `ChatMessage` schema, or the resizable-panel layout component.
- No new model — reuses Phase 1's existing `chat` role (`claude-sonnet-5`) from `models.ts`.

---

## 3. Design

### 3.1 Backend — `services/ai/` streaming helper

`services/ai/client.ts` gains `trackedClaudeStream()` alongside the existing `trackedClaudeMessage()` (which buffers to `finalMessage()` and stays as-is for extraction). The new helper resolves model config via `getModelConfig('chat')`, opens `client.beta.messages.toolRunner({model, tools, messages, stream: true, ...})`, and returns the raw async-iterable of tool-runner iterations rather than a single buffered result. It still records one `UsageEvent` once the full loop completes, summing usage across every model call in the run — same accounting discipline as the buffered path, just deferred until the stream ends instead of being immediate.

### 3.2 Agent — `dealChatAgent/index.ts` (new streaming path)

A new `runDealChatAgentStreaming()` sits alongside the existing `runDealChatAgent()` (kept for the `legacy` flag branch). It builds the same system prompt and financial-context block the route already assembles, calls `trackedClaudeStream()` with the 14 ported tools, and consumes the iteration stream: on each `content_block_start` of type `tool_use`, it yields a `tool_start` event (tool name + a label from a small `TOOL_LABELS` map, e.g. `search_documents` → "Searching documents..."); on each `text_delta`, it yields `text_delta`. After a tool actually executes, the existing `sideEffects`/`updates` extraction logic (today's `index.ts:223-247`, unchanged) runs against the tool's result and yields `side_effect`/`update` events as they occur — not batched at the end, since tools are already running one at a time in the loop.

Bounds: the existing 30s `AbortController` race (`runWithAgentBounds`, `index.ts:24-30`) wraps the whole generator; a fired timeout yields one `error` event and stops the loop. The caller (the route) also passes through an `AbortSignal` from `req.on('close', ...)`, so a closed browser tab aborts the same way a timeout does.

### 3.3 Tools — 14 files under `dealChatAgent/tools/`

Each tool's existing business-logic function (the part that actually queries Supabase, calls other services, and enforces org-scoping) is untouched. Only the outer wrapper changes: LangChain's `tool(fn, {name, description, schema})` becomes `betaZodTool({name, description, inputSchema: schema, run: fn})` from `@anthropic-ai/sdk/helpers/beta/zod` — same Zod schema object, since LangChain tools in this codebase are already Zod-backed. `tools.ts`'s barrel export changes from an array of LangChain `Tool` instances to an array of `betaZodTool` results, passed straight into `trackedClaudeStream()`'s `tools` param.

### 3.4 Route — `deals-chat-ai.ts`

`POST /:dealId/chat` keeps every existing middleware (`authMiddleware`, `orgMiddleware`, `enforceOrgMfaMiddleware`, `usageContextMiddleware`, `verifyDealAccess`, `aiLimiter`) and its Zod body validation unchanged, but now also reads an optional `history` array from the body (already accepted by the schema, just not populated by the frontend today — §3.6 fixes the sender side). It branches on `process.env.DEAL_CHAT_ENGINE`:
- `legacy` (default): today's code path — `runDealChatAgent()`, one `res.json(result)`.
- `streaming`: sets `Content-Type: text/event-stream`, registers `req.on('close', ...)` to abort, and writes each event from `runDealChatAgentStreaming()` as `data: ${JSON.stringify(event)}\n\n`. Text is accumulated server-side across all `text_delta` events; once the loop ends (normally or via `error`), both `ChatMessage` rows are persisted exactly as today (`deals-chat-ai.ts:262-279`) — on a truncated run, the assistant row gets `metadata.truncated = true` and whatever partial text had streamed, not an empty row. A final `done` event (carrying the persisted message id) closes the response.

### 3.5 Frontend — `lib/api.ts` + `deal-page-handlers.ts`

`api.ts` gains `api.stream(path, body, onEvent)`: a `fetch()` with `Accept: text/event-stream`, reading the body via `ReadableStream`/`TextDecoder`, splitting on blank lines, and calling `onEvent(JSON.parse(line.slice(5)))` per `data:` line — no change to `api.post`, and no bypassing of the shared client for anything else. The route decides `legacy` vs `streaming` server-side (§3.4); the frontend doesn't need its own flag — it reads the response's `Content-Type` and calls either `api.post` (existing path) or `api.stream` (new path) accordingly, so it degrades automatically if the flag is ever off.

`sendPrompt` (`deal-page-handlers.ts`), on the streaming path: appends a new assistant message to local state on the first `tool_start` or `text_delta` (whichever arrives first) showing the tool label as transient status text; on each `text_delta`, appends to that message's content; on `side_effect`/`update`, applies exactly the same handling that exists today for the buffered response (`deal-page-handlers.ts:195-300`, unchanged); on `done`, clears the transient-status state; on `error`, shows the partial text with an inline "response was interrupted" indicator rather than discarding it.

### 3.6 History fix

`sendPrompt` now includes the last 10 entries from local `messages` state as `history` in the request body (matching the existing ≤50-item Zod schema on the route) — the same fix applies whether the engine is `legacy` or `streaming`, since the route already threads `history` into either agent path unchanged.

---

## 4. Testing

- **Backend**: `trackedClaudeStream()` and `runDealChatAgentStreaming()` tested against a mocked `client.beta.messages.toolRunner` (async-iterable of stream-like objects), mirroring the `vi.mock('@anthropic-ai/sdk', ...)` pattern already used in `ai-client.test.ts`. Covers: `tool_start` fires on `content_block_start`, `text_delta` accumulates into the eventual persisted message, `side_effect`/`update` extraction still matches today's shapes, a bounds timeout yields `error` and the partial gets persisted with `metadata.truncated`, and an aborted signal stops the loop without writing a spurious `ChatMessage`.
- **Route**: `deals-chat-ai.ts` tested for both `DEAL_CHAT_ENGINE` branches — `legacy` unchanged (existing coverage, if any, stays green), `streaming` asserts on the raw SSE body (`data: {...}\n\n` framing) and that both `ChatMessage` rows land correctly.
- **Frontend**: `api.stream()`'s SSE-line parser tested against a mocked `ReadableStream`; `sendPrompt`'s incremental-append and error/truncation handling tested against a sequence of mocked events.
- **Manual verification** (required before calling this done — this is a live, felt UI feature no automated test can fully cover): run the dev server, ask a question that triggers at least one tool call, confirm the live "Searching documents..."-style status appears before text streams in, confirm the final message matches what's persisted after a page reload, and confirm a second question shows the agent actually has context from the first (validates the history fix).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Tool Runner's streaming iteration shape doesn't match what a mocked-SDK test assumes (beta surface, still evolving) | Keep the mock narrow and behavior-focused (event types + ordering), not tied to exact SDK internals; re-verify against a real call during manual verification before flipping the flag |
| A slow/hung tool call blocks the whole stream with no visible progress | The `tool_start` event fires before the tool executes, not after — the UI shows activity the instant a tool is chosen, not just once it returns |
| Persisting a truncated partial on error could look like a complete, silently-wrong answer later | `metadata.truncated = true` on the row + the frontend renders truncated messages with an explicit "interrupted" marker, not as a normal complete answer |
| Regression on the `legacy` path while porting tools | Legacy `runDealChatAgent()` and its LangChain tool wrappers are left in place, untouched, and are what actually runs while the flag defaults to `legacy` |

## 6. Sequencing (feeds the implementation plan)

1. `services/ai/client.ts`: `trackedClaudeStream()` (+ tests)
2. Port the 14 tools to `betaZodTool()` wrappers, business logic unchanged (+ tests per tool or a shared harness)
3. `dealChatAgent`: `runDealChatAgentStreaming()` + `TOOL_LABELS` + bounds/abort wiring (+ tests)
4. Route: `DEAL_CHAT_ENGINE` flag, SSE response path, truncated-partial persistence (+ tests)
5. Frontend: `api.stream()` (+ tests)
6. Frontend: `sendPrompt` incremental rendering + history-sending fix (+ tests)
7. Manual verification in a running dev server (§4)
8. Flip `DEAL_CHAT_ENGINE=streaming` → two-week soak → delete legacy LangGraph path + prune LangChain deps if nothing else needs them
