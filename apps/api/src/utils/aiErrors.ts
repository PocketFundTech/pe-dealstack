// ─── AI Error Classification ────────────────────────────────────────
// Maps raw LLM errors to specific, user-friendly messages.
// Used by all AI agents for consistent error reporting.

import { UserBlockedError } from '../services/usage/enforcement.js';

export type AIErrorResponse = {
  statusCode: number;
  userMessage: string;
  code: string;
};

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
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

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
