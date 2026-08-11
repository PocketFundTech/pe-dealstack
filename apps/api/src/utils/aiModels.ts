// ─── AI Model Tier Registry ────────────────────────────────────────
// Single source of truth for which model name each task tier uses.
// All call sites import from here instead of hardcoding 'gpt-4o' etc.
//
// Tier mapping (per architecture decision — see Peos AI Model.pdf):
//   tier 1  Claude Sonnet 4.5 (Anthropic direct) / GPT-4.1 (OpenAI direct) → memos, deal chat, extraction, analysis, meeting prep
//   tier 2  GPT-4.1 (OpenRouter) / GPT-4.1 (direct)             → classification, vision, insights, signals, enrichment
//   tier 3  GPT-4.1-mini (OpenRouter) / GPT-4.1-mini (direct)   → emails, search, quick tasks
//   tier 4  GPT-4.1-nano (OpenRouter) / GPT-4.1-nano (direct)   → sentiment, routing
//
// Routing strategy (post-OpenRouter-deprecation for tier 1):
//   - Tier 1 prefers Anthropic direct (claude-sonnet-4-6) via @langchain/anthropic
//     when ANTHROPIC_API_KEY is set. Falls back to OpenAI direct ('gpt-4.1') when
//     only OPENAI_API_KEY is set. Falls back to OpenRouter ('anthropic/claude-sonnet-4.6')
//     only when neither anthropic nor openai keys are present but OPENROUTER_API_KEY is.
//   - Tier 2-4 retain the legacy OpenRouter routing for now (the user only flagged
//     tier 1 as the routing problem). If OPENROUTER_API_KEY is set, the `openai`
//     SDK in src/openai.ts is pointed at openrouter.ai and the prefixed names below
//     ("openai/gpt-4.1") route through OpenRouter to the right model.
//   - Per-tier env overrides (LLM_TIER1_MODEL, ...) always win.

import dotenv from 'dotenv';
dotenv.config();

const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

// Direct-OpenAI fallbacks use the gpt-4.1 family (not gpt-4o): the gpt-4.1
// models support 32K completion tokens, whereas gpt-4o caps at 16,384. The
// financial extractor requests up to 32K max_tokens, so gpt-4o 400s.
export const AI_MODELS = {
  /** Tier 1 — premium reasoning (Anthropic direct / OpenRouter / gpt-4.1 direct) */
  TIER1:
    process.env.LLM_TIER1_MODEL ||
    (hasAnthropic
      ? 'claude-sonnet-4-6'
      : useOpenRouter
        ? 'anthropic/claude-sonnet-4.6'
        : 'gpt-4.1'),
  /** Tier 2 — general including vision (gpt-4.1 direct) */
  TIER2:
    process.env.LLM_TIER2_MODEL ||
    (useOpenRouter ? 'openai/gpt-4.1' : 'gpt-4.1'),
  /** Tier 3 — fast/cheap (gpt-4.1-mini direct) */
  TIER3:
    process.env.LLM_TIER3_MODEL ||
    (useOpenRouter ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini'),
  /** Tier 4 — ultra-fast/cheap (gpt-4.1-nano direct) */
  TIER4:
    process.env.LLM_TIER4_MODEL ||
    (useOpenRouter ? 'openai/gpt-4.1-nano' : 'gpt-4.1-nano'),
} as const;

// ─── Semantic aliases — use these in call sites ────────────────────

/** Memos, deal chat, financial extraction, analysis */
export const MODEL_REASONING = AI_MODELS.TIER1;

/** Classification, document insights, vision (image understanding) */
export const MODEL_CLASSIFICATION = AI_MODELS.TIER2;
export const MODEL_INSIGHTS = AI_MODELS.TIER2;

/** Emails, search, quick narrative summaries */
export const MODEL_FAST = AI_MODELS.TIER3;

/** Sentiment, routing — cheapest */
export const MODEL_NANO = AI_MODELS.TIER4;

// ─── Provider availability helpers ─────────────────────────────────

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function isOpenRouterEnabled(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/**
 * True when ANTHROPIC_API_KEY is present. When true, tier-1 callsites
 * (deal chat, memos, extraction reasoning) route through @langchain/anthropic
 * directly instead of OpenRouter or OpenAI.
 */
export function isAnthropicEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Headers OpenRouter recommends for attribution / rate-limit pools */
export const OPENROUTER_HEADERS = {
  'HTTP-Referer': process.env.APP_URL || 'https://lmmos.ai',
  'X-Title': 'lmmos',
};
