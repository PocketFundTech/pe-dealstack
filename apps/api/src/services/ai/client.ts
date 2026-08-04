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
import { getModelConfig, type AiRole } from './models.js';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — AI features unavailable');
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Test-only: reset the singleton (mirrors _resetModelPriceCache convention). */
export function _resetAnthropicClient(): void {
  _client = null;
}

export class AIRefusalError extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super(`Claude declined the request${category ? ` (category: ${category})` : ''}`);
    this.name = 'AIRefusalError';
    this.category = category;
  }
}

export interface ClaudeCallOptions {
  /** UsageEvent operation name, e.g. 'financial_extraction'. */
  operation: string;
  role: AiRole;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  /** JSON schema for structured output (output_config.format). */
  outputSchema?: Record<string, unknown>;
  /** Extra anthropic-beta flags (e.g. files-api-2025-04-14). */
  extraBetas?: string[];
  maxTokens?: number;
}

export interface ClaudeCallResult {
  text: string;
  /** Model that actually served the response (fallback-aware). */
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export async function trackedClaudeMessage(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const startedAt = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    messages: opts.messages,
    betas: [...cfg.betas, ...(opts.extraBetas ?? [])],
  };
  if (opts.system) request.system = opts.system;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.outputSchema) {
    request.output_config = { format: { type: 'json_schema', schema: opts.outputSchema } };
  }
  // Never send `thinking`: Fable 5 rejects explicit configs; other models
  // use their defaults.

  const record = (status: 'success' | 'error' | 'blocked', model: string, inTok: number, outTok: number) =>
    void recordUsageEvent({
      operation: opts.operation,
      provider: 'anthropic',
      status,
      model,
      promptTokens: inTok,
      completionTokens: outTok,
      durationMs: Date.now() - startedAt,
    }).catch(() => { /* ledger is fire-and-forget */ });

  try {
    const stream = client.beta.messages.stream(request as never);
    const message = await stream.finalMessage();

    const inTok = message.usage?.input_tokens ?? 0;
    const outTok = message.usage?.output_tokens ?? 0;

    if (message.stop_reason === 'refusal') {
      record('blocked', message.model, inTok, outTok);
      const category =
        message.stop_details && 'category' in message.stop_details
          ? ((message.stop_details as { category: string | null }).category)
          : null;
      throw new AIRefusalError(category);
    }

    record('success', message.model, inTok, outTok);
    const text = (message.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { text, model: message.model, stopReason: message.stop_reason ?? null, usage: { inputTokens: inTok, outputTokens: outTok } };
  } catch (err) {
    if (err instanceof AIRefusalError) throw err;
    record('error', cfg.model, 0, 0);
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

export interface ClaudeStreamHandle {
  runner: AsyncIterable<AsyncIterable<any>>;
  recordUsage: (usage: { inputTokens: number; outputTokens: number }, status: 'success' | 'error') => Promise<void>;
}

export function trackedClaudeStream(opts: ClaudeStreamOptions): ClaudeStreamHandle {
  const cfg = getModelConfig(opts.role);
  const client = getAnthropicClient();
  const start = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: opts.messages,
    tools: opts.tools,
    betas: cfg.betas,
    stream: true,
  };
  if (opts.system) request.system = opts.system;
  if (cfg.fallbacks) request.fallbacks = cfg.fallbacks;
  if (opts.signal) request.signal = opts.signal;

  const runner = client.beta.messages.toolRunner(request as never);

  const recordUsage = async (
    usage: { inputTokens: number; outputTokens: number },
    status: 'success' | 'error',
  ): Promise<void> => {
    await recordUsageEvent({
      operation: opts.operation,
      provider: 'anthropic',
      model: cfg.model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      status,
      durationMs: Date.now() - start,
    });
  };

  return { runner, recordUsage };
}
