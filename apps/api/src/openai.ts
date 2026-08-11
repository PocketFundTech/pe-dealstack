import OpenAI from 'openai';
import dotenv from 'dotenv';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import { traceable } from 'langsmith/traceable';
import { log } from './utils/logger.js';
import { OPENROUTER_BASE_URL, OPENROUTER_HEADERS, isOpenRouterEnabled } from './utils/aiModels.js';
import { recordUsageEvent } from './services/usage/trackedLLM.js';
import { enforceUserGate, UserBlockedError } from './services/usage/enforcement.js';
import { withCircuitBreaker } from './services/aiCircuitBreaker.js';

export { UserBlockedError } from './services/usage/enforcement.js';

dotenv.config();

// ─── max_tokens safety net ─────────────────────────────────────────
//
// Defensive guard so a misconfigured / env-overridden model can never send a
// `max_tokens` above the model's completion cap and 400 (e.g. the production
// error: "max_tokens is too large: 32000. This model supports at most 16384
// completion tokens"). This is a belt-and-suspenders backstop — the primary
// fix is switching model tiers — so we only clamp KNOWN models and otherwise
// leave params untouched.
//
// Keys are matched via substring so OpenRouter-prefixed names (e.g.
// 'openai/gpt-4o') also match. Order matters: check gpt-4.1 BEFORE gpt-4o.
const MODEL_MAX_COMPLETION_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ['gpt-4.1', 32768],
  ['gpt-4o', 16384],
];

function resolveCompletionCap(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const [needle, cap] of MODEL_MAX_COMPLETION_TOKENS) {
    if (model.includes(needle)) return cap;
  }
  return undefined;
}

/**
 * If `params` requests `max_tokens` / `max_completion_tokens` above the resolved
 * completion cap for `model`, returns a shallow-cloned params object with the
 * offending value(s) reduced to the cap. Unknown models (no cap match) and
 * in-range values are returned unchanged (original reference). Never mutates the
 * caller's object.
 */
function clampMaxTokens<T extends Record<string, any>>(
  model: string | undefined,
  params: T,
  operation?: string,
): T {
  const cap = resolveCompletionCap(model);
  if (cap === undefined || !params) return params;

  let clamped: T | undefined;
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    const requested = (params as any)[key];
    if (typeof requested === 'number' && requested > cap) {
      log.warn(
        `[openai] clamping max_tokens ${requested} -> ${cap} for model ${model} (operation: ${operation ?? 'n/a'}); model completion cap exceeded`,
      );
      if (!clamped) clamped = { ...params };
      (clamped as any)[key] = cap;
    }
  }
  return clamped ?? params;
}

// Prefer OpenRouter (unified gateway routing Claude + GPT-4.1 family) when configured.
// OpenRouter is OpenAI-API-compatible, so the existing OpenAI SDK works as a drop-in
// once we swap the baseURL and key. Falls back to direct OpenAI otherwise.
const openRouterKey = process.env.OPENROUTER_API_KEY;
const openAIKey = process.env.OPENAI_API_KEY;
const useOpenRouter = isOpenRouterEnabled();

const apiKey = useOpenRouter ? openRouterKey : openAIKey;

if (!apiKey) {
  log.warn('No LLM API key set (OPENROUTER_API_KEY / OPENAI_API_KEY), AI features disabled');
}

// LangSmith tracing: when enabled, wrap the OpenAI singletons once so every
// chat.completions / responses / embeddings call auto-traces. wrapOpenAI returns
// a drop-in proxy with identical method signatures, so all existing call sites
// (trackedChatCompletion, trackedDirectChatCompletion, trackedDirectResponsesCreate
// and any direct openai.* / openaiDirect.* usages) work unchanged. No-op when
// LANGSMITH_TRACING is unset/false.
const tracingEnabled = process.env.LANGSMITH_TRACING === 'true';

const rawOpenAI = apiKey
  ? new OpenAI({
      apiKey,
      baseURL: useOpenRouter ? OPENROUTER_BASE_URL : undefined,
      defaultHeaders: useOpenRouter ? OPENROUTER_HEADERS : undefined,
    })
  : null;

export const openai = rawOpenAI
  ? (tracingEnabled
      ? (wrapOpenAI(rawOpenAI, { name: useOpenRouter ? 'openrouter-sdk' : 'openai-sdk' }) as typeof rawOpenAI)
      : rawOpenAI)
  : null;

// Direct OpenAI client (never routed through OpenRouter). Required for code paths
// that depend on OpenAI-specific endpoints like the Responses API (PDF file inputs
// for vision extraction), which OpenRouter does not proxy.
const rawOpenAIDirect = openAIKey ? new OpenAI({ apiKey: openAIKey }) : null;

export const openaiDirect = rawOpenAIDirect
  ? (tracingEnabled
      ? (wrapOpenAI(rawOpenAIDirect, { name: 'openai-sdk-direct' }) as typeof rawOpenAIDirect)
      : rawOpenAIDirect)
  : null;

export const isAIEnabled = () => !!openai;

log.info('LLM client status', {
  enabled: isAIEnabled(),
  provider: useOpenRouter ? 'openrouter' : 'openai-direct',
});

// ─── LangSmith trace metadata ──────────────────────────────────────
//
// Lets callers attach business context (dealId, documentId, userId, etc.)
// to a tracked LLM call. The metadata becomes searchable in LangSmith so
// you can filter the trace timeline by deal — instead of seeing 100
// generic `openrouter-sdk` calls a day with no way to tell them apart.
//
// `tags` show up as filter chips in the LangSmith UI; `name` (when given)
// overrides the default span name (which is the `operation` arg).
export interface TraceMeta {
  dealId?: string;
  documentId?: string;
  userId?: string;
  orgId?: string;
  /** Free-form extra metadata visible in LangSmith run details. */
  [key: string]: string | number | boolean | undefined;
}

interface TrackedCallExtras {
  /** Override the LangSmith span name. Defaults to the `operation` arg. */
  name?: string;
  /** Tags shown as filter chips in LangSmith. */
  tags?: string[];
  /** Business-context metadata attached to the trace. */
  traceMeta?: TraceMeta;
}

const tracingEnabledFlag = process.env.LANGSMITH_TRACING === 'true';

// Wraps an async LLM-call function with a `traceable` span so the SDK
// auto-trace (named `openrouter-sdk` / `openai-sdk`) nests under a
// human-readable parent (e.g. `narrative_insights`). No-op when tracing
// is disabled — the inner fn runs directly so we don't pay any overhead.
function withTrace<T>(
  operation: string,
  extras: TrackedCallExtras | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabledFlag) return fn();
  // run_type 'chain' for the parent so the SDK auto-trace (which uses 'llm')
  // appears as a child span — gives a clean two-level view in LangSmith
  // instead of stacking two LLM spans on top of each other.
  const traced = traceable(fn, {
    name: extras?.name ?? operation,
    run_type: 'chain',
    tags: extras?.tags,
    metadata: extras?.traceMeta as Record<string, unknown> | undefined,
  });
  return traced();
}

// System prompt for deal analysis
export const DEAL_ANALYSIS_SYSTEM_PROMPT = `You are DealOS AI, an expert private equity analyst assistant. You help analyze deals, financial data, and investment opportunities.

Your expertise includes:
- Financial analysis (EBITDA, revenue, margins, multiples)
- Deal evaluation and risk assessment
- Investment thesis development
- Due diligence support
- Market and competitive analysis

Guidelines:
- Be concise but thorough
- Use specific numbers and data when available
- Highlight both opportunities and risks
- Reference documents when citing information
- Use professional financial terminology
- Format responses with clear structure (bullet points, sections)

When analyzing a deal, consider:
1. Financial performance and trends
2. Valuation multiples vs. market comparables
3. Key risks and mitigants
4. Growth drivers and opportunities
5. Management and operational factors`;

// Generate deal context for AI
export function generateDealContext(deal: any): string {
  const context = [];

  context.push(`Deal: ${deal.name}`);
  context.push(`Industry: ${deal.industry || 'N/A'}`);
  context.push(`Stage: ${deal.stage}`);
  context.push(`Status: ${deal.status}`);

  if (deal.revenue) context.push(`Revenue: $${deal.revenue}M`);
  if (deal.ebitda) context.push(`EBITDA: $${deal.ebitda}M`);
  if (deal.dealSize) context.push(`Deal Size: $${deal.dealSize}M`);
  if (deal.irrProjected) context.push(`Projected IRR: ${deal.irrProjected}%`);
  if (deal.mom) context.push(`MoM: ${deal.mom}x`);

  if (deal.aiThesis) {
    context.push(`\nCurrent AI Thesis: ${deal.aiThesis}`);
  }

  if (deal.company) {
    context.push(`\nCompany: ${deal.company.name}`);
    if (deal.company.description) context.push(`Description: ${deal.company.description}`);
  }

  if (deal.documents && deal.documents.length > 0) {
    context.push(`\nAvailable Documents:`);
    deal.documents.forEach((doc: any) => {
      context.push(`- ${doc.name} (${doc.type})`);
    });
  }

  if (deal.activities && deal.activities.length > 0) {
    context.push(`\nRecent Activities:`);
    deal.activities.slice(0, 5).forEach((activity: any) => {
      context.push(`- ${activity.title}: ${activity.description || ''}`);
    });
  }

  return context.join('\n');
}

/**
 * Drop-in replacement for `openai.chat.completions.create` that records a
 * UsageEvent. Adds one required `operation` label so the call is attributable.
 * Throws (just like the underlying client) on API errors, but always records
 * a UsageEvent — success or error — so we get visibility either way.
 */
export async function trackedChatCompletion(
  operation: string,
  params: Parameters<NonNullable<typeof openai>['chat']['completions']['create']>[0],
  options?: Parameters<NonNullable<typeof openai>['chat']['completions']['create']>[1],
  extras?: TrackedCallExtras,
) {
  if (!openai) throw new Error('LLM client not configured');
  const model = (params as any).model as string;
  const provider: 'openrouter' | 'openai' = useOpenRouter ? 'openrouter' : 'openai';
  await enforceUserGate(operation, model, provider);
  const safeParams = clampMaxTokens(model, params as any, operation);
  const start = Date.now();
  try {
    const response: any = await withTrace(operation, extras, () =>
      withCircuitBreaker(provider, () =>
        openai!.chat.completions.create(safeParams as any, options),
      ),
    );
    const promptTokens = response?.usage?.prompt_tokens ?? 0;
    const completionTokens = response?.usage?.completion_tokens ?? 0;
    await recordUsageEvent({
      operation,
      model,
      provider,
      promptTokens,
      completionTokens,
      status: 'success',
      durationMs: Date.now() - start,
    });
    return response;
  } catch (err) {
    await recordUsageEvent({
      operation,
      model,
      provider,
      promptTokens: 0,
      completionTokens: 0,
      status: 'error',
      durationMs: Date.now() - start,
      metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

/**
 * chat.completions wrapper that routes through the direct OpenAI client
 * (always provider='openai'). Use when a callsite must bypass OpenRouter
 * — e.g., features that depend on OpenAI-only endpoints. The Responses API
 * has its own wrapper, trackedDirectResponsesCreate, below.
 */
export async function trackedDirectChatCompletion(
  operation: string,
  params: Parameters<NonNullable<typeof openaiDirect>['chat']['completions']['create']>[0],
  options?: Parameters<NonNullable<typeof openaiDirect>['chat']['completions']['create']>[1],
  extras?: TrackedCallExtras,
) {
  if (!openaiDirect) throw new Error('Direct OpenAI client not configured');
  const model = (params as any).model as string;
  await enforceUserGate(operation, model, 'openai');
  const safeParams = clampMaxTokens(model, params as any, operation);
  const start = Date.now();
  try {
    const response: any = await withTrace(operation, extras, () =>
      withCircuitBreaker('openai', () =>
        openaiDirect!.chat.completions.create(safeParams as any, options),
      ),
    );
    const promptTokens = response?.usage?.prompt_tokens ?? 0;
    const completionTokens = response?.usage?.completion_tokens ?? 0;
    await recordUsageEvent({
      operation,
      model,
      provider: 'openai',
      promptTokens,
      completionTokens,
      status: 'success',
      durationMs: Date.now() - start,
    });
    return response;
  } catch (err) {
    await recordUsageEvent({
      operation,
      model,
      provider: 'openai',
      promptTokens: 0,
      completionTokens: 0,
      status: 'error',
      durationMs: Date.now() - start,
      metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

/**
 * Wrapped OpenAI Responses API call (used by visionExtractor for native PDF
 * file inputs). The Responses API returns `usage.input_tokens` /
 * `usage.output_tokens` (not prompt_tokens/completion_tokens like
 * chat.completions). Always provider='openai' since OpenRouter does not
 * proxy /v1/responses.
 */
export async function trackedDirectResponsesCreate(
  operation: string,
  params: any,
  options?: any,
  extras?: TrackedCallExtras,
) {
  if (!openaiDirect) throw new Error('Direct OpenAI client not configured');
  const model = (params as any).model as string;
  await enforceUserGate(operation, model, 'openai');
  const start = Date.now();
  try {
    const response: any = await withTrace(operation, extras, () =>
      withCircuitBreaker('openai', () =>
        (openaiDirect as any).responses.create(params, options),
      ),
    );
    const promptTokens = response?.usage?.input_tokens ?? 0;
    const completionTokens = response?.usage?.output_tokens ?? 0;
    await recordUsageEvent({
      operation,
      model,
      provider: 'openai',
      promptTokens,
      completionTokens,
      status: 'success',
      durationMs: Date.now() - start,
    });
    return response;
  } catch (err) {
    await recordUsageEvent({
      operation,
      model,
      provider: 'openai',
      promptTokens: 0,
      completionTokens: 0,
      status: 'error',
      durationMs: Date.now() - start,
      metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
