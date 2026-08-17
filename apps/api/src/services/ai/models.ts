/**
 * AI role → Anthropic model map (Phase 1 AI core swap).
 * Single source of truth replacing utils/aiModels.ts tiers for new call sites.
 *
 * Roles (spec 2026-07-11, memo added 2026-08-07):
 *   extraction → claude-fable-5 (founder decision; env-downgradable)
 *   chat       → claude-sonnet-5
 *   fast       → claude-haiku-4-5
 *   memo       → claude-sonnet-5 (section generation + rubric critique/revise)
 *
 * Fable 5 request shaping handled here so call sites never branch:
 *   - never send a `thinking` param (explicit disable 400s on Fable 5)
 *   - server-side refusal fallback to claude-opus-4-8
 */

export type AiRole = 'extraction' | 'chat' | 'fast' | 'memo';

export interface ModelConfig {
  model: string;
  maxTokens: number;
  /** anthropic-beta flags this model requires (callers may append more). */
  betas: string[];
  /** Server-side refusal fallback chain (Fable 5 only). */
  fallbacks?: Array<{ model: string }>;
}

const DEFAULTS: Record<AiRole, string> = {
  extraction: 'claude-fable-5',
  chat: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5',
  memo: 'claude-sonnet-5',
};

const ENV_OVERRIDES: Record<AiRole, string> = {
  extraction: 'AI_EXTRACTION_MODEL',
  chat: 'AI_CHAT_MODEL',
  fast: 'AI_FAST_MODEL',
  memo: 'AI_MEMO_MODEL',
};

const MAX_TOKENS: Record<AiRole, number> = {
  extraction: 64000, // large multi-period JSON output
  chat: 16000,
  fast: 4096,
  memo: 4000,
};

export function getModelConfig(role: AiRole): ModelConfig {
  const model = process.env[ENV_OVERRIDES[role]] || DEFAULTS[role];
  const cfg: ModelConfig = { model, maxTokens: MAX_TOKENS[role], betas: [] };
  if (model === 'claude-fable-5') {
    cfg.betas.push('server-side-fallback-2026-06-01');
    cfg.fallbacks = [{ model: 'claude-opus-4-8' }];
  }
  return cfg;
}
