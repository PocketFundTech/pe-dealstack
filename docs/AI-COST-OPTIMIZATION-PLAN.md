# AI cost optimization plan

Written 11 Oct 2026. A work list for cutting AI token spend across Avise, one item at a time. Each item says what to change, where, why, and how to check it worked. Line numbers are as of `main` at `ddec3f0c`.

**Status (14 Oct 2026): all code items implemented in one PR (`feat/ai-cost-plan-220`), built from the per-item PRs #229–#240.** Still open: the two account blockers and H5 (founder, no code). C2 is not possible without lowering the critique's effort (see C2). Testing also found and fixed: the Claude deal reader's schema was over the API's union-type limit, so every upload's Haiku read failed (#240); duplicate-confirm uploads lost their deal tag (H4); phantom 'blocked' ledger rows on Excel container extractions (H2).

---

## 1. Where things stand

### Rules already decided (don't relitigate)

- **Fable 5 only reads spreadsheets.** Financial statements (P&L, balance sheet, cash flow) live only in Excel/CSV files, never PDFs. Fable 5 runs on Excel/CSV through the *Extract financials* button; PDFs never go to it. Founder decision, 6 Oct. Fable extraction quality must not drop.
- **AI runs only when a user asks.** Upload runs the cheap deal summary (Haiku) and search indexing; everything else is a button. Crons, webhooks and scheduled syncs skip their AI step unless `AI_BACKGROUND_JOBS=on` (off by default). Shared gate: `apps/api/src/services/usage/aiOnDemand.ts` (`canRunAiNow`, `isBackgroundAiEnabled`). PRs #206, #207, #214.
- **Model tiering done so far** (PRs #199, #202): deal summary on Haiku, data-room field fill on Haiku, teasers on Haiku, reply tagging and outreach clean-up on Haiku, chat and memo drafting on Sonnet 5 at `effort: medium` (env `AI_CHAT_EFFORT` / `AI_MEMO_EFFORT` revert to high), NDA review and memo critique pinned to high.

### Blockers: nothing runs right now

These have to be fixed before any saving below can be measured.

- [ ] **Anthropic key is not scoped to a workspace.** Since the 8 Oct key rotation every Claude call fails with *"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"*. Fix: in the Anthropic Console, create the key inside a workspace (Settings → Workspaces → pick one → API keys), put it in Vercel `ANTHROPIC_API_KEY` (all environments), redeploy. No code change. `ANTHROPIC_API_KEY` is the only credential the AI clients read (`services/anthropic.ts` `resolveAnthropicAuth()`); `ANTHROPIC_OAUTH_TOKEN` is used only when the key is unset, `ANTHROPIC_API_KEY_FALLBACK` is a separate backup account used by the older LangChain path, and `Antropic_api_avise` is unused.
- [ ] **OpenAI is out of credit** (429 "You have no credits remaining", still seen 10 Oct). Every GPT feature fails and the older path falls back to Claude Sonnet 4.6 on the backup key.

### Current cost per deal (estimate)

From `~/Downloads/Avise-AI-Cost-Per-Deal-2026-10-11.pdf` (built from today's code at the prices in the `ModelPrice` table, token sizes from real ledger calls):

| Deal shape | Per deal |
|---|---|
| Screened and passed (upload only) | $0.03 |
| Typical (Excel model, memo, NDA, 20 chat messages, every button once) | **$2.40–5.08** |
| Heavy (2 models, 2 memos, 100 chat messages) | $7.45–16.83 |

The four big items in a typical deal: **deal chat $1.00–2.40**, Fable extraction $0.60–1.50, memo $0.45–0.65, NDA review $0.13. Everything else is under $0.40 combined.

Target after this plan: **typical deal ~$1.40–3.05** (about 40% lower), with deal chat accounting for about half the saving.

### Prices (USD per million tokens, from `ModelPrice`)

| Model | Input | Output |
|---|---|---|
| Claude Fable 5 | 10.00 | 50.00 |
| Claude Sonnet 5 | 2.00 | 10.00 |
| Claude Sonnet 4.6 | 3.00 | 15.00 |
| Claude Haiku 4.5 | 1.00 | 5.00 |
| GPT-4.1 | 2.00 | 8.00 |
| GPT-4.1-mini | 0.40 | 1.60 |
| GPT-4o-mini | 0.15 | 0.60 |

Thinking tokens are billed as output.

---

## 2. Work items, in order

### A. Deal chat (biggest saving)

**Why it is expensive.** The usage ledger has only 4 successful Sonnet 5 deal-chat messages:

| Date | Input tokens | Output | Cost |
|---|---|---|---|
| 18 Aug | 13,917 | 757 | $0.05 |
| 25 Aug | 99,132 | 3,359 | $0.35 |
| 28 Sep | 12,762 | 292 | $0.04 |
| 29 Sep | 12,828 (cache write) | 2,675 | $0.09 |

A plain message costs ~13K input tokens before the question is read. The 25 Aug message ran ~7 tool steps and re-sent the full context on each one. What goes into every request:

| Part | Size | Where |
|---|---|---|
| Full financial statements, every period and line item | 7–13K tokens on real deals (up to 39–77 periods) | `routes/deals-chat-ai.ts:328` `buildFinancialMarkdown(...)`, defined at `:56` |
| System prompt | ~2.5K tokens (10.1K chars) | `services/agents/dealChatAgent/index.ts:48` `buildDealAgentSystemPrompt` |
| 18 tool definitions | ~2.2K tokens | `services/agents/dealChatAgent/tools/` |
| Firm context, **sent twice** | small | route `routes/deals-chat-ai.ts:275` *and* agent `dealChatAgent/index.ts:472` (`getFirmContextBlock`) |
| Last 10 turns of history | grows | `routes/deals-chat-ai.ts:364`, `dealChatAgent/index.ts:~498` (`slice(-10)`) |
| Tool loop | each step re-sends all of the above | limit `DEFAULT_AGENT_RECURSION_LIMIT = 10` at `dealChatAgent/index.ts:27` (env `DEAL_CHAT_AGENT_RECURSION_LIMIT`) |

Caching is marked (`cache_control` on the system blocks plus `autoCache: true`) but the one cached message shows a cache write and no cache read. Follow-ups more than 5 minutes apart miss the cache entirely.

- [x] **A1. Stop sending full financials on every message.** Replace the `buildFinancialMarkdown` block in the deal context with a short summary (latest 3 fiscal years: revenue, EBITDA, margin, growth, units; ~400 tokens). Chat already has `getDealFinancials` (`dealChatAgent/tools/getDealFinancials.ts`) for detail; make the system prompt tell it to call that for line items or other periods. Saves 7–12K tokens per message and per tool step. *Check:* answers to "what was FY24 revenue" and "break down opex for FY23" are still correct (the second should call the tool).
- [x] **A2. Send firm context once.** Drop it from either the route or the agent. *Check:* the request contains one firm block.
- [x] **A3. Cap tool steps and tool output.** Lower the default limit from 10 to about 4 for deal chat, and trim large tool results (document search, financials) before they go back into the conversation. *Check:* no message over ~30K input tokens in the ledger.
- [x] **A4. Make caching hit.** Order the request as tools → system → deal summary (stable) → history → question; use a 1-hour TTL on the stable block so follow-ups after a pause still read cache (`ttl: '1h'` on the explicit marker; the top-level auto marker must then also be 1h or omitted, since a 1h entry can't follow a 5m one). Confirm the stream usage accumulator records `cache_read_input_tokens` per tool step. *Check:* second and later messages in a session show `cacheReadTokens > 0` in `UsageEvent.metadata`.
- [x] **A5. Keep 6 turns of history, not 10.**

Expected: a plain message from ~13K to ~4–5K input tokens (~$0.015); a tool-heavy one from ~99K to ~20–25K. **20 messages: $1.00–2.40 → ~$0.30–0.70.**

### B. Older features still on Sonnet 4.6

`services/llm.ts:323` (`chat`) and `:326` (`extraction`) default the older LangChain path to `claude-sonnet-4-6` ($3/$15). Sonnet 5 is $2/$10 and better.

- [x] **B1. Move the legacy chat/extraction defaults to `claude-sonnet-5`.** Covers contact chat, global AI assistant, email drafter, meeting prep, firm research synthesis, contact enrichment, red-flag/portfolio analysis, deal list import mapping, creating a deal from an email/URL (`services/aiExtractor.ts` via `getExtractionModel`), and the inbox deal scan. Note that legacy usage is recorded under operation names like `deal_analysis` for several of these.
- [x] **B2. Send simple tasks to Haiku 4.5** where quality allows: Gmail contact summary (`services/gmailContactsService.ts`), contact follow-up suggestion (`services/contactFollowUpSuggester.ts`), email drafter tone and compliance checks (`services/agents/emailDrafter/index.ts`).

Expected: 33–65% off each of those features.

### C. Memo (AI Reports)

`services/agents/memoAgent/pipeline.ts`: 12 sections run in batches of `BATCH_SIZE = 3` (`:41`), each with the deal context as a cached block (`:155`). Because a batch starts in parallel, each section in it writes the cache instead of reading it (ledger: 43 section calls, only ~15K cache-read tokens). Recorded cost was ~$0.85 per memo at high effort; the estimate at medium is $0.45–0.65.

- [x] **C1. Warm the cache once per memo** with a `max_tokens: 0` request on the shared prefix before the first batch, then let all sections read it. *Check:* `memo_section_generation` rows show `cacheReadTokens` on 11 of 12 sections.
- [ ] **C2. Let the critique reuse the same cached context** (`memo_critique`, `:494`) instead of resending it uncached. — *Not possible without lowering the critique's effort:* it differs from the sections in system prompt, structured output and effort (high vs medium), each of which invalidates the cache. Left uncached by design; see `critiqueAndRevise`.

Expected: $0.45–0.65 → ~$0.25–0.40.

### D. Inbox deal scan

`services/inboxDealScanService.ts`: up to `MAX_SCAN_EMAILS = 25` (`:41`) emails each go to `extractDealDataFromText` (`:526`, Sonnet 4.6, up to 20K chars each). $0.25–0.75 per scan.

- [x] **D1. Filter first.** Run a cheap "is this a deal email?" check (Haiku 4.5, or reuse `dealEmailClassifier` on GPT-4.1-mini) and only extract the positives.

Expected: ~$0.05–0.15 per scan.

### E. Fable extraction (quality unchanged)

When Fable succeeds, the verify, cross-verify and self-correct steps are already skipped (`services/agents/financialAgent/graph.ts` `routeAfterValidate`; `verifyNode.ts`, `crossVerifyNode.ts` skip Claude output). So the levers are input size and failure handling.

- [x] **E1. Drop non-financial sheets before sending** (cover, notes, charts, assumptions tabs with no numbers). Must not drop any statement tab: test on the Jantar and SRM workbooks.
- [x] **E2. Don't run the backup extraction path when Fable failed on credit or auth.** On 5 Oct, Fable "credit balance too low" fell through to the Sonnet 4.6 / GPT path, which costs $0.20–0.60 per file and also failed or partly ran.

Expected: $0.60–1.50 → ~$0.45–1.20.

### F. NDA review

`services/agents/ndaReview/index.ts:205-207`: `maxTokens: 8000`, `effort: 'high'`. The two real reviews used 16K output tokens between them, so they hit the limit.

- [x] **F1. Keep high effort; cap the answer** (structured output with tighter field limits, ~6K max). Expected $0.13 → ~$0.06. — *Measured: answer ~3.7K tokens but high-effort thinking varies; cap 32K, timeout 240s.*

### G. Broken code paths (cost $0 now, but broken)

- [x] **G1. Claude model name sent to OpenAI.** `MODEL_REASONING` resolves to `claude-sonnet-4-6` when an Anthropic key is set (`utils/aiModels.ts`), but these call the OpenAI client (`openai.ts`, no Claude routing), so they always fail: `routes/memos-chat.ts:151` (memo section AI chat; "Memo chat agent error" in Vercel logs), `routes/chat.ts:347` (old deal chat route), `routes/ai.ts:256` and `:407`. Fix by calling them through `services/ai/client.ts` (`trackedClaudeMessage`, role `chat`) or `getChatModel()`.

### H. Measurement gaps (so savings can be proven)

- [x] **H1. Broker uploads through the document-request portal aren't recorded.** `routes/doc-request-portal.ts:216` calls `handleDocumentUpload` with no usage context, so `recordUsageEvent` logs "no usage context bound, skipping". Seen in Vercel logs on 5 Oct for 3 Jantar spreadsheets (3 successful Sonnet 4.6 calls on the backup key and 3 Gemini embeddings never reached the ledger). Wrap the handler in `runAsOrgSystem(orgId, 'doc-request-portal', ...)`.
- [x] **H2. Keep the error text on failed calls.** 295 Anthropic failures (Aug–Oct) have no `metadata.errorMessage`, mostly Fable extraction.
- [x] **H3. Fix missing prices.** 785 calls on `claude-sonnet-4-5` / `claude-sonnet-4-6` were recorded at $0 or below list price; at list price they add ~$26.44, which puts all-time spend near ~$54 instead of the recorded $27.86. Add the missing `ModelPrice` rows (dated ids too) and backfill. — *Applied to production 11 Oct: 760 rows, +$26.44, ledger now $54.42.*
- [x] **H4. Tag every AI call with its deal.** PR #205 tags background ingest work with `metadata.dealId`. The deal summary read (runs before the deal row exists), deal chat and memo routes are still untagged. Without this, cost per deal stays an estimate.
- [ ] **H5. Set `ANTHROPIC_ADMIN_KEY`** in Vercel so `/api/cron/usage-reconciliation` can compare the ledger with Anthropic's own billing.

---

## 3. How to check spend

- **Live dashboard:** https://claude.ai/artifact/6kHWzZb4EY7nUedvkpei3y (queries `UsageEvent` through the Supabase connector).
- **Reports:** `~/Downloads/Avise-AI-Token-Usage-Report-2026-10-11.pdf` (all-time, every call) and `~/Downloads/Avise-AI-Cost-Per-Deal-2026-10-11.pdf` (cost per feature).
- **Last 7 days (4–11 Oct):** $0.9113 recorded, 200,552 tokens, 45 successful and 200 failed calls; nothing succeeded after 7 Oct.
- **Per-feature query:**

```sql
SELECT operation, model, status, COUNT(*) AS calls,
       SUM("promptTokens") AS input_tokens, SUM("completionTokens") AS output_tokens,
       SUM(COALESCE((metadata->>'cacheReadTokens')::bigint, 0)) AS cache_read,
       ROUND(SUM("costUsd")::numeric, 4) AS cost_usd
FROM "UsageEvent"
WHERE "createdAt" > now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY cost_usd DESC;
```

- **Vercel logs** for calls the ledger missed: `vercel logs --environment production --since 7d --query "no usage context bound" --json` (each result's `logs` field holds every line of that request).

## 4. Suggested order

1. Blockers (Anthropic key, OpenAI credit decision).
2. H1–H4, so the next steps can be measured.
3. A1–A5 (deal chat), then B1–B2, then C1–C2.
4. G1, D1, E1–E2, F1.

After each item, run the per-feature query above on a test deal and record before/after in `PROGRESS.md`.
