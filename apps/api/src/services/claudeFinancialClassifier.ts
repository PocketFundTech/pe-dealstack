/**
 * Claude (Sonnet 4.6) financial classifier.
 *
 * Mirrors the contract of `classifyFinancials` (financialClassifier.ts) but
 * dispatches to Anthropic instead of OpenAI. Used by `financialCrossVerify`
 * to produce a second independent extraction that can be cross-checked
 * against the GPT result, catching single-model hallucinations that a
 * self-correction loop on either provider alone wouldn't catch.
 *
 * Why Sonnet 4.6 specifically:
 *   - Same prompt as the GPT path (buildExtractionPrompt) so the two
 *     extractions are directly comparable.
 *   - Adaptive thinking + high effort — extraction is intelligence-
 *     sensitive (unit-scale inference, period classification, derived-field
 *     reconciliation).
 *   - System prompt cached (ephemeral, 5-min TTL) — re-extracting the
 *     same document or processing many docs with the same hint structure
 *     reuses the input prefix at ~10% of the input price.
 *   - Streaming required: max_tokens up to 32K to fit a deep monthly grid
 *     plus per-period source citations exceeds the SDK's non-streaming
 *     HTTP timeout window. ChatAnthropic.invoke() handles streaming
 *     internally when `streaming: true` is set on the constructor.
 *   - Same post-processing as the GPT path (normalizeClassificationResult,
 *     applyExplicitUnitOverride, applySmallDollarActualsOverride) — keeps
 *     outputs byte-comparable when both models agree, so the cross-verify
 *     diff only flags real disagreements.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { log } from '../utils/logger.js';
import { buildExtractionPrompt } from './extractionPrompt.js';
import { periodHygieneGuidanceIfEnabled } from './extraction-evals/fewshot.js';
import { MAX_TEXT_LENGTH } from './agents/financialAgent/config.js';
import {
  applyExplicitUnitOverride,
  applySmallDollarActualsOverride,
  applySourceTextDollarOverride,
  detectExplicitUnitInText,
  hasExplicitSmallDollarAmounts,
  normalizeClassificationResult,
  type ClassificationResult,
  type ClassifyOptions,
} from './financialClassifier.js';

// ─── Config ──────────────────────────────────────────────────

/** Sonnet 4.6 — exact model ID per Anthropic SDK spec. Do not append a
 *  date suffix; the alias resolves to the latest GA release. */
const SONNET_MODEL = 'claude-sonnet-4-6';

/** Output budget — matches the GPT path (32K) so a deep monthly grid +
 *  source citations fit. Values above ~16K mandate streaming on the
 *  Anthropic SDK; ChatAnthropic streams internally when `streaming: true`. */
const MAX_OUTPUT_TOKENS = 32_000;

/** Higher per-request timeout than the SDK default. Sonnet 4.6 with
 *  adaptive thinking on a 32K output budget can take 60-90s for deep
 *  grids; the GPT path uses 120s for the same reason. */
const REQUEST_TIMEOUT_MS = 180_000;

let cachedModel: ChatAnthropic | null = null;

function getModel(): ChatAnthropic | null {
  if (cachedModel) return cachedModel;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  cachedModel = new ChatAnthropic({
    model: SONNET_MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Adaptive thinking: extraction is intelligence-sensitive (unit-scale
    // inference, period classification, derived-field reconciliation).
    thinking: { type: 'adaptive' },
    // High effort — trades latency for thoroughness on the deep monthly grid.
    outputConfig: { effort: 'high' },
    // Stream internally so 32K output budgets don't hit the SDK's
    // non-streaming HTTP timeout window. ChatAnthropic aggregates the
    // chunks and returns a single AIMessage from .invoke().
    streaming: true,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return cachedModel;
}

/**
 * True when ANTHROPIC_API_KEY is present in the environment. The cross-
 * verify wrapper uses this to decide whether to fan out to a second
 * extractor or fall through to GPT-only behaviour. Vercel users set this
 * via the project's env vars (the user names it ANTHROPIC_API_KEY).
 */
export function isClaudeClassifierEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// ─── Main Function ────────────────────────────────────────────

/**
 * Drop-in mirror of `classifyFinancials`. Same input shape, same return
 * shape, same null-on-failure semantics — so callers can route to either
 * extractor without branching on which provider answered.
 */
export async function classifyFinancialsWithClaude(
  text: string,
  options?: ClassifyOptions,
): Promise<ClassificationResult | null> {
  const model = getModel();
  if (!model) {
    log.warn('Claude classifier skipped: ANTHROPIC_API_KEY not set');
    return null;
  }

  if (!text || text.trim().length < 100) {
    log.warn('Claude classifier skipped: text too short');
    return null;
  }

  // Same truncation cap as the GPT path so the two extractors see exactly
  // the same input. Diverging here would create false-positive "disagreement"
  // signals in the cross-verify step.
  const truncated = text.slice(0, MAX_TEXT_LENGTH);
  const explicitUnit = detectExplicitUnitInText(truncated);
  const hasSmallDollars = hasExplicitSmallDollarAmounts(truncated);

  const systemPrompt = buildExtractionPrompt({
    includeSourceCitations: true,
    expectedPeriods: options?.expectedPeriods,
    lineItemHints: options?.lineItemHints,
    // Opt-in period-hygiene guidance (EXTRACTION_PERIOD_HYGIENE flag);
    // undefined when off, leaving the prompt unchanged.
    extraGuidance: periodHygieneGuidanceIfEnabled(),
  });

  log.debug('Claude classifier starting', {
    model: SONNET_MODEL,
    textLength: truncated.length,
    explicitUnit,
    hasSmallDollars,
    hasPeriodHints: Boolean(options?.expectedPeriods),
    hasLineItemHints: Boolean(options?.lineItemHints),
  });

  try {
    // System prompt as a single text block carrying cache_control. When
    // ChatAnthropic sees a SystemMessage with array content, it forwards
    // the array as-is to the Anthropic API as `system: TextBlockParam[]`,
    // which preserves the inline cache_control marker. Caching the prompt
    // prefix saves ~90% of input cost on re-extractions.
    const systemMessage = new SystemMessage({
      content: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        } as never,
      ],
    });

    const userMessage = new HumanMessage(
      'Extract all financial statements from this document. Return JSON only — no surrounding prose, no markdown fences:\n\n' +
        truncated,
    );

    const response = await model.invoke([systemMessage, userMessage]);

    // ChatAnthropic concatenates text blocks (and skips thinking blocks)
    // automatically when materializing AIMessage.text. With adaptive
    // thinking, only the JSON-bearing text blocks reach this string.
    const textContent = response.text;

    if (!textContent) {
      log.error('Claude classifier: no text content in response');
      return null;
    }

    const cleaned = stripJsonFences(textContent);

    let raw: unknown;
    try {
      raw = JSON.parse(cleaned);
    } catch (parseErr) {
      log.error('Claude classifier: JSON parse failed', {
        error: String(parseErr),
        sample: cleaned.slice(0, 200),
      });
      return null;
    }

    // Same post-processing as the GPT path — keeps cross-verify diffs
    // grounded in real disagreements rather than normalization artifacts.
    const result = normalizeClassificationResult(raw);
    applyExplicitUnitOverride(result, explicitUnit);
    applySmallDollarActualsOverride(result, hasSmallDollars, explicitUnit);
    // Third-tier: per-statement source-quote matching. Catches synthesized
    // periods (LTM / Current Month) whose raw values are larger than the
    // small-dollar magnitude threshold but whose source quotes literally
    // cite "$1,473" / "~$15,600".
    applySourceTextDollarOverride(result);

    // Pull the raw Anthropic Usage object from response_metadata so we
    // log the same uncached input_tokens the SDK reported (the
    // usage_metadata.input_tokens field is the *combined* total of raw
    // input + cache_read + cache_creation, which would change semantics).
    const rawUsage =
      ((response.response_metadata as { usage?: Anthropic.Usage } | undefined)
        ?.usage) ?? undefined;

    log.debug('Claude classifier completed', {
      model: SONNET_MODEL,
      statementsFound: result.statements.length,
      overallConfidence: result.overallConfidence,
      cacheReadTokens: rawUsage?.cache_read_input_tokens,
      cacheWriteTokens: rawUsage?.cache_creation_input_tokens,
      inputTokens: rawUsage?.input_tokens,
      outputTokens: rawUsage?.output_tokens,
    });

    return result;
  } catch (err) {
    // SDK typed exceptions per shared/error-codes.md — most-specific first.
    // ChatAnthropic uses the bare SDK under the hood, so the same error
    // classes still surface through .invoke() rejections.
    if (err instanceof Anthropic.RateLimitError) {
      log.warn('Claude classifier: rate limited (retry handled by SDK already exhausted)');
    } else if (err instanceof Anthropic.AuthenticationError) {
      log.error('Claude classifier: authentication failed — check ANTHROPIC_API_KEY');
    } else if (err instanceof Anthropic.APIError) {
      log.error('Claude classifier: API error', {
        status: err.status,
        message: err.message,
      });
    } else {
      log.error('Claude classifier: unexpected error', err);
    }
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Strip ```json ... ``` fences if Sonnet decided to wrap the JSON despite
 * the "no markdown fences" instruction. Defensive — most responses come
 * back as bare JSON, but assert no parse errors when they don't.
 */
function stripJsonFences(text: string): string {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, '');
  s = s.replace(/\n?```\s*$/, '');
  return s.trim();
}
