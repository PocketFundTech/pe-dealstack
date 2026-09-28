/**
 * Single tracked Anthropic client (Phase 1 AI core swap).
 *
 * Every new-stack LLM call goes through trackedClaudeMessage():
 *  - resolves model + request shaping from models.ts (role map)
 *  - streams (large max_tokens would time out non-streaming)
 *  - handles stop_reason "refusal" (throws AIRefusalError — a refusal that
 *    survives the server-side fallback chain is a content outcome, not a 500)
 *  - records a UsageEvent (fire-and-forget ledger, provider 'anthropic')
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../../utils/logger.js';
import { recordUsageEvent } from '../usage/trackedLLM.js';
import { resolveAnthropicAuth, hasAnthropicCredentials } from '../anthropic.js';
import { getModelConfig, type AiRole } from './models.js';
import { normalizeOutputSchema } from './schemaCompat.js';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const authOptions = resolveAnthropicAuth();
    if (!authOptions) {
      throw new Error('ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN is not set — AI features unavailable');
    }
    _client = new Anthropic(authOptions);
  }
  return _client;
}

/** Test-only: reset the singleton (mirrors _resetModelPriceCache convention). */
export function _resetAnthropicClient(): void {
  _client = null;
}

/** True when ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN is configured — cheap check, no client construction. */
export function isAnthropicAvailable(): boolean {
  return hasAnthropicCredentials();
}

export class AIRefusalError extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super(`Claude declined the request${category ? ` (category: ${category})` : ''}`);
    this.name = 'AIRefusalError';
    this.category = category;
  }
}

/**
 * A system-prompt text block, optionally marked cacheable. Pass an array
 * (instead of a plain string) when the prompt is stable across repeated
 * calls in the same request (e.g. a repair pass, or a container→text
 * fallback resending the same instructions) — `cache_control: { type:
 * 'ephemeral' }` on the last block tells Anthropic to cache everything up
 * to and including it, cutting input cost ~90% on a hit within 5 minutes.
 * Passed straight through to the SDK's `system` field either way.
 */
export type ClaudeSystemPrompt = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;

export interface ClaudeCallOptions {
  /** UsageEvent operation name, e.g. 'financial_extraction'. */
  operation: string;
  role: AiRole;
  system?: ClaudeSystemPrompt;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  /** JSON schema for structured output (output_config.format). */
  outputSchema?: Record<string, unknown>;
  /** Extra anthropic-beta flags (e.g. files-api-2025-04-14). */
  extraBetas?: string[];
  /**
   * Optional tools for this request — used for SERVER tools (e.g.
   * code_execution) that run on Anthropic's side within the single call.
   * Client tools needing an execution loop belong in trackedClaudeStream's
   * tool runner, not here.
   */
  tools?: unknown[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ClaudeCallResult {
  text: string;
  /** Model that actually served the response (fallback-aware). */
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** Cache token counts pulled off a Beta Messages `usage` object (or a stream
 *  snapshot's `usage`, same shape). Anthropic's `input_tokens` EXCLUDES these
 *  — see trackedLLM.ts / modelPrices.ts for why they're priced separately. */
function extractCacheTokens(
  usage?: {
    cache_read_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  } | null,
): { cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number } {
  return {
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1hTokens: usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

export async function trackedClaudeMessage(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const startedAt = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    messages: opts.messages,
  };
  // Only send betas when non-empty — an empty array serializes to an empty
  // anthropic-beta header, which the API rejects with a 400
  // ("Unexpected value(s) for the anthropic-beta header"). Hit in production
  // by the memo/scorecard roles, whose ModelConfig has no beta flags.
  const betas = [...cfg.betas, ...(opts.extraBetas ?? [])];
  if (betas.length > 0) request.betas = betas;
  if (opts.system) request.system = opts.system;
  if (opts.tools && opts.tools.length > 0) request.tools = opts.tools;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.outputSchema) {
    // Normalized at the boundary so an out-of-subset schema (missing
    // additionalProperties:false, number min/max, type arrays) can never
    // 400 a production call again — see schemaCompat.ts for the incident log.
    request.output_config = { format: { type: 'json_schema', schema: normalizeOutputSchema(opts.outputSchema) } };
  }
  // `signal` is SDK RequestOptions (2nd argument to .stream()), NEVER a body
  // field — a body-level `signal` serializes into the JSON payload and the
  // API 400s every call with "signal: Extra inputs are not permitted"
  // (prod incident 2026-08-14: all memo section generation down).
  // Never send `thinking`: Fable 5 rejects explicit configs; other models
  // use their defaults.

  // Awaited (not fire-and-forget): Vercel can freeze the function once the
  // response is sent, dropping an un-awaited insert. A ledger failure must
  // never surface to the caller though, so it's caught here rather than left
  // to propagate — callers of trackedClaudeMessage shouldn't have to know
  // the usage ledger exists.
  const record = async (
    status: 'success' | 'error' | 'blocked',
    model: string,
    inTok: number,
    outTok: number,
    cache: { cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number },
  ): Promise<void> => {
    try {
      await recordUsageEvent({
        operation: opts.operation,
        provider: 'anthropic',
        status,
        model,
        promptTokens: inTok,
        completionTokens: outTok,
        ...cache,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      /* ledger is best-effort */
    }
  };

  // Held outside the try so the catch block can still read whatever usage
  // the stream had already received before it errored/aborted — Anthropic
  // bills the tokens it processed regardless of how the request ended.
  let stream: ReturnType<typeof client.beta.messages.stream> | undefined;
  try {
    stream = client.beta.messages.stream(
      request as never,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    const message = await stream.finalMessage();

    const inTok = message.usage?.input_tokens ?? 0;
    const outTok = message.usage?.output_tokens ?? 0;
    const cache = extractCacheTokens(message.usage);

    if (message.stop_reason === 'refusal') {
      await record('blocked', message.model, inTok, outTok, cache);
      const category =
        message.stop_details && 'category' in message.stop_details
          ? ((message.stop_details as { category: string | null }).category)
          : null;
      throw new AIRefusalError(category);
    }

    await record('success', message.model, inTok, outTok, cache);
    const text = (message.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { text, model: message.model, stopReason: message.stop_reason ?? null, usage: { inputTokens: inTok, outputTokens: outTok } };
  } catch (err) {
    if (err instanceof AIRefusalError) throw err;
    // On error/abort, the stream may have already accumulated a partial
    // message (message_start/message_delta events) before it broke — pull
    // that snapshot's usage instead of recording 0/0, which under-bills
    // every aborted/errored call that Anthropic still charged for.
    const snapshot = stream?.currentMessage;
    const inTok = snapshot?.usage?.input_tokens ?? 0;
    const outTok = snapshot?.usage?.output_tokens ?? 0;
    const cache = extractCacheTokens(snapshot?.usage);
    const model = snapshot?.model ?? cfg.model;
    await record('error', model, inTok, outTok, cache);
    log.error('trackedClaudeMessage failed', { operation: opts.operation, model: cfg.model, err });
    throw err;
  }
}

export interface ClaudeStreamOptions {
  operation: string;
  role: AiRole;
  system?: string;
  messages: unknown[];
  tools: unknown[];
  signal?: AbortSignal;
}

/** Usage accumulated by the caller from stream events (message_start /
 *  message_delta) across a tool-runner's iterations. Cache tokens are
 *  optional so existing callers that haven't been updated to accumulate them
 *  yet keep compiling. */
export interface ClaudeStreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

export interface ClaudeStreamHandle {
  runner: AsyncIterable<AsyncIterable<any>>;
  /**
   * @param servedModel The model that actually served the response, read by
   *   the caller off `message_start.message.model`. Falls back to the
   *   requested alias (`cfg.model`) when the caller hasn't tracked it.
   */
  recordUsage: (usage: ClaudeStreamUsage, status: 'success' | 'error', servedModel?: string) => Promise<void>;
}

export function trackedClaudeStream(opts: ClaudeStreamOptions): ClaudeStreamHandle {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const start = Date.now();

  // `stream: true` must stay a literal on this object (not widened through a
  // Record<string, unknown> or `as never` cast) — toolRunner() is overloaded
  // on it and picks BetaToolRunner<false> if the literal is lost, which then
  // fails to structurally match the AsyncIterable<AsyncIterable<...>> shape
  // this function's callers rely on. Only the heterogeneous fields (messages/
  // tools/betas/etc., whose real SDK types this codebase doesn't import) are
  // cast individually so the `stream: true` key stays visible for overload
  // resolution.
  // `signal` goes in the RequestOptions second argument, never in the params
  // object — a params-level `signal` is serialized into the request body and
  // the API 400s with "signal: Extra inputs are not permitted" (same failure
  // class as the 2026-08-14 memo-generation incident in trackedClaudeMessage).
  const runner = client.beta.messages.toolRunner(
    {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: opts.messages as never,
      tools: opts.tools as never,
      ...(cfg.betas.length > 0 ? { betas: cfg.betas as never } : {}),
      stream: true,
      ...(opts.system ? { system: opts.system } : {}),
      ...(cfg.fallbacks ? { fallbacks: cfg.fallbacks as never } : {}),
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  const recordUsage = async (
    usage: ClaudeStreamUsage,
    status: 'success' | 'error',
    servedModel?: string,
  ): Promise<void> => {
    await recordUsageEvent({
      operation: opts.operation,
      provider: 'anthropic',
      model: servedModel ?? cfg.model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWrite5mTokens: usage.cacheWrite5mTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      status,
      durationMs: Date.now() - start,
    });
  };

  return { runner, recordUsage };
}
