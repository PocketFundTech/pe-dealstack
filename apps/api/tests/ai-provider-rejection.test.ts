/**
 * Provider-rejection propagation from the legacy extractor.
 *
 * Bug (2026-09-19): every OpenAI call in prod returned 429
 * "insufficient_quota" and extractDealDataFromText swallowed it into
 * `null`, so ingest routes told users the AI "couldn't identify any deal
 * information" — a document problem — when the real cause was billing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const invoke = vi.fn();
vi.mock('../src/services/llm.js', () => {
  const model = { withStructuredOutput: () => ({ invoke }) };
  return {
    isLLMAvailable: () => true,
    getExtractionModel: () => model,
    getModel: () => model,
    getChatProviderName: () => 'openai/gpt-4o',
  };
});

const quotaError = Object.assign(
  new Error('429 You have no credits remaining. Add credits to continue using the API.'),
  { status: 429, code: 'credit_balance_exhausted', error: { type: 'insufficient_quota' } },
);

const TEXT = 'Acme Corp is a manufacturer with FY2025 revenue of $48.2 million and EBITDA of $9.1 million. '.repeat(3);

describe('classifyProviderRejection', () => {
  it('recognises quota, auth, rate-limit and overload rejections', async () => {
    const { classifyProviderRejection } = await import('../src/utils/aiErrors.js');
    expect(classifyProviderRejection(quotaError)?.reason).toBe('quota');
    expect(classifyProviderRejection({ status: 401, message: 'API key is invalid.' })?.reason).toBe('auth');
    expect(classifyProviderRejection({ status: 429, message: 'Rate limit reached' })?.reason).toBe('rate_limit');
    expect(classifyProviderRejection({ status: 529, message: 'Overloaded' })?.reason).toBe('overloaded');
    expect(classifyProviderRejection({ status: 400, message: 'credit balance is too low' })?.reason).toBe('quota');
  });

  it('returns null for document / schema errors', async () => {
    const { classifyProviderRejection } = await import('../src/utils/aiErrors.js');
    expect(classifyProviderRejection(new Error('Zod parse failed'))).toBeNull();
    expect(classifyProviderRejection({ status: 400, message: 'invalid schema' })).toBeNull();
  });
});

describe('extractDealDataFromText provider rejection', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockRejectedValue(quotaError);
  });

  it('returns null by default (background callers keep today\'s contract)', async () => {
    const { extractDealDataFromText } = await import('../src/services/aiExtractor.js');
    await expect(extractDealDataFromText(TEXT)).resolves.toBeNull();
  });

  it('throws AIProviderUnavailableError with reason=quota when asked to surface rejections', async () => {
    const { extractDealDataFromText } = await import('../src/services/aiExtractor.js');
    const { AIProviderUnavailableError } = await import('../src/utils/aiErrors.js');
    const p = extractDealDataFromText(TEXT, { throwOnProviderError: true });
    await expect(p).rejects.toBeInstanceOf(AIProviderUnavailableError);
    await p.catch((e) => {
      expect(e.statusCode).toBe(503);
      expect(e.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(e.reason).toBe('quota');
      expect(e.message).toMatch(/credit|billing/i);
      expect(e.message).not.toMatch(/deal information/i);
    });
  });

  it('still returns null for non-provider errors even when surfacing is on', async () => {
    invoke.mockRejectedValue(new Error('Zod parse failed'));
    const { extractDealDataFromText } = await import('../src/services/aiExtractor.js');
    await expect(extractDealDataFromText(TEXT, { throwOnProviderError: true })).resolves.toBeNull();
  });
});
