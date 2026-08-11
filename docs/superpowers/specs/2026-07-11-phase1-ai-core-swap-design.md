# Phase 1 — AI Core Swap: Design Spec

**Date:** 2026-07-11
**Status:** Draft for review
**Scope:** Replace the dual LLM abstraction and the multi-layer financial-extraction pipeline with a single Anthropic client using structured outputs and native PDF input. API contracts and frontend remain untouched. Phases 2 (agent runtime) and 3 (frontend re-architecture) are out of scope.

---

## 1. Problem (from the 2026-07-10 codebase research)

- Two parallel LLM abstractions (`services/llm.ts` LangChain + `openai.ts` raw SDK), ~61 call sites, three JSON-parsing conventions, and a 4-tier OpenRouter/OpenAI registry (`utils/aiModels.ts`) whose branching leaks into every consumer.
- Financial extraction stacks 3–4 fallback layers (Azure Doc Intelligence, LlamaParse, pdf-parse, GPT-4.1 Vision — ~2,500 LOC) and then compensates for unreliability with a verify → cross-verify → self-correct scaffold (~1,400 LOC in `financialAgent`).
- Unit-scale/currency normalization lives in prompt prose, not code — the top source of the scale/transposition errors the scaffold exists to catch.

## 2. Goals

1. One LLM client module; every AI call site goes through it.
2. Financial extraction becomes: **PDF → one Claude call with a strict JSON schema → deterministic validator → store.**
3. Provenance for every extracted number (page + source quote).
4. Equal-or-better accuracy proven by a bake-off against the legacy pipeline **before** any legacy code is deleted.
5. Usage tracking (per-user/per-org `UsageEvent` attribution) preserved unchanged.

## Non-goals (Phase 1)

- No changes to deal chat, memo, research, or signal agents (Phase 2).
- No embedding change — `gemini-embedding-001` + pgvector stays (switching means re-embedding every `DocumentChunk`; revisit in Phase 2).
- No route/API contract changes; no frontend changes.
- No deletion of legacy extraction code until the bake-off passes (deletion is the last task of this phase).

---

## 3. Design

### 3.1 Client module — `apps/api/src/services/ai/`

- `client.ts` — one `Anthropic` client (SDK already at `^0.91.1`; upgrade to latest). All calls stream when `max_tokens` is large; adaptive thinking per model defaults.
- `tracked.ts` — single wrapper that records a `UsageEvent` (model, input/output tokens from `response.usage`, cost from a static price table) via the existing `getUsageContext()` AsyncLocalStorage. Replaces the fragile callback+patched-invoke scheme documented in `llm.ts:86-145`.
- `models.ts` — the tier map, env-overridable:

| Role | Default | Env override |
|---|---|---|
| `extraction` (CIM/financials, hardest) | `claude-fable-5` | `AI_EXTRACTION_MODEL` (e.g. `claude-opus-4-8` to downgrade) |
| `chat` (deal chat, analysis — Phase 2 consumers) | `claude-sonnet-5` | `AI_CHAT_MODEL` |
| `fast` (routing, sentiment, small tasks) | `claude-haiku-4-5` | `AI_FAST_MODEL` |

**Fable 5 is the day-one extraction default (decision 2026-07-11).** Three conditions are wired into `client.ts` whenever the model is `claude-fable-5`: (a) omit the `thinking` param entirely (explicit disable 400s); (b) send the server-side `fallbacks: [{model: "claude-opus-4-8"}]` beta (`server-side-fallback-2026-06-01`) so a classifier refusal is transparently re-served by Opus 4.8 instead of failing the extraction; (c) branch on `stop_reason: "refusal"` before reading content (a refusal surviving the fallback chain marks the document `needs_review`, never a 500). Operational prerequisites: the Anthropic org must be on ≥30-day data retention or **every** Fable 5 request 400s (verify in the Console before the flag flips, and check the security whitepaper's retention language stays truthful); cost is $10/$50 per MTok (2× Opus 4.8) — the bake-off harness reports cost per document so the premium is measured, not assumed, and `AI_EXTRACTION_MODEL` is the one-line downgrade if it isn't earning its price.

- Structured output via `client.messages.parse()` with schemas derived from the existing Zod definitions (`financialSchema.ts` is the starting point). One convention replaces the current three.
- Error handling: typed SDK exceptions, most-specific-first; keep the existing `aiCircuitBreaker.ts` semantics but move them into `tracked.ts` so they apply uniformly.

### 3.2 Extraction pipeline — `apps/api/src/services/extraction/`

**PDF path (replaces Azure + LlamaParse + pdf-parse + Vision):**
1. Upload the document buffer once via the Files API (`files-api-2025-04-14`) → reuse `file_id` across fast pass, deep pass, and retries. Handles the 32MB request limit and avoids re-sending base64 per call.
2. One extraction call per statement group: document block + strict JSON schema.
3. **Provenance-in-schema, not the citations API** (citations are incompatible with `output_config.format`): every line item carries `sourcePage: number` and `sourceQuote: string` fields. `sourceQuote` is cheaply verifiable against the PDF text where text exists.
4. **Normalization in schema, not prose:** the schema requires `unitScale` (`units|thousands|millions`) and `currency` per statement plus raw-as-printed values; conversion to canonical millions-USD happens in TypeScript, not in the prompt.

**Excel path:** keep `excelFinancialExtractor.ts` sheet-scoring + xlsx→markdown conversion (Claude has no native xlsx document block), but the classification call moves to the new client with the same schema.

**Validation:** `financialValidator.ts` (deterministic math checks) stays as the single post-check. On failure: **one** targeted repair call — validator failures listed in the prompt with the prior extraction JSON as anchor; the model returns the full corrected structure (prevents drift in already-correct values). Then store with `extractionConfidence` and `mergeStatus` exactly as today. The verify/cross-verify/self-correct loop is not ported.

**Kept as-is:** `financialExtractionOrchestrator.ts` fast/deep-pass split and DB upsert/merge semantics; `extractionCache.ts` content-hash cache; the per-org concurrency semaphore (still useful for cost bounding).

**Cost levers:** `cache_control` breakpoint after the document block (fast pass and deep pass share the prefix); Batch API (50% off) for bulk re-extraction/backfill jobs.

### 3.3 Rollout flag + bake-off

- `EXTRACTION_ENGINE=legacy|claude` (default `legacy`) selected inside `extractNode.ts` — the LangGraph graph shape is untouched in Phase 1, so the agent-log UI keeps working.
- Bake-off harness: `apps/api/scripts/extraction-bakeoff.ts` runs the engines over a set of real anonymized CIMs/financial PDFs and reports per-line-item agreement, validator pass rate, wall-clock, and cost per document. Runs three candidates: legacy, `claude-fable-5`, `claude-opus-4-8`. Acceptance gate: Fable 5 ≥ legacy on validator pass rate (hard gate); cost is reported for the Fable-5-vs-Opus-4.8 decision, not gated (the model default is a product decision made 2026-07-11).
- After the gate passes and the flag flips in production for two weeks: delete `azureDocIntelligence.ts`, `llamaParse.ts`, `visionExtractor.ts`, `financialClassifier.ts` (classifier prompts), `openai.ts`, the LangChain paths of `llm.ts`, and drop deps `@azure/ai-form-recognizer`, `@llamaindex/cloud`, `openai`, `@langchain/openai` (LangGraph itself stays until Phase 2).

### 3.4 Non-extraction call-site migration

The remaining ~40 call sites (memo prompts, insights, email drafts, etc.) migrate mechanically to `tracked()` + `parse()` with their existing prompts and Zod schemas, keeping current behavior. No prompt rewrites in Phase 1 beyond deleting provider-specific workarounds (e.g. `json_object` pins).

## 4. Testing

- Unit: schema validation, normalization math, repair-call path, refusal/fallback handling (mocked SDK).
- Existing suites (`financial-validator`, `financial-extraction-cache`, `agent-bounds`, org-isolation) must stay green — they don't change.
- Bake-off harness is the integration gate (real API calls, run manually/CI-nightly, not in PR CI).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Accuracy regression on scanned/table-heavy CIMs | Flag + bake-off before any deletion; legacy path remains one env var away |
| Cost surprise on huge CIMs (1M context temptation) | Page-range chunking above a size threshold; per-org semaphore; task-budget ceiling on repair calls |
| `sourceQuote` hallucination | Spot-verified against PDF text layer; mismatches lower `extractionConfidence` and set `needs_review` |
| Usage tracking gaps during migration | `tracked.ts` is written and tested first; a call site cannot reach the API except through it |

## 6. Sequencing (feeds the implementation plan)

1. `services/ai/` client + tracked wrapper + models map (+ tests)
2. Extraction schema + normalization module (+ tests)
3. New PDF/Excel extraction engine behind `EXTRACTION_ENGINE` flag
4. Repair-call path + validator integration
5. Bake-off harness + run on real documents
6. Migrate remaining call sites to the new client
7. Flip flag → soak → delete legacy + prune dependencies
