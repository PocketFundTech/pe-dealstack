/**
 * Tracked Anthropic client wrapper tests (Phase 1 AI core swap).
 * The SDK is mocked; assertions cover request shaping, refusal handling,
 * and UsageEvent recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamCalls: any[] = [];
const streamOptions: any[] = [];
const toolRunnerCalls: any[] = [];
const toolRunnerOptions: any[] = [];
let nextFinalMessage: any;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (req: any, opts?: any) => {
          streamCalls.push(req);
          streamOptions.push(opts);
          return { finalMessage: async () => nextFinalMessage };
        },
        toolRunner: (req: any, opts?: any) => {
          toolRunnerCalls.push(req);
          toolRunnerOptions.push(opts);
          return {};
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
  streamOptions.length = 0;
  toolRunnerCalls.length = 0;
  toolRunnerOptions.length = 0;
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

  // PROD REGRESSION (2026-08-14, D1): `signal` placed on the request BODY is
  // serialized into the JSON payload and the API rejects every call with
  // 400 invalid_request_error "signal: Extra inputs are not permitted"
  // (killed all memo section generation in prod). The AbortSignal must be
  // passed as SDK RequestOptions (second argument), never in the body.
  it('passes an AbortSignal as request options, never in the request body', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    const controller = new AbortController();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: controller.signal,
    });
    expect('signal' in streamCalls[0]).toBe(false);
    expect(streamOptions[0]?.signal).toBe(controller.signal);
  });

  it('omits betas entirely for roles with no beta flags (empty anthropic-beta header 400s)', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'memo_section_generation',
      role: 'memo',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect('betas' in streamCalls[0]).toBe(false);
  });

  it('passes tools into the request body when provided, omits the field otherwise', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    const codeExec = [{ type: 'code_execution_20250825', name: 'code_execution' }];
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: codeExec,
    });
    expect(streamCalls[0].tools).toEqual(codeExec);

    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect('tools' in streamCalls[1]).toBe(false);
  });

  it('omits signal from the request when not provided', async () => {
    nextFinalMessage = okMessage('ok');
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect('signal' in streamCalls[0]).toBe(false);
  });
});

describe('trackedClaudeStream', () => {
  it('passes an AbortSignal as request options, never in the toolRunner params', async () => {
    const { trackedClaudeStream } = await getClient();
    const controller = new AbortController();
    trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: controller.signal,
    });
    expect('signal' in toolRunnerCalls[0]).toBe(false);
    expect(toolRunnerOptions[0]?.signal).toBe(controller.signal);
  });

  it('keeps stream: true and omits signal options when no signal given', async () => {
    const { trackedClaudeStream } = await getClient();
    trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(toolRunnerCalls[0].stream).toBe(true);
    expect('signal' in toolRunnerCalls[0]).toBe(false);
    expect(toolRunnerOptions[0]?.signal).toBeUndefined();
  });
});

describe('isAnthropicAvailable', () => {
  it('is true when ANTHROPIC_API_KEY is set and false when it is not', async () => {
    const { isAnthropicAvailable } = await getClient();
    expect(isAnthropicAvailable()).toBe(true); // set in beforeEach
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAnthropicAvailable()).toBe(false);
  });
});
