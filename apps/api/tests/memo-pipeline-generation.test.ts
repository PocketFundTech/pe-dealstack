/**
 * memoAgent/pipeline.ts — generateSection/generateAllSections tests
 * (Phase 2-C: migrated to trackedClaudeMessage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';

const trackedClaudeMessage = vi.fn();
let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => anthropicAvailable,
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captureAgentError = vi.fn();
vi.mock('../src/utils/sentryHelpers.js', () => ({
  captureAgentError: (...args: any[]) => captureAgentError(...args),
}));

function baseContext(overrides: Partial<MemoContext> = {}): MemoContext {
  return {
    deal: {
      id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null,
      industry: 'Software', revenue: 10, ebitda: 2, dealSize: 50,
      irrProjected: null, mom: null, aiThesis: null, description: null, source: null,
    },
    company: null,
    financials: [
      { statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 }, extractionConfidence: 90, extractionSource: 'ai', isActive: true },
    ],
    documents: [],
    activity: [],
    team: { leadPartner: null, analyst: null, members: [] },
    dataAvailability: { hasFinancials: true, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
    ...overrides,
  };
}

async function getPipeline() {
  return await import('../src/services/agents/memoAgent/pipeline.js');
}

beforeEach(() => {
  trackedClaudeMessage.mockReset();
  captureAgentError.mockReset();
  anthropicAvailable = true;
  delete process.env.MEMO_SECTION_TIMEOUT_MS;
});

describe('generateSection', () => {
  it('calls trackedClaudeMessage with role memo and returns the served model as aiModel', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '<h3>Overview</h3><p>Strong company.</p>',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 100 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext(), undefined, 1);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.role).toBe('memo');
    expect(call.maxTokens).toBe(8000);
    expect(call.messages).toEqual([{ role: 'user', content: expect.stringContaining('Executive Summary') }]);

    expect(section.aiGenerated).toBe(true);
    expect(section.aiModel).toBe('claude-sonnet-5');
    expect(section.content).toContain('<h3>Overview</h3>');
  });

  it('returns a placeholder without calling the LLM when financials are required but missing', async () => {
    const { generateSection } = await getPipeline();
    const section = await generateSection(
      'FINANCIAL_PERFORMANCE',
      baseContext({ financials: [], dataAvailability: { hasFinancials: false, hasDocuments: false, hasDetailedDocs: false, hasCIM: false } }),
    );
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
    expect(section.aiGenerated).toBe(false);
    expect(section.aiModel).toBe('placeholder');
  });

  it('parses tableData out of a JSON response for table-bearing sections', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '```json\n{"content":"<p>See table.</p>","tableData":{"rows":[["Revenue","10"]]}}\n```',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 100 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('FINANCIAL_PERFORMANCE', baseContext());
    expect(section.content).toContain('See table');
    expect(section.tableData).toEqual({ rows: [['Revenue', '10']] });
  });

  // PROD REGRESSION (2026-08-18 QA pass): maxTokens was 2000, too small for the
  // JSON-envelope sections (narrative + tableData + chartConfig). All 5 such
  // sections came back truncated or EMPTY and persisted as blank sections in a
  // finished-looking memo — the worst failure mode, because it looks like the
  // model had nothing to say rather than like an error.
  it('fails loudly (error placeholder) instead of persisting an empty section', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '',
      model: 'claude-sonnet-5',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 8000 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('FINANCIAL_PERFORMANCE', baseContext());

    expect(section.content).not.toBe('');
    expect(section.content).toContain('Section generation failed');
    expect(section.content).toContain('token budget');
    expect(section.aiModel).toBe('error');
    expect(section.aiGenerated).toBe(false);
  });

  it('fails loudly on a whitespace-only response too', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '   \n  ',
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 2 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(section.content).toContain('Section generation failed');
    expect(section.aiModel).toBe('error');
  });

  it('keeps truncated-but-nonempty output rather than discarding it', async () => {
    trackedClaudeMessage.mockResolvedValue({
      text: '<p>Partial but useful analysis',
      model: 'claude-sonnet-5',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 8000 },
    });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(section.content).toContain('Partial but useful analysis');
    expect(section.aiGenerated).toBe(true);
  });

  it('retries once on a 429 and succeeds on the second attempt', async () => {
    trackedClaudeMessage
      .mockRejectedValueOnce(new Error('429 Rate limit exceeded'))
      .mockResolvedValueOnce({
        text: '<h3>Overview</h3><p>ok</p>',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 500, outputTokens: 100 },
      });
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(trackedClaudeMessage).toHaveBeenCalledTimes(2);
    expect(section.aiGenerated).toBe(true);
  });

  it('returns an error placeholder (not a throw) when the LLM call fails after retries', async () => {
    trackedClaudeMessage.mockRejectedValue(new Error('Service unavailable'));
    const { generateSection } = await getPipeline();
    const section = await generateSection('EXECUTIVE_SUMMARY', baseContext());
    expect(section.aiGenerated).toBe(false);
    expect(section.aiModel).toBe('error');
    expect(captureAgentError).toHaveBeenCalled();
  });
});

describe('generateAllSections', () => {
  it('throws when Anthropic is unavailable, without calling trackedClaudeMessage', async () => {
    anthropicAvailable = false;
    const { generateAllSections } = await getPipeline();
    await expect(generateAllSections('deal-1', 'org-1')).rejects.toThrow('LLM is not available');
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });
});
