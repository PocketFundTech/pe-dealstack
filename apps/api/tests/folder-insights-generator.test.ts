/**
 * services/folderInsightsGenerator — regression coverage for the
 * "Generate AI Insights still requires OpenAI" bug (2026-09-30): production
 * has no working OpenAI key, so every call 503'd with a message that told
 * the user to configure OPENAI_API_KEY even though the rest of the product
 * (memo sections, scorecard, extraction, ...) already runs on Anthropic via
 * trackedClaudeMessage. This asserts the generator now goes through the
 * Anthropic-backed path (services/ai/client.js) instead of the OpenAI
 * wrapper, and that a missing Anthropic key produces a clean null (which
 * the route turns into a 503 that does not mention OpenAI).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackedClaudeMessage = vi.fn();
const isAnthropicAvailable = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: (...args: any[]) => trackedClaudeMessage(...args),
  isAnthropicAvailable: () => isAnthropicAvailable(),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function getGenerator() {
  return await import('../src/services/folderInsightsGenerator.js');
}

const DEAL_CONTEXT = { dealName: 'Project Neptune', industry: 'Software', stage: 'DUE_DILIGENCE', revenue: 10, ebitda: 2 };
const DOCS = [{ name: 'CIM.pdf', type: 'PDF', size: '1.2 MB', createdAt: '2026-09-01T00:00:00Z' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateFolderInsights', () => {
  it('returns null without calling the model when Anthropic is not configured (no OpenAI fallback)', async () => {
    isAnthropicAvailable.mockReturnValue(false);
    const { generateFolderInsights } = await getGenerator();

    const result = await generateFolderInsights('Financials', DEAL_CONTEXT, DOCS);

    expect(result).toBeNull();
    expect(trackedClaudeMessage).not.toHaveBeenCalled();
  });

  it('calls trackedClaudeMessage (the Anthropic-backed path) with a structured output schema', async () => {
    isAnthropicAvailable.mockReturnValue(true);
    trackedClaudeMessage.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Mostly complete, missing tax returns.',
        completionPercent: 70,
        redFlags: [{ id: 'rf1', severity: 'high', title: 'No audited financials', description: 'Only unaudited statements present.' }],
        missingDocuments: [{ id: 'md1', name: 'Tax Returns (last 3 years)' }],
      }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 500, outputTokens: 120 },
    });

    const { generateFolderInsights } = await getGenerator();
    const result = await generateFolderInsights('Financials', DEAL_CONTEXT, DOCS);

    expect(trackedClaudeMessage).toHaveBeenCalledTimes(1);
    const call = trackedClaudeMessage.mock.calls[0][0];
    expect(call.operation).toBe('folder_insights');
    expect(call.role).toBe('chat');
    expect(call.outputSchema).toBeDefined();
    expect(call.messages[0].content).toContain('Project Neptune');
    expect(call.messages[0].content).toContain('CIM.pdf');

    // Output shape unchanged — matches what transformInsights (web-next)
    // and the FolderInsight table both expect.
    expect(result).toEqual({
      summary: 'Mostly complete, missing tax returns.',
      completionPercent: 70,
      redFlags: [{ id: 'rf1', severity: 'high', title: 'No audited financials', description: 'Only unaudited statements present.' }],
      missingDocuments: [{ id: 'md1', name: 'Tax Returns (last 3 years)' }],
    });
  });

  it('normalizes a malformed model response (missing/out-of-range fields) instead of throwing', async () => {
    isAnthropicAvailable.mockReturnValue(true);
    trackedClaudeMessage.mockResolvedValue({
      text: JSON.stringify({ completionPercent: 150, redFlags: [{}], missingDocuments: [{}] }),
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    const { generateFolderInsights } = await getGenerator();
    const result = await generateFolderInsights('Legal', DEAL_CONTEXT, []);

    expect(result?.completionPercent).toBe(100);
    expect(result?.summary).toBe('Analysis complete.');
    expect(result?.redFlags[0]).toMatchObject({ id: 'rf-1', severity: 'medium', title: 'Issue Found' });
    expect(result?.missingDocuments[0]).toMatchObject({ id: 'md-1', name: 'Unknown Document' });
  });

  // The route needs the real reason (out of credit, rate limit…) to tell
  // the user; null is reserved for "Anthropic isn't configured".
  it('passes a model-call error up to the route instead of hiding it as null', async () => {
    isAnthropicAvailable.mockReturnValue(true);
    trackedClaudeMessage.mockImplementation(async () => { throw new Error('rate limited'); });

    const { generateFolderInsights } = await getGenerator();
    await expect(generateFolderInsights('Financials', DEAL_CONTEXT, DOCS)).rejects.toThrow('rate limited');
  });
});
