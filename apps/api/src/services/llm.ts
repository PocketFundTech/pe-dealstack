// ─── Unified LLM Abstraction Layer ─────────────────────────────────
// Provides a single interface to swap between OpenAI / Gemini via config.
// Uses LangChain as the abstraction so all downstream code is model-agnostic.

import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { z } from 'zod';
import { log } from '../utils/logger.js';
import {
  AI_MODELS,
  OPENROUTER_BASE_URL,
  OPENROUTER_HEADERS,
  isOpenRouterEnabled,
} from '../utils/aiModels.js';
import { recordUsageEvent } from './usage/trackedLLM.js';
import { enforceUserGate, UserBlockedError } from './usage/enforcement.js';
import { withCircuitBreaker } from './aiCircuitBreaker.js';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';

export { UserBlockedError } from './usage/enforcement.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuration ─────────────────────────────────────────────────

export type LLMProvider = 'openai' | 'gemini';

interface LLMConfig {
  /** Primary provider for chat/analysis */
  chatProvider: LLMProvider;
  /** Provider for fast/cheap tasks (sentiment, classification) */
  fastProvider: LLMProvider;
  /** Provider for embeddings — always Gemini (gemini-embedding-001) */
  embeddingProvider: 'gemini';
}

// Default: OpenAI for chat, OpenAI-mini for fast, Gemini for embeddings
const config: LLMConfig = {
  chatProvider: (process.env.LLM_CHAT_PROVIDER as LLMProvider) || 'openai',
  fastProvider: (process.env.LLM_FAST_PROVIDER as LLMProvider) || 'openai',
  embeddingProvider: 'gemini',
};

// ─── Model Registry ────────────────────────────────────────────────

// When OpenRouter is enabled, model strings are OpenRouter IDs
// (e.g. "anthropic/claude-sonnet-4.5") routed through the OpenAI-compatible
// ChatOpenAI client below. Otherwise we fall back to bare OpenAI model names.
const useOpenRouter = isOpenRouterEnabled();

// ─── Usage Tracking Adapter ────────────────────────────────────────

/**
 * Wrap a BaseChatModel so every LLM API call records a UsageEvent.
 *
 * Two-layer approach:
 *
 * 1. LangChain callback handler (handleLLMEnd / handleLLMError)
 *    Fires for EVERY underlying LLM call regardless of how the model is
 *    invoked — direct `.invoke()`, chained operators, or wrapped via
 *    `.withStructuredOutput(schema).invoke(input)`. This is the primary
 *    recording path for all 14 structured-output callsites.
 *
 * 2. Patched `.invoke()` — user-gate enforcement only.
 *    The gate (isBlocked check) runs synchronously before the HTTP-path
 *    model calls. For structured-output chains, the chain calls the
 *    underlying model directly and bypasses this patch — so gate
 *    enforcement for those paths is best-effort post-hoc via the
 *    runaway monitor and the existing 30s flag cache. This trade-off is
 *    acceptable because block enforcement at ingestion (HTTP middleware)
 *    already prevents the request from reaching the LLM service.
 *
 * Provider widening: includes 'gemini' so Gemini-backed models are tagged
 * correctly (previously always recorded as 'openai').
 */
/**
 * Build a usage-tracking callback handler. Pass at construction time via
 * the model's `callbacks` config, NOT mutated after construction —
 * mutation doesn't propagate through `bindTools()` / `withStructuredOutput()`
 * which is exactly the path LangGraph's createReactAgent uses, and silently
 * swallowed our tracking for every deal-chat / agent invocation.
 */
function makeUsageHandler(
  operation: string,
  modelName: string,
  provider: 'openrouter' | 'openai' | 'gemini',
): Partial<BaseCallbackHandler> {
  return {
    name: 'usage-tracker',
    // IMPORTANT: return the promise (not `void`). LangChain awaits handleLLMEnd
    // before continuing the agent loop, so the Supabase insert completes before
    // the lambda freezes. Fire-and-forget here drops the insert on Vercel.
    async handleLLMEnd(output: any): Promise<void> {
      const gen0 = output?.generations?.[0]?.[0]?.message;
      const usage =
        gen0?.usage_metadata ??
        output?.llmOutput?.tokenUsage ??
        output?.llmOutput?.usage ??
        null;
      await recordUsageEvent({
        operation,
        model: modelName,
        provider,
        promptTokens:
          usage?.input_tokens ?? usage?.promptTokens ?? usage?.prompt_tokens ?? 0,
        completionTokens:
          usage?.output_tokens ?? usage?.completionTokens ?? usage?.completion_tokens ?? 0,
        status: 'success',
      });
    },
    async handleLLMError(err: any): Promise<void> {
      await recordUsageEvent({
        operation,
        model: modelName,
        provider,
        promptTokens: 0,
        completionTokens: 0,
        status: 'error',
        metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
      });
    },
  };
}

/**
 * Add the synchronous block gate to a model. Patches `.invoke` so direct
 * `.invoke()` calls run `enforceUserGate` first. Tracking itself is now
 * handled via construction-time callbacks (see makeUsageHandler).
 */
function trackModel(model: BaseChatModel, operation: string, modelName: string): BaseChatModel {
  const provider: 'openrouter' | 'openai' | 'gemini' =
    (model as any).constructor?.name?.includes('Google') ? 'gemini' :
    useOpenRouter ? 'openrouter' : 'openai';

  const originalInvoke = model.invoke.bind(model);
  model.invoke = async (input: any, options?: any) => {
    await enforceUserGate(operation, modelName, provider);
    return withCircuitBreaker(provider, () => originalInvoke(input, options));
  };

  return model;
}

function providerFor(provider: LLMProvider): 'openrouter' | 'openai' | 'gemini' {
  if (provider === 'gemini') return 'gemini';
  return useOpenRouter ? 'openrouter' : 'openai';
}

const MODELS = {
  openai: {
    chat: process.env.LLM_CHAT_MODEL || (useOpenRouter ? AI_MODELS.TIER1 : 'gpt-4o'),
    fast: process.env.LLM_FAST_MODEL || (useOpenRouter ? AI_MODELS.TIER3 : 'gpt-4o-mini'),
    extraction: useOpenRouter ? AI_MODELS.TIER1 : 'gpt-4o',
  },
  gemini: {
    chat: 'gemini-1.5-pro',
    fast: 'gemini-1.5-flash',
    extraction: 'gemini-1.5-pro',
  },
} as const;

// ─── Factory Functions ─────────────────────────────────────────────

function createOpenAIModel(
  model: string,
  temperature = 0.7,
  maxTokens?: number,
  callbacks?: Partial<BaseCallbackHandler>[],
): ChatOpenAI {
  if (useOpenRouter) {
    // Route through OpenRouter using ChatOpenAI's OpenAI-compatible client.
    // @langchain/openai v1 uses `apiKey` (not `openAIApiKey`); we also pass it
    // inside `configuration` so the underlying OpenAI SDK definitely picks it up
    // instead of falling back to the OPENAI_API_KEY env var.
    return new ChatOpenAI({
      model,
      temperature,
      maxTokens,
      apiKey: process.env.OPENROUTER_API_KEY,
      configuration: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: OPENROUTER_HEADERS,
      },
      ...(callbacks && callbacks.length > 0 ? { callbacks } : {}),
    });
  }
  return new ChatOpenAI({
    model,
    temperature,
    maxTokens,
    apiKey: process.env.OPENAI_API_KEY,
    ...(callbacks && callbacks.length > 0 ? { callbacks } : {}),
  });
}

function createGeminiModel(
  model: string,
  temperature = 0.7,
  maxTokens?: number,
  callbacks?: Partial<BaseCallbackHandler>[],
): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    model,
    temperature,
    maxOutputTokens: maxTokens,
    apiKey: process.env.GEMINI_API_KEY,
    ...(callbacks && callbacks.length > 0 ? { callbacks } : {}),
  });
}

function createModel(
  provider: LLMProvider,
  modelName: string,
  temperature = 0.7,
  maxTokens?: number,
  callbacks?: Partial<BaseCallbackHandler>[],
): BaseChatModel {
  switch (provider) {
    case 'openai':
      return createOpenAIModel(modelName, temperature, maxTokens, callbacks);
    case 'gemini':
      return createGeminiModel(modelName, temperature, maxTokens, callbacks);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

// ─── Pre-built Model Instances ─────────────────────────────────────

/** Primary chat model (Claude Sonnet 4.5 via OpenRouter, or GPT-4.1 direct) — for deal analysis, chat, memos */
export function getChatModel(temperature = 0.7, maxTokens = 1500, operation?: string): BaseChatModel {
  const provider = config.chatProvider;
  const modelName = MODELS[provider].chat;
  if (!operation) {
    log.warn('getChatModel called without operation label — usage will not be tracked');
    return createModel(provider, modelName, temperature, maxTokens);
  }
  const callbacks = [makeUsageHandler(operation, modelName, providerFor(provider))];
  const model = createModel(provider, modelName, temperature, maxTokens, callbacks);
  return trackModel(model, operation, modelName);
}

/** Fast/cheap model (GPT-4.1-mini via OpenRouter, or GPT-4.1-mini direct) — for sentiment, classification */
export function getFastModel(temperature = 0.7, maxTokens = 500, operation?: string): BaseChatModel {
  const provider = config.fastProvider;
  const modelName = MODELS[provider].fast;
  if (!operation) {
    log.warn('getFastModel called without operation label — usage will not be tracked');
    return createModel(provider, modelName, temperature, maxTokens);
  }
  const callbacks = [makeUsageHandler(operation, modelName, providerFor(provider))];
  const model = createModel(provider, modelName, temperature, maxTokens, callbacks);
  return trackModel(model, operation, modelName);
}

/** Extraction model — low temperature for consistent structured output */
export function getExtractionModel(maxTokens = 3000, operation?: string): BaseChatModel {
  const provider = config.chatProvider;
  const modelName = MODELS[provider].extraction;
  if (!operation) {
    log.warn('getExtractionModel called without operation label — usage will not be tracked');
    return createModel(provider, modelName, 0.1, maxTokens);
  }
  const callbacks = [makeUsageHandler(operation, modelName, providerFor(provider))];
  const model = createModel(provider, modelName, 0.1, maxTokens, callbacks);
  return trackModel(model, operation, modelName);
}

/** Get a specific model by name (escape hatch) */
export function getModel(
  provider: LLMProvider,
  modelName: string,
  temperature = 0.7,
  maxTokens?: number
): BaseChatModel {
  return createModel(provider, modelName, temperature, maxTokens);
}

// ─── Structured Output with Fallback ───────────────────────────────
// LangChain's withStructuredOutput emits an OpenAI tool-call schema. Anthropic
// (Claude Sonnet 4.5 via OpenRouter, our Tier-1 default) sometimes rejects
// that schema after OpenRouter's translation, returning a 400 "Provider
// returned error" with no useful body. OpenAI-native models accept the same
// schema as-is. invokeStructured wraps the call once with the primary
// extraction model and retries with Tier 2 (gpt-4.1 via OpenRouter, or gpt-4o
// direct) on any error so callers don't have to duplicate the fallback.
function describeAIError(err: any): Record<string, unknown> {
  return {
    message: err?.message,
    status: err?.status,
    code: err?.code,
    providerRaw: err?.error?.metadata?.raw,
    providerMsg: err?.error?.message,
    type: err?.error?.type,
  };
}

export async function invokeStructured<T extends z.ZodTypeAny>(
  schema: T,
  messages: BaseMessage[],
  opts?: { maxTokens?: number; temperature?: number; label?: string }
): Promise<z.infer<T>> {
  const maxTokens = opts?.maxTokens ?? 2000;
  const temperature = opts?.temperature ?? 0.1;
  const label = opts?.label ?? 'invokeStructured';
  // Construct primary directly so caller's temperature is honoured. Using
  // getExtractionModel would hardcode 0.1, which is wrong for emails / meeting
  // briefs / signal analysis where higher variance is desirable.
  const primaryName = MODELS[config.chatProvider].extraction;
  const primaryProvider = providerFor(config.chatProvider);
  try {
    const primaryCallbacks = [makeUsageHandler(label, primaryName, primaryProvider)];
    const primary = createModel(config.chatProvider, primaryName, temperature, maxTokens, primaryCallbacks);
    const tracked = trackModel(primary, label, primaryName);
    // withStructuredOutput().invoke() bypasses the patched .invoke() on the
    // base model, so wrap the structured chain in the breaker explicitly.
    return await withCircuitBreaker(primaryProvider, () =>
      tracked.withStructuredOutput(schema).invoke(messages),
    );
  } catch (primaryErr: any) {
    log.warn(`${label}: primary model failed, retrying with fallback`, describeAIError(primaryErr));
    const fallbackProvider = providerFor('openai');
    const fallbackName = isOpenRouterEnabled() ? AI_MODELS.TIER2 : 'gpt-4o';
    const fallbackCallbacks = [makeUsageHandler(label, fallbackName, fallbackProvider)];
    const fallback = createModel('openai', fallbackName, temperature, maxTokens, fallbackCallbacks);
    const tracked = trackModel(fallback, label, fallbackName);
    return await withCircuitBreaker(fallbackProvider, () =>
      tracked.withStructuredOutput(schema).invoke(messages),
    );
  }
}

// ─── Availability Checks ──────────────────────────────────────────

export function isOpenAICompatibleAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY || !!process.env.OPENROUTER_API_KEY;
}

export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export function isLLMAvailable(): boolean {
  return isOpenAICompatibleAvailable() || isGeminiAvailable();
}

/** Get the currently configured chat provider name */
export function getChatProviderName(): string {
  return `${config.chatProvider}/${MODELS[config.chatProvider].chat}`;
}

// ─── Logging ──────────────────────────────────────────────────────

log.info('LLM abstraction initialized', {
  chatProvider: config.chatProvider,
  chatModel: MODELS[config.chatProvider].chat,
  fastProvider: config.fastProvider,
  fastModel: MODELS[config.fastProvider].fast,
  openaiCompatibleAvailable: isOpenAICompatibleAvailable(),
  geminiAvailable: isGeminiAvailable(),
  routedThroughOpenRouter: useOpenRouter,
});
