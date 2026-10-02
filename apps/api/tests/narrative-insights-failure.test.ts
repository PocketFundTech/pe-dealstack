/**
 * Fix plan G6: AI Insights never shows a stand-in narrative when generation
 * fails. Before, every failure (out of credit, bad JSON, no key) returned a
 * placeholder ("AI insights are currently unavailable…") as a successful
 * result — and cached it, so it outlived the outage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let aiEnabled = true;
const trackedChatCompletion = vi.fn();
vi.mock('../src/openai.js', () => ({
  get openai() { return aiEnabled ? {} : null; },
  isAIEnabled: () => aiEnabled,
  trackedChatCompletion: (...a: unknown[]) => trackedChatCompletion(...a),
}));

let cachedRow: unknown = null;
vi.mock('../src/supabase.js', () => {
  const chain: any = {
    select: () => chain, eq: () => chain,
    single: async () => ({ data: cachedRow ? { insights: cachedRow } : null }),
    upsert: async () => ({ error: null }), delete: () => chain,
  };
  return { supabase: { from: () => chain } };
});

import { generateNarrativeInsights, getCachedInsights } from '../src/services/narrativeInsights.js';
import { AIProviderUnavailableError, aiErrorResponse } from '../src/utils/aiErrors.js';
import { AppError } from '../src/middleware/errorHandler.js';

const ctx = { dealName: 'SRM' };
const memory = { industry: [], portfolio: { dealCount: 0 } } as any;

beforeEach(() => {
  aiEnabled = true;
  cachedRow = null;
  trackedChatCompletion.mockReset();
});

describe('generateNarrativeInsights failures', () => {
  it('out of credit → the provider reason, not a placeholder narrative', async () => {
    trackedChatCompletion.mockRejectedValue(Object.assign(new Error('429 You exceeded your current quota'), { status: 429, code: 'insufficient_quota' }));
    const err = await generateNarrativeInsights({}, ctx, memory).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderUnavailableError);
    expect(err.message).toContain('credits are exhausted');
  });

  it('an unreadable AI answer says so and suggests Regenerate', async () => {
    trackedChatCompletion.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    const err = await generateNarrativeInsights({}, ctx, memory).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('AI_BAD_RESPONSE');
    expect(err.message).toContain('Regenerate');
  });

  it('no AI provider configured says that', async () => {
    aiEnabled = false;
    const err = await generateNarrativeInsights({}, ctx, memory).catch((e) => e);
    expect(err.code).toBe('AI_NOT_CONFIGURED');
  });
});

describe('insights cache', () => {
  it('ignores a placeholder cached by the old fallback, so it is regenerated', async () => {
    cachedRow = {
      modules: {},
      executiveSummary: 'AI insights are currently unavailable. Review the quantitative analysis above for key metrics.',
      topThreeRisks: [], topThreeStrengths: [], diligencePriorities: [], generatedAt: '2026-10-01T00:00:00Z',
    };
    expect(await getCachedInsights('deal-placeholder', 'hash-1')).toBeNull();
  });

  it('still returns a real cached narrative', async () => {
    cachedRow = { modules: { qoe: { headline: 'x', commentary: 'y', conviction: 'neutral' } }, executiveSummary: 'Solid.', topThreeRisks: [], topThreeStrengths: [], diligencePriorities: [], generatedAt: '' };
    expect((await getCachedInsights('deal-real', 'hash-2'))?.executiveSummary).toBe('Solid.');
  });
});

describe('aiErrorResponse', () => {
  it('passes an AppError through with its own status, message and code', () => {
    expect(aiErrorResponse(new AppError('Nope', 502, 'AI_BAD_RESPONSE'))).toEqual({ statusCode: 502, userMessage: 'Nope', code: 'AI_BAD_RESPONSE' });
  });
  it('classifies anything else like classifyAIErrorObject', () => {
    expect(aiErrorResponse(Object.assign(new Error('boom'), { status: 529 })).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });
});
