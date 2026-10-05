/**
 * Fix plan G5: an AI provider rejection (out of credit, bad key, rate limit)
 * must reach the user as that reason — not as "no financial data found".
 *
 * Before: classifyFinancials / classifyFinancialsWithClaude caught every
 * error and returned null, cross-verify returned null when both did, and the
 * extract node turned null into a "completed" run with 0 periods. With prod
 * out of credit, every extraction said the document had no financials.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackedChatCompletion = vi.fn();
vi.mock('../src/openai.js', () => ({
  openai: {},
  isAIEnabled: () => true,
  trackedChatCompletion: (...a: unknown[]) => trackedChatCompletion(...a),
}));

const classifyFinancialsWithClaude = vi.fn();
vi.mock('../src/services/claudeFinancialClassifier.js', () => ({
  isClaudeClassifierEnabled: () => true,
  classifyFinancialsWithClaude: (...a: unknown[]) => classifyFinancialsWithClaude(...a),
}));

import { classifyFinancials, type ClassificationResult } from '../src/services/financialClassifier.js';
import { classifyFinancialsCrossVerified } from '../src/services/financialCrossVerify.js';
import { AIProviderUnavailableError, toProviderUnavailable } from '../src/utils/aiErrors.js';

const TEXT = 'Income statement FY2024 revenue 27.3 EBITDA 2.2 '.repeat(5);

/** What the OpenAI SDK throws when the account has no credit. */
function openAiOutOfCredit() {
  return Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), {
    status: 429, code: 'insufficient_quota',
  });
}

/** What the Anthropic SDK throws when the account has no credit. */
function anthropicOutOfCredit() {
  return Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 });
}

const claudeResult: ClassificationResult = {
  statements: [{
    statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD',
    periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { revenue: 27.3 } }],
  }],
  overallConfidence: 90,
  warnings: [],
};

beforeEach(() => {
  trackedChatCompletion.mockReset();
  classifyFinancialsWithClaude.mockReset();
});

describe('toProviderUnavailable', () => {
  it('turns a provider rejection into AIProviderUnavailableError, and nothing else', () => {
    const e = toProviderUnavailable(openAiOutOfCredit(), 'OpenAI');
    expect(e).toBeInstanceOf(AIProviderUnavailableError);
    expect(e!.reason).toBe('quota');
    expect(e!.message).toContain('OpenAI');
    expect(e!.message).toContain('credits are exhausted');
    expect(toProviderUnavailable(new SyntaxError('Unexpected token'), 'OpenAI')).toBeNull();
  });
});

describe('classifyFinancials (GPT path)', () => {
  it('throws the provider rejection instead of returning "no data"', async () => {
    trackedChatCompletion.mockRejectedValue(openAiOutOfCredit());
    await expect(classifyFinancials(TEXT)).rejects.toBeInstanceOf(AIProviderUnavailableError);
  });

  it('still returns null for a non-provider failure (bad JSON)', async () => {
    trackedChatCompletion.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    await expect(classifyFinancials(TEXT)).resolves.toBeNull();
  });
});

describe('classifyFinancialsCrossVerified', () => {
  it('throws when both providers reject — the reason, not "no financial data"', async () => {
    trackedChatCompletion.mockRejectedValue(openAiOutOfCredit());
    classifyFinancialsWithClaude.mockRejectedValue(toProviderUnavailable(anthropicOutOfCredit(), 'Anthropic'));
    await expect(classifyFinancialsCrossVerified(TEXT)).rejects.toBeInstanceOf(AIProviderUnavailableError);
  });

  it('uses the side that worked and says why the other was skipped', async () => {
    trackedChatCompletion.mockRejectedValue(openAiOutOfCredit());
    classifyFinancialsWithClaude.mockResolvedValue(claudeResult);
    const r = await classifyFinancialsCrossVerified(TEXT);
    expect(r!.statements).toHaveLength(1);
    expect(r!.warnings.join(' ')).toContain('OpenAI');
    expect(r!.warnings.join(' ')).toContain('credits are exhausted');
  });
});
