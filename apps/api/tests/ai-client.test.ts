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
/** When set, finalMessage() rejects with this error instead of resolving —
 *  used to test the error/abort path's partial-usage recording. */
let nextFinalMessageError: Error | null = null;
/** Snapshot the mocked BetaMessageStream exposes via its `currentMessage`
 *  getter — mirrors the real SDK accumulating usage from message_start/
 *  message_delta events before an error/abort. */
let nextCurrentMessage: any;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (req: any, opts?: any) => {
          streamCalls.push(req);
          streamOptions.push(opts);
          return {
            finalMessage: async () => {
              if (nextFinalMessageError) throw nextFinalMessageError;
              return nextFinalMessage;
            },
            get currentMessage() {
              return nextCurrentMessage;
            },
          };
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
  nextFinalMessageError = null;
  nextCurrentMessage = undefined;
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

  // Cost-accuracy (usage-cost-accuracy): Anthropic's usage.input_tokens
  // EXCLUDES cached tokens, so a prompt-cached call must record
  // cache_read_input_tokens / cache_creation.ephemeral_5m/1h separately or
  // the ledger silently drops most of the real input from the bill.
  it('records cache read / 5m-write / 1h-write tokens from message.usage', async () => {
    nextFinalMessage = {
      model: 'claude-fable-5',
      stop_reason: 'end_turn',
      stop_details: null,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 20_000,
        cache_creation: { ephemeral_5m_input_tokens: 3_000, ephemeral_1h_input_tokens: 1_000 },
      },
    };
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(recorded[0]).toMatchObject({
      promptTokens: 500,
      completionTokens: 100,
      cacheReadTokens: 20_000,
      cacheWrite5mTokens: 3_000,
      cacheWrite1hTokens: 1_000,
    });
  });

  // Server-side refusal fallback: top-level usage covers ONLY the attempt
  // that produced the returned message. A Fable attempt the classifier cut
  // off mid-output is still billed (at Fable rates) and appears only in
  // usage.iterations — it was missing from the ledger entirely.
  it('records a declined attempt that produced output as its own blocked row at its own model', async () => {
    nextFinalMessage = {
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      stop_details: null,
      content: [{ type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 900,
        output_tokens: 200,
        iterations: [
          { type: 'message', model: 'claude-fable-5', input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 5_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 900, output_tokens: 200 },
        ],
      },
    };
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(recorded).toHaveLength(2);
    expect(recorded).toContainEqual(expect.objectContaining({
      status: 'blocked', model: 'claude-fable-5', promptTokens: 800, completionTokens: 150, cacheReadTokens: 5_000,
    }));
    // The served hop is still recorded exactly once, from top-level usage.
    expect(recorded).toContainEqual(expect.objectContaining({
      status: 'success', model: 'claude-opus-4-8', promptTokens: 900, completionTokens: 200,
    }));
  });

  it('does not record a declined-before-output attempt (Anthropic does not bill it)', async () => {
    nextFinalMessage = {
      model: 'claude-opus-4-8',
      stop_reason: 'end_turn',
      stop_details: null,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 900,
        output_tokens: 200,
        iterations: [
          { type: 'message', model: 'claude-fable-5', input_tokens: 800, output_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 900, output_tokens: 200 },
        ],
      },
    };
    const { trackedClaudeMessage } = await getClient();
    await trackedClaudeMessage({
      operation: 'financial_extraction',
      role: 'extraction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: 'success', model: 'claude-opus-4-8' });
  });

  // Prod incident risk: an aborted/errored call still bills whatever the
  // stream had already received (Anthropic charges for tokens processed
  // regardless of how the request ended). Recording 0/0 silently under-bills
  // every abort/error on a large prompt.
  it('records partial usage from the stream snapshot on error/abort instead of 0/0', async () => {
    nextFinalMessageError = new Error('stream aborted');
    nextCurrentMessage = {
      model: 'claude-fable-5',
      usage: {
        input_tokens: 800,
        output_tokens: 15,
        cache_read_input_tokens: 5_000,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
      },
    };
    const { trackedClaudeMessage } = await getClient();
    await expect(
      trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).rejects.toThrow('stream aborted');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: 'error',
      model: 'claude-fable-5',
      promptTokens: 800,
      completionTokens: 15,
      cacheReadTokens: 5_000,
      cacheWrite5mTokens: 200,
      cacheWrite1hTokens: 0,
    });
  });

  it('falls back to 0 usage on error when the stream never produced a snapshot', async () => {
    nextFinalMessageError = new Error('immediate network failure');
    nextCurrentMessage = undefined;
    const { trackedClaudeMessage } = await getClient();
    await expect(
      trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).rejects.toThrow('immediate network failure');
    expect(recorded[0]).toMatchObject({ status: 'error', promptTokens: 0, completionTokens: 0 });
  });

  it('does not let a ledger failure propagate to the caller', async () => {
    nextFinalMessage = okMessage('ok');
    const { recordUsageEvent } = await import('../src/services/usage/trackedLLM.js');
    vi.mocked(recordUsageEvent).mockRejectedValueOnce(new Error('db down'));
    const { trackedClaudeMessage } = await getClient();
    await expect(
      trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).resolves.toMatchObject({ text: 'ok' });
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

  it('passes a block-form system prompt through unchanged and enables request-level caching when asked', async () => {
    const { trackedClaudeStream } = await getClient();
    const system = [
      { type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'deal context', cache_control: { type: 'ephemeral' } },
    ];
    trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      system: system as any,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      autoCache: true,
    });
    expect(toolRunnerCalls[0].system).toEqual(system);
    expect(toolRunnerCalls[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not add request-level caching unless the caller asks for it', async () => {
    const { trackedClaudeStream } = await getClient();
    trackedClaudeStream({ operation: 'x', role: 'chat', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect('cache_control' in toolRunnerCalls[0]).toBe(false);
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

  it('recordUsage prefers the caller-supplied served model and forwards cache tokens', async () => {
    const { trackedClaudeStream } = await getClient();
    const { recordUsage } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    await recordUsage(
      { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWrite5mTokens: 50, cacheWrite1hTokens: 0 },
      'success',
      'claude-fable-5-1',
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'deal_chat',
      model: 'claude-fable-5-1',
      promptTokens: 100,
      completionTokens: 40,
      cacheReadTokens: 900,
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 0,
      status: 'success',
    });
  });

  it('recordUsage falls back to the requested role alias when no served model is passed', async () => {
    const { trackedClaudeStream } = await getClient();
    const { recordUsage } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    await recordUsage({ inputTokens: 10, outputTokens: 5 }, 'success');
    expect(recorded[0].model).toBe(toolRunnerCalls[0].model);
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
