// ─── AI Error Classification ────────────────────────────────────────
// Maps raw LLM errors to specific, user-friendly messages.
// Used by all AI agents for consistent error reporting.

import { AppError } from '../middleware/errorHandler.js';
import { UserBlockedError } from '../services/usage/enforcement.js';

export type AIErrorResponse = {
  statusCode: number;
  userMessage: string;
  code: string;
};

/**
 * Thrown by the AI circuit breaker when a provider is in the "open"
 * state — fail-fast so we stop hammering a degraded backend. Extends
 * AppError so the global error handler surfaces it as 503 with the
 * AI_PROVIDER_UNAVAILABLE code.
 */
export class AIProviderUnavailableError extends AppError {
  provider: string;
  /** Why the provider rejected us — set when thrown for a classified rejection. */
  reason: ProviderRejectionReason | null;
  /** Raw provider message (for logs / admins). */
  detail: string | null;

  constructor(provider: string, opts?: { reason?: ProviderRejectionReason; detail?: string }) {
    super(providerUnavailableMessage(provider, opts?.reason), 503, 'AI_PROVIDER_UNAVAILABLE');
    this.provider = provider;
    this.reason = opts?.reason ?? null;
    this.detail = opts?.detail ?? null;
  }
}

/**
 * Provider-level rejections that are NEVER the document's or the user's
 * fault: billing, bad key, rate limit, overload. Routes must surface these
 * as 503 AI_PROVIDER_UNAVAILABLE instead of the "couldn't identify any deal
 * information" content error (2026-09-19 prod incident: OpenAI out of
 * credit → every ingest told users their CIM had no deal data).
 */
export type ProviderRejectionReason = 'quota' | 'auth' | 'rate_limit' | 'overloaded';

const QUOTA_HINTS = [
  'credit balance',
  'credit_balance',
  'no credits remaining',
  'quota exceeded',
  'insufficient quota',
  'insufficient_quota',
  'insufficient_credit',
  'billing',
  'payment required',
  'organization is restricted',
];

function providerUnavailableMessage(provider: string, reason?: ProviderRejectionReason): string {
  switch (reason) {
    case 'quota':
      return `AI service (${provider}) rejected the request: API credits are exhausted. This is a billing/configuration issue on our side, not a problem with your document — please contact your administrator.`;
    case 'auth':
      return `AI service (${provider}) rejected the request: the API key is invalid or missing. This is a configuration issue on our side, not a problem with your document — please contact your administrator.`;
    case 'rate_limit':
      return `AI service (${provider}) is rate-limiting requests. Please wait a moment and try again.`;
    case 'overloaded':
      return `AI service (${provider}) is overloaded. Please try again in a moment.`;
    default:
      return `AI service (${provider}) is temporarily unavailable. Please try again in a moment.`;
  }
}

/**
 * Classify a raw SDK / LangChain error as a provider rejection, or null when
 * it is anything else (schema mismatch, parse failure, network, timeout…).
 * Shared by the LLM fallback chain (decides whether to try the next key) and
 * the extractor (decides whether to surface a 503 instead of returning null).
 */
export function classifyProviderRejection(
  err: unknown,
): { reason: ProviderRejectionReason; detail: string } | null {
  if (!err) return null;
  const e = err as any;
  const status: unknown = e?.status ?? e?.statusCode ?? e?.error?.status;
  const errType: unknown = e?.error?.type ?? e?.error?.error?.type ?? e?.type;
  const code: unknown = e?.code ?? e?.error?.code;
  const detail = String(e?.message ?? e?.error?.message ?? e?.error?.error?.message ?? '');
  const lower = detail.toLowerCase();

  const isQuota =
    errType === 'insufficient_quota' ||
    code === 'insufficient_quota' ||
    code === 'credit_balance_exhausted' ||
    status === 402 ||
    QUOTA_HINTS.some((h) => lower.includes(h));
  if (isQuota) return { reason: 'quota', detail };

  if (errType === 'authentication_error' || errType === 'permission_error' || status === 401 || status === 403) {
    return { reason: 'auth', detail };
  }
  if (errType === 'overloaded_error' || status === 529) return { reason: 'overloaded', detail };
  if (errType === 'rate_limit_error' || status === 429) return { reason: 'rate_limit', detail };
  return null;
}

/**
 * Classify an unknown error (Error object or string) into a structured
 * HTTP response descriptor. Handles UserBlockedError as a 403 so callers
 * don't need to import enforcement.ts themselves.
 *
 * Usage in route catch blocks:
 *   const { statusCode, userMessage } = classifyAIErrorObject(error);
 *   res.status(statusCode).json({ error: userMessage });
 */
export function classifyAIErrorObject(err: unknown): AIErrorResponse {
  if (err instanceof UserBlockedError) {
    return {
      statusCode: 403,
      userMessage: 'Your AI access has been paused. Please contact support.',
      code: 'AI_USER_BLOCKED',
    };
  }

  // Circuit breaker explicitly tripped — surface the provider name and a
  // human-friendly message. Must check BEFORE the generic 5xx classifier
  // below since AIProviderUnavailableError is an Error subclass.
  if (err instanceof AIProviderUnavailableError) {
    return {
      statusCode: 503,
      userMessage: err.message,
      code: 'AI_PROVIDER_UNAVAILABLE',
    };
  }

  // Provider-side downtime signals: HTTP 5xx, Anthropic 529 "overloaded",
  // network errors. Distinct from AI_TIMEOUT (which is client-side cancel).
  const e = err as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = e?.status ?? e?.statusCode;
  const errCode = e?.code;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    (typeof status === 'number' && ((status >= 500 && status < 600) || status === 529)) ||
    errCode === 'ECONNRESET' ||
    errCode === 'ECONNREFUSED' ||
    errCode === 'ENOTFOUND' ||
    errCode === 'EAI_AGAIN' ||
    lower.includes('overloaded') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  ) {
    return {
      statusCode: 503,
      userMessage: 'AI service is temporarily unavailable. Please try again in a moment.',
      code: 'AI_PROVIDER_UNAVAILABLE',
    };
  }

  // Recursion limit — agent looped past its cap. 429 so the caller can
  // distinguish a runaway loop from a transient timeout.
  if (
    lower.includes('recursion limit') ||
    lower.includes('graphrecursionerror') ||
    lower.includes('graph_recursion_limit') ||
    // LangGraph attaches lc_error_code on the Error instance.
    (err as { lc_error_code?: string })?.lc_error_code === 'GRAPH_RECURSION_LIMIT'
  ) {
    return {
      statusCode: 429,
      userMessage: classifyAIError(msg),
      code: 'AI_RECURSION_LIMIT',
    };
  }

  // Timeout / abort — 504 so callers can retry.
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('econnaborted') ||
    lower.includes('aborterror') ||
    (err as { name?: string })?.name === 'AbortError'
  ) {
    return {
      statusCode: 504,
      userMessage: classifyAIError(msg),
      code: 'AI_TIMEOUT',
    };
  }

  return {
    statusCode: 500,
    userMessage: classifyAIError(msg),
    code: 'AI_ERROR',
  };
}

/** Classify an AI/LLM error into a specific user-facing message */
export function classifyAIError(errorMsg: string): string {
  const msg = errorMsg.toLowerCase();

  if (msg.includes('exceeded your current quota') || msg.includes('insufficient_quota')) {
    return 'AI quota exceeded — please check your API billing and plan at platform.openai.com/account/billing';
  }

  if (msg.includes('api key') || msg.includes('invalid_api_key') || msg.includes('incorrect api key')) {
    return 'AI API key is invalid or missing. Please check your configuration.';
  }

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('authentication')) {
    return 'AI service authentication failed. Please verify your API key.';
  }

  if (msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('429')) {
    return 'AI rate limit reached — too many requests. Please wait a moment and try again.';
  }

  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout') || msg.includes('econnaborted') || msg.includes('aborterror') || msg.includes('aborted')) {
    return 'AI request timed out. Try a shorter question or try again shortly.';
  }

  // LangGraph recursion limit — the ReAct agent looped past its cap.
  // Surfaces as either GraphRecursionError or lc_error_code GRAPH_RECURSION_LIMIT.
  if (msg.includes('recursion limit') || msg.includes('graphrecursionerror') || msg.includes('graph_recursion_limit')) {
    return 'AI got stuck in a tool loop. Please rephrase your question or try again.';
  }

  if (msg.includes('model_not_found') || msg.includes('does not exist') || msg.includes('model not found')) {
    return 'AI model not available. Please contact your administrator.';
  }

  if (msg.includes('context_length') || msg.includes('maximum context') || msg.includes('too many tokens')) {
    return 'Message too long for AI to process. Please shorten your question.';
  }

  if (msg.includes('content_filter') || msg.includes('content management policy')) {
    return 'AI content filter triggered. Please rephrase your question.';
  }

  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
    return 'Cannot reach AI service — network error. Please check your connection.';
  }

  // Default: include the actual error for transparency
  const truncated = errorMsg.length > 150 ? errorMsg.slice(0, 150) + '...' : errorMsg;
  return `AI error: ${truncated}`;
}
