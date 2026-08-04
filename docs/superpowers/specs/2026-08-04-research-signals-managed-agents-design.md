# Phase 2-B — Research & Signals on Managed Agents: Design Spec

**Date:** 2026-08-04
**Status:** Draft for review
**Scope:** Replace the firm-research LangGraph agent (both the synchronous "fast pass" and the fire-and-forget "deep pass") and the on-demand signal-monitor LangGraph agent with two Anthropic Managed Agents. Builds on the Phase 1 AI core swap (`services/ai/client.ts`, `models.ts`, PR #87, not yet merged). Deal chat streaming (Phase 2-A) and rubric-graded memos (Phase 2-C) are separate sub-projects, out of scope here.

---

## 1. Problem (from codebase research, 2026-08-04)

- **Firm research is split across two disconnected mechanisms.** `POST /api/onboarding/enrich-firm` runs a fast synchronous pass, then kicks off `runDeepResearch()` (`firmResearchAgent/deepResearch.ts:46`) via `void runWithUsageContext(...)` in `onboarding.ts:355` — fire-and-forget on a Vercel serverless function. If the function freezes after the HTTP response is sent, the deep pass dies silently with no error surfaced anywhere; the only mitigation today is `markStaleDeepResearchAsFailed`, a staleness-detection band-aid that notices the symptom, not the cause.
- **Web search runs through Apify** (`webSearch.ts`), a paid third-party service, for both the fast and deep research passes — an external dependency and cost center that Managed Agents' native `web_search`/`web_fetch` tools can absorb directly.
- **Signal monitoring (`signalMonitor/index.ts`) is a separate 3-node StateGraph**, currently synchronous/on-demand only (`runSignalMonitor(organizationId)`), writing directly to the `Activity` table. It isn't broken today, but it has no nightly/scheduled variant, and it duplicates the same "LLM reasons over deal data, writes structured output" shape as firm research — two bespoke agent implementations for one underlying pattern.
- Both agents are LangGraph StateGraphs maintained in-repo (nodes, edges, state channels) — infrastructure Managed Agents' hosted sandbox replaces wholesale (the agent's reasoning loop, tool calling, and retry/refusal handling move server-side).

## 2. Goals

1. One Managed Agent (**Firm Research Agent**) replaces both the fast-pass and deep-pass firm research code as a single continuous session — no more artificial phase split.
2. One Managed Agent (**Signal Monitor Agent**) replaces `signalMonitor/index.ts`, callable both on-demand (as today) and on a nightly schedule (new).
3. Firm research runs fully async from the moment `enrich-firm` is called — no blocking wait, ever (already true for the deep pass; now also true for the fast pass, which currently blocks the request).
4. Nightly signal scanning runs as an **isolated Managed Agents session per organization** — never a shared multi-tenant session — preserving this codebase's existing org-isolation discipline.
5. Apify web search is fully retired from both agents in favor of the built-in `agent_toolset_20260401` (`web_search`, `web_fetch`).
6. No Anthropic-side credential ever reaches Supabase — every DB read/write from either agent goes through a custom tool implemented and org-scoped in our own backend.
7. Both agents ship behind independent flags, default off, with the legacy StateGraph code path fully intact until each is soaked.

## Non-goals (Phase 2-B)

- Deal chat streaming (Phase 2-A) and rubric-graded memos (Phase 2-C) — separate specs.
- Any visual/UX redesign of onboarding beyond removing the fast-pass's blocking wait; the existing polling UI (reads `Organization.settings.firmProfile`) is reused, not redesigned.
- Migrating any other LangGraph agent (`financialAgent`'s graph shape, the deal chat agent) — untouched.
- Retiring Apify for anything outside these two agents (e.g. `scrapeLinkedInProfile` stays as-is if still used elsewhere — verify at implementation time whether it has other callers before deleting).

---

## 3. Design

### 3.1 Provisioning — Agent / Environment (version-controlled, not created inline)

Two Managed Agents, each with its own persisted Agent config and `cloud` Environment, both provisioned via the `ant` CLI from YAML checked into the repo (`apps/api/managed-agents/`) — not created ad hoc in request-handling code:

- **Firm Research Agent** — tools: `agent_toolset_20260401` (`web_search`, `web_fetch`) + custom tool `save_firm_profile`.
- **Signal Monitor Agent** — tools: `agent_toolset_20260401` (for signal research where useful) + custom tools `list_deals_for_org`, `create_signal_notification`.

Custom tools are client-executed (Pattern 9): the agent emits a tool-call event over SSE, our backend executes it against Supabase with normal org-scoped queries, and returns the result — the agent's sandbox never holds a DB credential.

### 3.2 Firm Research Agent flow

`POST /api/onboarding/enrich-firm` creates a Managed Agents session immediately and returns `202 Accepted` — no blocking wait, matching the deep-pass's existing async shape but now applied to the whole research flow, not just phase 2. A DB-side lock (new boolean/timestamp field on `Organization`, replacing today's implicit "deep research already running" check) rejects a second `enrich-firm` call while a session is active for that org, preventing duplicate concurrent sessions — Managed Agents itself does not deduplicate this for us.

The agent researches the firm progressively and calls `save_firm_profile` each time it learns something material, writing straight into `Organization.settings.firmProfile` — the same field the frontend's `GET /api/onboarding/research-status` already polls today. The onboarding UI needs no redesign: instead of one "phase 2 complete" flip, it now sees more frequent incremental updates as the single session progresses. `researchStatus` (new: `'running' | 'completed' | 'failed'`) is set on the same object so the frontend can distinguish "still working" from "session errored" — today a dead deep-pass just leaves the UI polling forever with no failure state to show.

### 3.3 Signal Monitor Agent flow

Two entry points into the same agent:

1. **On-demand** (today's behavior, unchanged in effect): a request handler creates a session for one org and waits for the result, replacing `runSignalMonitor(organizationId)`.
2. **Nightly** (new): a Vercel Cron job fans out — for each active org, it creates one isolated Managed Agents session (not one shared session iterating multiple orgs). This preserves the same tenant-isolation guarantee the rest of the codebase enforces, and means one org's failure or slow session can never block or delay another's.

In both cases the agent calls `list_deals_for_org`, reasons about signals the way `analyzeSignalsNode`'s prompt does today, then calls `create_signal_notification` per flagged deal — replacing the direct Supabase writes `routeSignalsNode` performs today with an org-scoped custom-tool call.

**Fan-out volume:** session-create is rate-limited at the account level; the nightly cron stages session creation (small concurrency batches, not all-orgs-at-once) so the burst stays well under that ceiling regardless of org count at launch.

### 3.4 Error handling, concurrency, and cost tracking

- **Firm research failure:** a session's terminal `session.status_terminated` (or a `session.error` event) is caught via webhook and written into `Organization.settings.firmProfile.researchStatus = 'failed'`, so the frontend can offer a retry instead of polling indefinitely — a structural fix, not another staleness-timeout band-aid.
- **Signal monitor failure (nightly):** an unattended background job — failures are handled via webhook, logged, and Sentry-captured per org; never block other orgs' sessions (isolation is what makes this safe by construction).
- **Concurrency lock:** the `Organization`-level lock described in 3.2 is the sole guard against duplicate concurrent firm-research sessions; nightly signal sessions don't need an equivalent lock since each night's fan-out is a fresh, independent run per org.
- **Cost tracking:** each session's `span.model_request_end` events carry token usage, fed into the existing `UsageEvent` ledger (same table/attribution model the rest of the product uses) so Managed Agents spend shows up in `/internal/usage` alongside everything else — no separate cost-tracking path.

### 3.5 Rollout

- `RESEARCH_ENGINE=legacy|managed-agents` and `SIGNAL_ENGINE=legacy|managed-agents`, both independent, both default `legacy` — mirrors Phase 1's `EXTRACTION_ENGINE` pattern.
- Legacy code (`deepResearch.ts`, `deepResearchQueries.ts`, `deepResearchSynthesis.ts`, `deepResearchProgress.ts`, the firm-research `graph.ts`/`nodes/`, `signalMonitor/index.ts`, and the Apify code paths in `webSearch.ts` — `scrapeLinkedInProfile` only if confirmed unused elsewhere) is deleted only after each flag has soaked in production for two weeks, matching Phase 1's soak policy.
- New operator prerequisite: confirm this Anthropic org has Managed Agents access before either flag is flipped anywhere — it is a beta surface, distinct from the ≥30-day data retention check Phase 1 already requires for Fable 5.

## 4. Testing

- **Custom tools** (`save_firm_profile`, `list_deals_for_org`, `create_signal_notification`) are plain org-scoped backend functions — unit-tested directly, no mocking needed beyond the DB layer already used elsewhere in the codebase.
- **Orchestration code** (session creation, webhook handlers, event-stream consumption, the concurrency lock) is tested against a mocked Managed Agents SDK, the same approach Phase 1 used for the mocked Anthropic client.
- **Manual verification** (not a repeatable bake-off — this replaces broken infrastructure, not an accuracy-sensitive pipeline with a legacy baseline to compare against): provision the real Agent + Environment via the `ant` CLI, run one real session per agent against a test org, confirm `Organization.settings.firmProfile` populates progressively and at least one signal notification gets created end-to-end.
- Existing suites unaffected by this change (financial extraction, org-isolation, agent-bounds) stay green — they don't touch these two agents.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Duplicate concurrent firm-research sessions for one org | `Organization`-level lock in 3.2, checked before session creation |
| Nightly fan-out burst exceeds session-create rate limits | Staged/batched session creation, not all-orgs-at-once (3.3) |
| A session dies with no visible failure state (today's actual bug) | Webhook-driven `researchStatus`/logging replaces silent staleness, not another timeout guess |
| Managed Agents access not yet enabled for this Anthropic org | Called out as an explicit rollout prerequisite (3.5), checked before either flag flips |
| Custom tool becomes a de facto unscoped DB backdoor if implemented carelessly | Every custom tool handler must apply the same org-scoping the REST routes already enforce — code review gate, not a new mechanism |

## 6. Sequencing (feeds the implementation plan)

1. Provision both Agents + Environments as version-controlled YAML (`apps/api/managed-agents/`) + `ant` CLI setup docs.
2. Custom tools: `save_firm_profile`, `list_deals_for_org`, `create_signal_notification` (+ unit tests).
3. Firm Research Agent orchestration: session creation on `enrich-firm`, concurrency lock, webhook → `researchStatus` handling (+ mocked-SDK tests).
4. Signal Monitor Agent orchestration: on-demand entry point (+ tests).
5. Nightly Vercel Cron fan-out for Signal Monitor Agent, staged session creation (+ tests).
6. `UsageEvent` wiring for Managed Agents session cost.
7. Manual end-to-end verification against a real test org for both agents.
8. Flip `RESEARCH_ENGINE` → soak two weeks. Flip `SIGNAL_ENGINE` → soak two weeks (independent timing, can overlap).
9. Delete legacy code + Apify web-search paths per 3.5.
