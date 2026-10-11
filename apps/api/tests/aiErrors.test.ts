/**
 * QA 2026-10-11 (AI Reports deep test, finding B): the memo chat ("AI
 * Analyst" panel), deal chat, global chat, and streaming memo regeneration
 * all told users "AI API key is invalid or missing" for what was actually
 * Anthropic credit-balance exhaustion — confirmed live on app.avise.io by
 * sending a chat message while production AI was out of credit.
 *
 * Root cause: those call sites classify the error with the legacy
 * `classifyAIError(message: string)`, which has no awareness at all of
 * Anthropic's "credit balance is too low" phrasing (it only recognizes
 * OpenAI's "exceeded your current quota" / "insufficient_quota" wording).
 * `classifyAIErrorObject(err)` — already used correctly by every route in
 * ai-agents.ts and by memoAgent/pipeline.ts's section generator — inspects
 * structured fields (status, error.type) via classifyProviderRejection
 * first, and does recognize it.
 */
import { describe, it, expect } from 'vitest';
import { classifyAIError, classifyAIErrorObject } from '../src/utils/aiErrors.js';

const ANTHROPIC_CREDIT_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

describe('classifyAIError (legacy, string-only) — does not know Anthropic credit-balance wording', () => {
  it('fails to recognize Anthropic credit exhaustion as a quota issue', () => {
    const msg = `400 ${ANTHROPIC_CREDIT_MESSAGE}`;
    const result = classifyAIError(msg);
    expect(result).not.toMatch(/credit/i);
  });
});

describe('classifyAIErrorObject — correctly classifies Anthropic credit exhaustion', () => {
  it('reports it as exhausted credits, never as an invalid/missing API key', () => {
    const err = {
      status: 400,
      error: { type: 'invalid_request_error', message: ANTHROPIC_CREDIT_MESSAGE },
      message: `400 ${ANTHROPIC_CREDIT_MESSAGE}`,
    };
    const { userMessage, statusCode } = classifyAIErrorObject(err);
    expect(userMessage).toMatch(/credit/i);
    expect(userMessage).not.toMatch(/api key/i);
    expect(statusCode).toBe(503);
  });
});
