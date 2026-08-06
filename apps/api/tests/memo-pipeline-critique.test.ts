/**
 * memoAgent/pipeline.ts — critiqueAndRevise tests (Phase 2-C).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';
import type { GeneratedSection } from '../src/services/agents/memoAgent/pipeline.js';

const trackedClaudeMessage = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => true,
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

const context: MemoContext = {
  deal: {
    id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null,
    industry: 'Software', revenue: 10, ebitda: 2, dealSize: 50,
    irrProjected: null, mom: null, aiThesis: null, description: null, source: null,
  },
  company: null,
  financials: [],
  documents: [],
  activity: [],
  team: { leadPartner: null, analyst: null, members: [] },
  dataAvailability: { hasFinancials: false, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
};

function sections(): GeneratedSection[] {
  return [
    { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: '<p>Weak thesis.</p>', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 1 },
    { type: 'RISK_ASSESSMENT', title: 'Risk Assessment', content: '<p>Generic risks.</p>', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 2 },
  ];
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
});

describe('critiqueAndRevise', () => {
  it('returns sections unchanged when the critique passes', async () => {
    trackedClaudeMessage.mockResolvedValueOnce({
      text: JSON.stringify({
        overallPass: true,
        dimensions: [
          { name: 'thesis_clarity', score: 4, pass: true },
          { name: 'financial_grounding', score: 4, pass: true },
          { name: 'risk_coverage', score: 4, pass: true },
          { name: 'actionability', score: 4, pass: true },
        ],
        sectionsNeedingRevision: [],
      }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 800, outputTokens: 100 },
    });
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1); // critique only, no revise call
    expect(result).toEqual(original);
  });

  it('revises only the flagged sections when the critique fails', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [
            { name: 'thesis_clarity', score: 2, pass: false, issue: 'No clear recommendation' },
            { name: 'financial_grounding', score: 4, pass: true },
            { name: 'risk_coverage', score: 4, pass: true },
            { name: 'actionability', score: 4, pass: true },
          ],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 800, outputTokens: 120 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          revisedSections: [
            { type: 'EXECUTIVE_SUMMARY', content: '<h3>Recommendation</h3><p>BUY — strong thesis.</p>' },
          ],
        }),
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 600, outputTokens: 80 },
      });
    const { critiqueAndRevise } = await getPipeline();
    const result = await critiqueAndRevise(sections(), context);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(2);
    expect(result.find((s) => s.type === 'EXECUTIVE_SUMMARY')?.content).toContain('BUY');
    // Untouched section stays byte-identical
    expect(result.find((s) => s.type === 'RISK_ASSESSMENT')?.content).toBe('<p>Generic risks.</p>');
  });

  it('silently skips a revised section type that does not match any real section', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          revisedSections: [{ type: 'NOT_A_REAL_SECTION', content: '<p>hallucinated</p>' }],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      });
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original); // nothing matched, nothing changed, no throw
  });

  it('returns original sections unchanged when the critique call fails', async () => {
    trackedClaudeMessage.mockRejectedValueOnce(new Error('timeout'));
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original);
    expect(captureAgentError).toHaveBeenCalled();
  });

  it('returns original sections unchanged when the revise call fails', async () => {
    trackedClaudeMessage
      .mockResolvedValueOnce({
        text: JSON.stringify({
          overallPass: false,
          dimensions: [{ name: 'thesis_clarity', score: 2, pass: false, issue: 'weak' }],
          sectionsNeedingRevision: ['EXECUTIVE_SUMMARY'],
        }),
        model: 'claude-sonnet-5', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockRejectedValueOnce(new Error('timeout'));
    const { critiqueAndRevise } = await getPipeline();
    const original = sections();
    const result = await critiqueAndRevise(original, context);
    expect(result).toEqual(original);
    expect(captureAgentError).toHaveBeenCalled();
  });
});
