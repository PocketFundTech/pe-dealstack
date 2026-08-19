# AI Agents

> Eight agents power every AI feature in Avise. They live in [`apps/api/src/services/agents/`](../../apps/api/src/services/agents/) and all route through the unified LLM client at [`services/llm.ts`](../../apps/api/src/services/llm.ts).

Big picture: [`docs/diagrams/12-ai-agents-architecture.mmd`](../diagrams/12-ai-agents-architecture.mmd).

## The LLM layer

Every agent calls one of these helpers — never `new OpenAI()` directly:

| Function | Default model | Use when |
| --- | --- | --- |
| `getChatModel(temp?, maxTokens?)` | `gpt-4o` | Reasoning, conversations, complex synthesis |
| `getFastModel()` | `gpt-4o-mini` | Verification, classification, anything where cost > quality |
| `getExtractionModel()` | `gpt-4o` | Structured-JSON extraction (financial values, fields) |

`LLM_CHAT_PROVIDER=gemini` swaps the chat model to Gemini. `ANTHROPIC_API_KEY` enables Claude as a fallback. Always check `isLLMAvailable()` before invoking — a missing API key returns a graceful "AI service unavailable" string instead of crashing.

Shared guardrails live in [`agents/guardrails.ts`](../../apps/api/src/services/agents/guardrails.ts) and are appended to every system prompt.

---

## 1 · Financial Agent

LangGraph state machine that extracts financial statements from documents.

**Entry:** `runFinancialAgent()` in [`agents/financialAgent/index.ts`](../../apps/api/src/services/agents/financialAgent/index.ts)
**Graph:** [`agents/financialAgent/graph.ts`](../../apps/api/src/services/agents/financialAgent/graph.ts)

```
START → extract → verify → cross_verify → validate ──→ store → END
                                              │            ↑
                                              └→ self_correct ┘
                                                 (loops back to validate, max 3 retries)
```

| Node | What it does |
| --- | --- |
| `extract` | 3-layer fallback: Azure DI → pdf-parse + GPT-4o classifier → GPT-4o Vision. Excel goes through `excelFinancialExtractor.ts` (sheet scoring → CSV → classifier). |
| `verify` | Two-pass GPT-4o-mini comparing extracted values to source text (~15K chars). Catches unit-scale errors, transposed digits, wrong row mapping. Best-effort — pipeline continues on failure. ~$0.003/run. |
| `cross_verify` | Cross-statement consistency (e.g. Net Income flows into Cash Flow). Best-effort. |
| `validate` | Range and accounting checks on extracted values. Decides whether to self-correct or store. |
| `self_correct` | Targeted GPT-4o re-extraction of only failing statements/periods. Merges corrections. Loops back to `validate`. Max 3 retries. |
| `store` | Persists to `FinancialStatement`. Handles multi-document merge logic (`isActive`, `mergeStatus`). |

Append-only `steps[]` log on the agent state powers the **Agent Log** UI tab. Response shape:

```ts
{
  result: { ... },         // backwards-compatible payload
  agent: {
    status: 'storing' | 'self_correcting' | 'failed',
    retryCount: number,
    validationResult: { ... },
    steps: [{ node, ts, ... }],
    error?: string
  }
}
```

Reach via `POST /api/financials/extract`.

Detail: [`docs/diagrams/11-financial-extraction-pipeline.mmd`](../diagrams/11-financial-extraction-pipeline.mmd).

---

## 2 · Deal Chat Agent

ReAct agent powering the conversational chat tab on the deal page. Built with `createReactAgent()` from `@langchain/langgraph/prebuilt`.

**Entry:** `runDealChatAgent()` in [`agents/dealChatAgent/index.ts`](../../apps/api/src/services/agents/dealChatAgent/index.ts)
**Tools:** [`agents/dealChatAgent/tools.ts`](../../apps/api/src/services/agents/dealChatAgent/tools.ts)

The agent ships with **14 closure-bound tools** — each tool already knows the current `dealId` and `orgId`, so the LLM only passes query-specific args. This stops the model from accidentally crossing org boundaries.

| Group | Tool | Purpose |
| --- | --- | --- |
| Read | `search_documents` | Full-text VDR search |
| Read | `get_deal_financials` | All statements (active + inactive) |
| Read | `compare_deals` | Cross-deal portfolio comparison |
| Read | `get_deal_activity` | Timeline feed |
| Read | `get_analysis_summary` | QoE + ratios + red flags |
| Read | `list_documents` | Document inventory |
| Write | `update_deal_field` | Modify deal properties (revenue, EBITDA, priority, lead, …) |
| Write | `change_deal_stage` | Pipeline transitions |
| Write | `add_note` | Log note / call / meeting / email |
| Trigger | `trigger_financial_extraction` | Kick off Financial Agent |
| Trigger | `generate_meeting_prep` | Run Meeting Prep agent |
| Trigger | `draft_email` | Run Email Drafter agent |
| UI | `scroll_to_section` | Side-effect: scrolls UI to financials/analysis/activity/etc |
| UI | `suggest_action` | Structured "create memo / open data room / upload doc" action |

The system prompt forces a **financial data protocol** — when the deal context already contains "VERIFIED FINANCIAL DATA" tables, the agent must quote exact numbers and show its work, never guess. See [`19-deal-chat-react-agent.mmd`](../diagrams/19-deal-chat-react-agent.mmd) for the full sequence.

Reach via `POST /api/deals/:id/chat`. Response includes `updates`, `action`, and `sideEffects` arrays for the frontend to apply.

---

## 3 · Memo Agent

Section-by-section IC memo generation.

**Entry:** [`agents/memoAgent/index.ts`](../../apps/api/src/services/agents/memoAgent/index.ts)
**Pipeline:** [`agents/memoAgent/pipeline.ts`](../../apps/api/src/services/agents/memoAgent/pipeline.ts)
**Context:** [`agents/memoAgent/context.ts`](../../apps/api/src/services/agents/memoAgent/context.ts) — pulls deal data, financial statements, recent documents
**Prompts:** [`agents/memoAgent/prompts.ts`](../../apps/api/src/services/agents/memoAgent/prompts.ts) — one prompt per of 12 section types
**Tools:** [`agents/memoAgent/tools.ts`](../../apps/api/src/services/agents/memoAgent/tools.ts) — section-specific helpers

Reach via `POST /api/memos/:id/sections/:sectionId/generate`. Rate-limited as AI (10/min).

---

## 4 · Firm Research Agent

Onboarding firm enrichment + deep research. LangGraph 6-node graph + Phase-2 background agent.

**Entry:** [`agents/firmResearchAgent/index.ts`](../../apps/api/src/services/agents/firmResearchAgent/index.ts)
**Deep research:** [`agents/firmResearchAgent/deepResearch.ts`](../../apps/api/src/services/agents/firmResearchAgent/deepResearch.ts)

**Phase 1 (≤ 60s, sync):** scrape → search_firm → search_person → synthesize → verify → save.

- Web search: [`services/webSearch.ts`](../../apps/api/src/services/webSearch.ts) — Apify Google Search primary, DDG Lite fallback.
- LinkedIn: `scrapeLinkedInProfile()` for direct profile data.
- URL safety: [`utils/urlHelpers.ts`](../../apps/api/src/utils/urlHelpers.ts) validates LinkedIn (incl. country subdomains), prevents SSRF.

**Phase 2 (60–120s, async background):** GPT-4o derives 8–12 follow-up queries, recurses on top results, merges into `FirmProfile.deepResearch`.

**Storage:**

- `Organization.settings.firmProfile` (JSONB)
- `User.onboardingStatus.personProfile` (JSONB)

**Guardrails:** rate limit 3/hour/org, concurrent lock per org, 60s Phase 1 timeout, 120s Phase 2 timeout, SSRF prevention, no PII surfaced, per-field confidence scoring.

Triggered from onboarding step 1 (`POST /api/onboarding/enrich-firm`) and from Settings → Firm Profile → Refresh. Frontend polls `GET /api/onboarding/research-status` for Phase 2 completion.

Detail: [`docs/diagrams/15-firm-research-agent.mmd`](../diagrams/15-firm-research-agent.mmd).

---

## 5 · Contact Enrichment

4-node graph that fills out contact records.

**Entry:** [`agents/contactEnrichment/index.ts`](../../apps/api/src/services/agents/contactEnrichment/index.ts)

`research → validate → save | review`

The validate node applies **input-sparsity confidence caps**:

- Name only — max 30%
- Name + email — max 50%
- Name + email + company — full range

Low-confidence enrichments hit `review` and surface in the UI rather than silently writing.

Reach via `POST /api/ai/enrich-contact`.

---

## 6 · Meeting Prep

Parallel fetcher that builds a meeting brief.

**Entry:** [`agents/meetingPrep/index.ts`](../../apps/api/src/services/agents/meetingPrep/index.ts)

Fans out to 5 sources in parallel: deal info, financial statements, activity timeline, contacts, company research. Joins back into a single LLM call that produces talking points, suggested questions, risks, and an agenda.

Reach via `POST /api/ai/meeting-prep` or via the Deal Chat tool `generate_meeting_prep`.

---

## 7 · Signal Monitor

Portfolio risk-scan agent. 3-node graph.

**Entry:** [`agents/signalMonitor/index.ts`](../../apps/api/src/services/agents/signalMonitor/index.ts)

`fetchPortfolio → analyzeSignals (8 signal types) → routeSignals (severity)`

Severity buckets: `critical`, `warning`, `info`. Critical signals fire notifications.

Reach via `POST /api/ai/scan-signals`. Surfaced as the "Scan Signals" widget on the dashboard.

---

## 8 · Email Drafter

4-node graph for drafting deal-related emails.

**Entry:** [`agents/emailDrafter/index.ts`](../../apps/api/src/services/agents/emailDrafter/index.ts)

`writeDraft (7 templates) → toneCheck (5 tones) → complianceCheck (PE rules) → finalize`

Final state: `ready_for_review` or `compliance_issues`. The compliance node enforces PE-specific rules around forward-looking statements, MNPI, and selective disclosure.

Reach via `POST /api/ai/draft-email` or via the Deal Chat tool `draft_email`.

---

## AI usage tracking

Every LLM call made through `getChatModel()`, `getFastModel()`, `getExtractionModel()`, or `invokeStructured()` — including every step inside LangGraph ReAct loops — produces a `UsageEvent` row attributed to the calling User and Organization. The same applies to Apify, Azure DocIntel, and Gemini embedding calls. This means each agent tool invocation in a ReAct loop generates its own event (one row per LLM step, not one per agent run).

When building a new agent, pass an `operation` label as the third argument to `getChatModel` / `getFastModel`. This label maps to a credits value in the `OperationCredits` table and appears in the user-facing Settings panel. Do not call `new ChatOpenAI()` directly — callbacks are only attached when going through the factory functions.

Full details: [`docs/AI-USAGE-TRACKING.md`](../AI-USAGE-TRACKING.md).

---

## Adding a new agent

Pattern that has worked for us:

1. Create `services/agents/<name>/`.
2. `state.ts` — annotated state schema (LangGraph `Annotation`).
3. `nodes/` — one file per node, exporting an async function.
4. `graph.ts` — wire nodes with edges; export a `getXxxGraph()` singleton that lazily compiles.
5. `index.ts` — public entrypoint that builds initial state and `invoke()`s the graph.
6. Use `getChatModel()` / `getFastModel()` from `services/llm.ts`.
7. Append every node action to a `steps[]` array on state — that's how the UI shows agent progress.
8. Add a test in `apps/api/tests/`.

Always log via `services/utils/logger.ts` (`log.info / warn / error`) — the request ID is auto-tagged.
