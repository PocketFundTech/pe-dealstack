# Phase 3-A: Memo Generation Live Progress — Design Spec

## Problem

Generating a full IC memo (`POST /memos/:id/generate-all`) runs up to 12 section calls in batches of 3, then (as of Phase 2-C) a critique pass and possibly a revise pass — 30-90+ seconds of real latency. The frontend shows one static `GeneratingOverlay` with a fixed message ("Analyzing deal data and documents...") for the entire duration, then all sections appear at once. There is zero feedback about what's actually happening or how far along it is.

This is the first sub-project of what was loosely called "Phase 3" earlier in this session — clarified through brainstorming to mean: extend Phase 2-A's streaming/live-activity UX pattern to the AI surfaces that don't have it yet. Memo generation goes first; research/signals live progress (Phase 2-B's Managed-Agents-based surfaces) is a separate, later sub-project with a different backend shape.

## Goals

- Sections appear in the outline/editor **as each one finishes**, not all at once at the end — founders can start reading while the rest generate.
- A live status line replaces the static overlay text: which section is being worked on, when critique/revise (Phase 2-C) is running, and which sections got revised.
- No change to total AI cost or call count — this is purely a delivery-timing change, not new generation logic.

## Non-Goals

- Single-section regenerate (the existing per-section "regenerate" button, `POST /memos/:id/sections/:id/generate`) is untouched — it's already fast and already has its own spinner.
- No feature flag — the underlying generation engine (Phase 2-C) is already migrated and unflagged; this is a purely additive UX layer, not a parallel-engine swap with a legacy path to protect.
- No partial persistence on client disconnect — if the tab closes mid-stream, remaining work is aborted and nothing is saved. A half-generated memo isn't useful to recover; the founder just clicks "Generate All" again.
- `critiqueAndRevise()` (Phase 2-C) is not modified internally — its two internal Anthropic calls keep their own timeouts as shipped. An external abort signal only gates whether critique *starts* (checked once, before entering that phase), not threaded into its internals. Simpler, and critique/revise is a small, fast tail (≤2 calls) compared to the 12-section body.
- Research/Signals live progress (the other Phase 2-B surface) — separate future sub-project.

## Design

### 3.1 New streaming primitive: `generateAllSectionsStreaming()`

`pipeline.ts` gains an async generator, structurally the same pattern as Phase 2-A's `runDealChatAgentStreaming()`:

```ts
export type MemoGenerationStreamEvent =
  | { type: 'section_start'; sectionType: SectionType; index: number; total: number }
  | { type: 'section_complete'; sectionType: SectionType; section: GeneratedSection; index: number; total: number }
  | { type: 'critique_start' }
  | { type: 'section_revised'; sectionType: SectionType; section: GeneratedSection }
  | { type: 'done'; sections: GeneratedSection[]; context: MemoContext }
  | { type: 'error'; message: string };

export async function* generateAllSectionsStreaming(
  dealId: string,
  orgId: string,
  sectionTypes?: SectionType[],
  opts?: { signal?: AbortSignal },
): AsyncGenerator<MemoGenerationStreamEvent>
```

**Concurrency is preserved, not serialized by streaming.** Within each `BATCH_SIZE`-sized batch, all sections still start together (unchanged from today) — `section_start` events are emitted for the whole batch immediately, then `section_complete` events are yielded **in real completion order** as each promise settles (via a shrinking-set `Promise.race` loop, not `Promise.all`'s all-or-nothing wait). The 2-second inter-batch pause (`BATCH_DELAY_MS`) is unchanged. `generateSection()` itself is untouched — it already never rejects (returns a placeholder `GeneratedSection` on failure), so a failed section still produces a normal `section_complete` event, never an `error` event. `error` is reserved for the one fatal precondition (`isAnthropicAvailable()` false).

After all batches finish: yield `critique_start`, call the existing `critiqueAndRevise(sections, context)` unchanged, diff its result against the pre-critique sections by `content`, and yield `section_revised` for each section whose content actually changed (not for the whole set — most memos pass critique and this loop emits nothing). Finish with one `done` event carrying the final section list — the authoritative version to persist.

Before starting a new batch, check `opts?.signal?.aborted` and return early if the client disconnected. No `error` event on abort — the caller (route) already knows why the stream ended.

### 3.2 `generateAllSections()` becomes a thin wrapper

```ts
export async function generateAllSections(
  dealId: string, orgId: string, sectionTypes?: SectionType[],
): Promise<{ sections: GeneratedSection[]; context: MemoContext }> {
  for await (const event of generateAllSectionsStreaming(dealId, orgId, sectionTypes)) {
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') return { sections: event.sections, context: event.context };
  }
  throw new Error('Memo generation stream ended without a result');
}
```

Preserves the exact existing signature and error message (`'LLM is not available. Check API key configuration.'`) so `memos-mutate.ts`'s create-with-autoGenerate path (which doesn't need live UX — it's a background enhancement during memo creation, not a "watch it happen" moment) and every Phase 2-C test that asserts against `generateAllSections` keep working unchanged. No duplicated batching/critique logic between the two.

### 3.3 Route: SSE, no flag

`routes/memos-generate.ts`'s `/generate-all` handler is converted to SSE outright (matching the "no flag" decision) — same `res.writeHead(200, {'Content-Type': 'text/event-stream', ...})` / `res.write('data: ...\n\n')` pattern as `deals-chat-ai.ts`. `req.on('close')` wires an `AbortController` into `generateAllSectionsStreaming()`'s `opts.signal`. Every generator event is forwarded as an SSE frame.

**Persistence stays exactly where it is today — after the stream completes, not per-event.** The existing pre-fetch-existing-sections + classify + batch-insert-and-update logic in the route is extracted into a small `persistGeneratedSections(memoId, generated)` helper (same code, just named and callable once the `done` event's `sections` are in hand) so it isn't duplicated. Once persisted, the route emits one final `done` SSE frame carrying the *persisted* rows (real DB ids, sort order) — this is what the frontend replaces its ephemeral in-flight state with, exactly mirroring how deal chat's `done` event carries the authoritative final answer.

### 3.4 Frontend

`createGenerateAll` (`section-handlers.ts`) is rewritten to call `api.stream()` — already built in Phase 2-A, no new frontend plumbing. As `section_complete`/`section_revised` events arrive, the relevant section is upserted into `sections` state immediately (same `setSections` used today, just called incrementally instead of once at the end). `GeneratingOverlay`'s fixed status text is replaced with the live event: "Generating Financial Performance... (4/12)", then "Reviewing memo quality...", then, only if applicable, "Revising Executive Summary...". On the final `done` event, `sections` state is replaced wholesale with the persisted rows (same as today's behavior), closing any gap between ephemeral preview and saved truth.

## Testing

- `generateAllSectionsStreaming()`: event sequence for an all-pass run (`section_start`×N, `section_complete`×N, `critique_start`, `done`, zero `section_revised`), for a critique-fails run (adds `section_revised` for the flagged section only), for a mid-batch section failure (placeholder content still yields a normal `section_complete`), for `isAnthropicAvailable()` false (single `error` event), and for an aborted signal (stops before the next batch, no further events).
- `generateAllSections()`: existing Phase 2-C tests continue to pass unchanged against the new wrapper (same signature, same thrown error message) — proves the refactor is behavior-preserving for the non-streaming caller.
- Route: SSE response test mirroring `deals-chat-streaming-route.test.ts` — headers, frame forwarding, disconnect-aborts-generator, final persisted `done` frame.
- Frontend: handler test mirroring `deal-page-handlers.test.ts`'s `sendPrompt` coverage — incremental section upsert, status-line updates, final-state replacement on `done`.

## Risks

- **Yield-as-completed loop correctness**: the `Promise.race`-over-shrinking-set pattern is a new primitive in this codebase (Phase 2-A's streaming used a single long-lived Tool Runner stream, not a batch of independent promises settling out of order) — needs careful unit testing of completion-order behavior, not just the happy path.
- **Shared-file touch**: `pipeline.ts` is also depended on by `memos-mutate.ts`'s create flow and every Phase 2-C test. The wrapper refactor (3.2) is designed specifically to keep that surface unchanged — verified by re-running Phase 2-C's existing test suite against the refactored code, not just the new streaming tests.

## Sequencing

1. `pipeline.ts`: `generateAllSectionsStreaming()` + `generateAllSections()` wrapper refactor, with tests (including re-verifying all of Phase 2-C's existing `generateAllSections`/`critiqueAndRevise` tests still pass).
2. `routes/memos-generate.ts`: extract `persistGeneratedSections()` helper, convert `/generate-all` to SSE, with tests.
3. Frontend: `createGenerateAll` → `api.stream()`, incremental section state updates, live status line, with tests.
4. Manual verification (same environment caveat as every prior phase this session — no local Supabase/Anthropic credentials; document the gap rather than claim it).
