/**
 * Tracked Anthropic client wrapper tests (Phase 1 AI core swap).
 * The SDK is mocked; assertions cover request shaping, refusal handling,
 * and UsageEvent recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamCalls: any[] = [];
let nextFinalMessage: any;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (req: any) => {
          streamCalls.push(req);
          return { finalMessage: async () => nextFinalMessage };
        },
      },
      files: { upload: vi.fn() },
    };
  }
  return { default: MockAnthropic, toFile: vi.fn(async (b: any) => b) };
});

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => { recorded.push(e); }),
}));

function okMessage(text: string) {
  return {
    model: 'claude-fable-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1200, output_tokens: 340 },
  };
}

beforeEach(() => {
  streamCalls.length = 0;
  recorded.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.AI_EXTRACTION_MODEL;
});

async function getClient() {
  return await import('../src/services/ai/client.js');
}

describe('trackedClaudeMessage', () => {
  it('shapes a fable-5 extraction request: no thinking, fallbacks + betas, output_config', async () => {
    nextFinalMessage = okMessage('{"ok":true}');
    const { trackedClaudeMessage } = await getClient();
    const res = await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    });
    const req = streamCalls[0];
    expect(req.model).toBe('claude-fable-5');
    expect(req.thinking).toBeUndefined();
    expect(req.fallbacks).toEqual([{ model: 'claude-opus-4-8' }]);
    expect(req.betas).toContain('server-side-fallback-2026-06-01');
    expect(req.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    });
    expect(res.text).toBe('{"ok":true}');
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it('records a UsageEvent with the served model and token counts', async () => {
    nextFinalMessage = okMessage('x');
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'financial_extraction',
      provider: 'anthropic',
      model: 'claude-fable-5',
      promptTokens: 1200,
      completionTokens: 340,
      status: 'success',
    });
  });

  it('throws AIRefusalError on stop_reason refusal and records status blocked', async () => {
    nextFinalMessage = {
      model: 'claude-fable-5',
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const { trackedClaudeMessage, AIRefusalError } = await getClient();
    await expect(
      trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).rejects.toBeInstanceOf(AIRefusalError);
    expect(recorded[0]).toMatchObject({ status: 'blocked' });
  });
});
