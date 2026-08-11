# LangSmith Tracing

This repo ships first-class LangSmith tracing for every LLM call across the
backend. When enabled, you get a complete observability layer over the AI
features without changing a single call site — agents and pipelines auto-trace
through LangChain, and the raw Anthropic / OpenAI SDK singletons are wrapped
once with `langsmith/wrappers`.

## 1. What you get

A trace tree of every LLM call: each agent run, every tool invocation, every
nested model call, with full input + output text, latency, token counts, and
cost per call. Filter by feature (deal chat, memo gen, financial extraction,
etc.), by tag, or by deal id when metadata is attached. Replay any prompt with
edits in the LangSmith UI to compare versions before shipping changes. Trace
retention and project ownership live entirely in your LangSmith account — the
app just emits.

## 2. How to enable

1. Sign in (or sign up) at <https://smith.langchain.com>. Create an
   organization if you don't have one.
2. Go to **Settings → API Keys**, click **Create API Key**, name it
   (e.g. `dealstack-server`), copy the key — it starts with `lsv2_pt_…`. You
   only see it once.
3. Add the four env vars below. The placeholder format matches
   `apps/api/.env.example`:

   ```
   LANGSMITH_TRACING=true
   LANGSMITH_ENDPOINT=https://api.smith.langchain.com
   LANGSMITH_API_KEY=lsv2_pt_<paste-from-langsmith-dashboard>
   LANGSMITH_PROJECT=dealstack
   ```

   - **Local**: paste into `apps/api/.env` (gitignored). Restart the API
     process so dotenv picks up the new values.
   - **Vercel**: project **Settings → Environment Variables**. Add each
     variable for both **Preview** and **Production** scopes (and **Development**
     if you use `vercel dev`). Use the same project name across scopes unless
     you specifically want preview traffic in a separate bucket.
4. Redeploy. Vercel triggers a redeploy automatically on the next push;
   otherwise hit **Deployments → ⋯ → Redeploy** for the existing build.
5. Run any AI feature — deal chat, memo generation, financial extraction,
   email drafter, meeting prep, etc.
6. Open `https://smith.langchain.com/o/<your-org>/projects/p/dealstack` and
   watch traces appear (usually within a few seconds of the call completing).

If `LANGSMITH_PROJECT` doesn't exist yet, the first trace creates it.

## 3. What gets traced (and what doesn't)

Tracing is split across two mechanisms. Both gate on `LANGSMITH_TRACING=true`,
so when the env var is unset or `false` everything is a zero-overhead no-op.

### Auto-traced (LangChain / LangGraph)

These call sites construct chat models or graphs through `services/llm.ts`
(`getModel`, `getChatModel`, `getFastModel`, `getExtractionModel`,
`invokeStructured`) or `@langchain/langgraph`. LangChain's built-in tracer
hooks pick them up automatically when `LANGSMITH_TRACING=true`, with no code
change required.

| Feature | Entry point |
|---|---|
| Deal chat ReAct agent | `apps/api/src/services/agents/dealChatAgent/index.ts` |
| Memo agent + pipeline | `apps/api/src/services/agents/memoAgent/{index,pipeline}.ts` |
| Financial extraction LangGraph | `apps/api/src/services/agents/financialAgent/graph.ts` |
| Firm research LangGraph | `apps/api/src/services/agents/firmResearchAgent/graph.ts` |
| Email drafter LangGraph | `apps/api/src/services/agents/emailDrafter/index.ts` |
| Meeting prep | `apps/api/src/services/agents/meetingPrep/index.ts` |
| Signal monitor LangGraph | `apps/api/src/services/agents/signalMonitor/index.ts` |
| Contact enrichment LangGraph | `apps/api/src/services/agents/contactEnrichment/index.ts` |
| AI deal extractor | `apps/api/src/services/aiExtractor.ts` |
| Memo metadata suggester | `apps/api/src/routes/memos-suggest.ts` |
| Embeddings (Gemini) | `apps/api/src/rag.ts` (`GoogleGenerativeAIEmbeddings`) |

### Wrapped via `langsmith/wrappers` (raw SDK calls)

A handful of features call the Anthropic or OpenAI SDK directly instead of
going through LangChain. We wrap the SDK singletons once at construction so
every downstream call traces. The wrap is conditional on
`LANGSMITH_TRACING=true` — when off, the export points at the raw SDK with
zero overhead.

| Singleton | File | Used by |
|---|---|---|
| `anthropic` (`wrapSDK`) | `apps/api/src/services/anthropic.ts` | `financialAgent/nodes/crossVerifyNode.ts` (Claude cross-verification) |
| `openai` + `openaiDirect` (`wrapOpenAI`) | `apps/api/src/openai.ts` | `financialAgent/nodes/{verifyNode,selfCorrectNode}.ts`, `services/{narrativeInsights,multiDocAnalyzer,visionExtractor,folderInsightsGenerator,financialClassifier}.ts`, `routes/{chat,memos-chat,ai}.ts`, plus any other call site that imports `openai` / `openaiDirect` from `apps/api/src/openai.ts` |

Because the wrap happens at the singleton, anything that imports those
singletons (including `trackedChatCompletion`, `trackedDirectChatCompletion`,
`trackedDirectResponsesCreate` and any future ones) traces with no change.

### Not traced

- **`services/companyResearcher.ts`** — pure HTTP scraper, no LLM calls.
  Listed here so you don't go looking for traces from it.
- **Direct fetch to LLM REST APIs** — none currently in the codebase. If
  you add one, route it through a wrapped singleton (`openai` /
  `openaiDirect` / `anthropic`) or convert to LangChain so it traces.
- **Gemini outside `@langchain/google-genai`** — none currently. The only
  Gemini usage is `ChatGoogleGenerativeAI` in `services/llm.ts` and
  `GoogleGenerativeAIEmbeddings` in `rag.ts`, both auto-traced.

If you see a feature that should be on this list but isn't, grep for direct
SDK usage:

```bash
grep -rn "new OpenAI\|new Anthropic\|new GoogleGenerativeAI" apps/api/src
```

Anything constructing its own client outside the singletons will bypass
tracing and needs to be either rerouted or wrapped.

## 4. Reading a trace

1. Open your project at `https://smith.langchain.com/o/<your-org>/projects/p/dealstack`.
2. The default view is a list of runs sorted newest-first. Each row shows
   the run name, status, total latency, total tokens, and total cost.
3. Click a run to expand the full tree. Every agent step, tool call, and
   nested LLM call is its own node. Multi-step LangGraph runs (financial
   agent, email drafter, etc.) show one node per graph node.
4. Each node panel includes:
   - **Inputs** — the exact prompt, messages, or graph state in.
   - **Outputs** — the model's raw response or the node's return value.
   - **Latency** — wall-clock for that node only.
   - **Tokens** — prompt / completion / total.
   - **Cost** — derived from the model's pricing table.
   - **Errors** — stack trace and the call that produced it.
5. Use the search box for free-text matching across inputs / outputs, or
   the filter bar for tags, model, status, or metadata keys (deal id, user
   id, org id when you've attached them).
6. **Replay**: click the **Playground** button on any LLM node to load the
   prompt, tweak it, and re-run against any model in your LangSmith config.
   Useful for iterating on prompts without redeploying.

## 5. Cost

LangSmith pricing as quoted in the rollout brief (verify on
<https://smith.langchain.com/pricing> before billing decisions — pricing
moves):

- **Free tier**: ~5K traces / month, 1 user.
- **Plus / paid**: ~$39 / mo for ~100K traces.
- **Enterprise**: custom.

Rough trace cost per feature:

- Financial extraction: ~8–15 traces per run (one per LangGraph node plus
  sub-LLM calls inside `verifyNode` / `crossVerifyNode` / `selfCorrectNode`).
- Memo generation: ~12 traces (pipeline steps + ReAct tool loops).
- Deal chat: ~3–10 traces depending on tool-call depth.
- Memo metadata suggester (`memos-suggest.ts`): 1 trace.
- Email drafter / meeting prep / signal monitor / contact enrichment:
  ~3–8 traces each.
- AI extractor: 1–2 traces (model + structured fallback if used).

A busy day of internal testing — say, 50 deal-chat threads + 10 memo
runs + 20 financial extractions — burns ~500–1000 traces. Multiply by
10–20× for production traffic.

## 6. Privacy

Traces capture **full input and output text**: deal records, extracted
financial line items, customer / portfolio company names, IC memo drafts,
contact information, email bodies, document chunks pulled into the RAG
context. Anyone with access to your LangSmith project sees that data
verbatim.

Treat the LangSmith project like a production database for purposes of
access control:

- Restrict membership to your team. Configure at LangSmith **Settings → Team**
  (per-org and per-workspace).
- Use a separate project (`LANGSMITH_PROJECT=dealstack-preview`) for
  Vercel preview deployments if you don't want preview traffic mixed in
  with production.
- Do **not** share traces externally — Slack, screenshots, support tickets —
  without redacting customer identifiers and financials. Linking a trace
  URL exposes everything in it to the recipient (if they're a project
  member) or 403s them (if they're not).
- For especially sensitive runs, consider gating tracing on a per-org basis
  in code (currently it's all-or-nothing via the env var).

## 7. Disabling

Set `LANGSMITH_TRACING=false` (or unset it) and redeploy. Three things happen:

1. The conditional wraps in `apps/api/src/services/anthropic.ts` and
   `apps/api/src/openai.ts` short-circuit and export the raw SDK clients
   directly. Zero proxy overhead.
2. LangChain's built-in tracer keys off the same env var, so all
   auto-traced agents stop emitting too.
3. No traces are sent. Your LangSmith dashboard goes idle until you
   re-enable.

You can also leave `LANGSMITH_TRACING=true` and rotate the API key in
LangSmith if you need an immediate cut-off without a redeploy — the next
emit will fail authentication and the wrappers will swallow the error
without affecting the user's request. (LangSmith uploads are async.)

## 8. Troubleshooting

**"I don't see any traces."**

- Confirm `LANGSMITH_TRACING=true` is set in the **same environment** you
  ran the feature in. Local `.env` is separate from Vercel; Vercel Preview
  is separate from Production. A common miss is setting only Production.
- Confirm the API key is valid: paste it into a curl call against
  `${LANGSMITH_ENDPOINT}/info` with `x-api-key: <key>` and check for 200.
- Confirm `LANGSMITH_PROJECT` matches what you're looking at in the UI
  (case-sensitive).
- Hit the feature again and wait ~30 seconds. Uploads are async; a single
  call doesn't always show instantly.

**"Traces appear in the wrong project."**

- `LANGSMITH_PROJECT` typo, or different value across Preview vs
  Production scopes in Vercel. Check the env var per scope.
- If you renamed the project after first emission, old traces stay in the
  old project — LangSmith doesn't migrate retroactively.

**"Some calls aren't traced."**

- Find direct SDK usage that bypasses the wrapped singletons:

  ```bash
  grep -rn "new OpenAI\|new Anthropic\|new GoogleGenerativeAI" apps/api/src
  grep -rn "from 'openai'\|from '@anthropic-ai/sdk'" apps/api/src \
    | grep -v "src/openai.ts\|services/anthropic.ts"
  ```
- Either reroute through `openai` / `openaiDirect` / `anthropic` from the
  wrapped singletons, or migrate to LangChain so it auto-traces.

**"Function timeout includes LangSmith uploads."**

- LangSmith uploads are async and non-blocking — they don't extend the
  user-facing response. If you're seeing timeouts, check Vercel function
  logs for the actual cause (cold start, slow tool call, etc.). Upload
  failures log silently and don't surface to the request.

**"Quota exceeded / billing alert."**

- You're past the free-tier 5K cap. Upgrade in LangSmith billing, or set
  `LANGSMITH_TRACING=false` in Production while you sort it out and keep
  it on in Preview / local for ongoing debugging.

## 9. Smoke test

After enabling tracing and redeploying, confirm it's live in under a minute:

1. Open the deal chat for any deal, ask a question that triggers a memo
   suggestion (or hit `/memo-builder?dealId=<id>&fromChat=1` directly).
   That fires the `memos-suggest.ts` LLM call, which is small + fast.
2. Within ~30 seconds, refresh
   `https://smith.langchain.com/o/<your-org>/projects/p/dealstack`.
3. A new trace should appear — typically named after the LangChain
   runnable (`ChatOpenAI`, `runDealChatAgent`, etc.) or the wrapper
   (`anthropic-sdk`, `openai-sdk`).
4. Click it. You should see the input prompt, the model output, the
   model name, latency, and token usage.

If nothing appears within 5 minutes, work through the troubleshooting
list above — most often it's an env var scoped to the wrong environment
or a typo in `LANGSMITH_PROJECT`.
