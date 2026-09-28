// ─── Anthropic usage-tracking helpers ───────────────────────────────
//
// Shared by every call site that talks to Anthropic directly (raw SDK
// `messages.create`) or via a bare `ChatAnthropic` instance that has no
// usage callback wired up (claudeFinancialClassifier, financialCrossVerify,
// outreachImportCleaner, replyIntentClassifier, firmTeaserGenerator).
//
// Anthropic usage facts (see trackedLLM.ts's RecordUsageEventLLM doc):
//   - `usage.input_tokens` EXCLUDES cache tokens.
//   - Cache-read tokens are `usage.cache_read_input_tokens`.
//   - Cache-write tokens are `usage.cache_creation.ephemeral_5m_input_tokens`
//     / `ephemeral_1h_input_tokens` — falling back to the older
//     `cache_creation_input_tokens` field (treated as a 5m write) when the
//     nested `cache_creation` object isn't present.
// A raw `messages.create` response's `.usage` and a non-streaming
// `ChatAnthropic.invoke()` response's `response_metadata.usage` are both
// the same underlying Anthropic API shape, so one splitter covers both.

import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { recordUsageEvent } from './trackedLLM.js';

/** The subset of Anthropic's `Usage` shape this module reads. Loose types
 *  (rather than importing `Anthropic.Usage`) so it works whether the caller
 *  hands it a raw SDK `Usage` or a `ChatAnthropic` `response_metadata.usage`. */
export interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

interface SplitUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

function splitAnthropicUsage(usage: AnthropicUsageLike | null | undefined): SplitUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite5mTokens =
    usage?.cache_creation?.ephemeral_5m_input_tokens ?? usage?.cache_creation_input_tokens ?? 0;
  const cacheWrite1hTokens = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return { promptTokens, completionTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens };
}

/**
 * Record a UsageEvent from a raw Anthropic `messages.create` response's
 * `.usage` (or a `ChatAnthropic` response's `response_metadata.usage`).
 * Use this whenever the caller already has the message/response object in
 * hand — for the `.withStructuredOutput()` case (where `.invoke()` returns
 * only the parsed object, not the message), use `makeAnthropicUsageCallback`
 * instead.
 */
export async function recordAnthropicMessageUsage(params: {
  operation: string;
  model: string;
  usage: AnthropicUsageLike | null | undefined;
  status: 'success' | 'error';
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const split = splitAnthropicUsage(params.usage);
  await recordUsageEvent({
    operation: params.operation,
    provider: 'anthropic',
    model: params.model,
    promptTokens: split.promptTokens,
    completionTokens: split.completionTokens,
    cacheReadTokens: split.cacheReadTokens,
    cacheWrite5mTokens: split.cacheWrite5mTokens,
    cacheWrite1hTokens: split.cacheWrite1hTokens,
    status: params.status,
    durationMs: params.durationMs,
    metadata: params.metadata,
  });
}

/**
 * LangChain callback handler for `ChatAnthropic` call sites that have no
 * usage tracking wired up and use `.withStructuredOutput()` (whose
 * `.invoke()` resolves to the parsed object, not the underlying AIMessage,
 * so there is no response to read `response_metadata.usage` from
 * afterwards). Callbacks passed via the `.invoke()` config propagate down
 * to the underlying chat-model call regardless of the runnable chain
 * wrapping it (bindTools / withStructuredOutput / agent loops all bottom
 * out into the same model, same as documented in llm.ts's makeUsageHandler),
 * so `handleLLMEnd` still fires once per real API call.
 */
export function makeAnthropicUsageCallback(
  operation: string,
  model: string,
): Partial<BaseCallbackHandler> {
  return {
    name: 'anthropic-usage-tracker',
    async handleLLMEnd(output: any): Promise<void> {
      const gen0 = output?.generations?.[0]?.[0];
      const usage: AnthropicUsageLike | undefined =
        gen0?.message?.response_metadata?.usage ?? gen0?.message?.kwargs?.response_metadata?.usage;
      const split = splitAnthropicUsage(usage);
      await recordUsageEvent({
        operation,
        provider: 'anthropic',
        model,
        promptTokens: split.promptTokens,
        completionTokens: split.completionTokens,
        cacheReadTokens: split.cacheReadTokens,
        cacheWrite5mTokens: split.cacheWrite5mTokens,
        cacheWrite1hTokens: split.cacheWrite1hTokens,
        status: 'success',
      });
    },
    async handleLLMError(err: any): Promise<void> {
      await recordUsageEvent({
        operation,
        provider: 'anthropic',
        model,
        promptTokens: 0,
        completionTokens: 0,
        status: 'error',
        metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
      });
    },
  };
}
