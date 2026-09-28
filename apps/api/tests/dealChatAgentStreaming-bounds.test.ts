import { describe, it, expect, vi, beforeEach } from 'vitest';

let nextRunnerIterations: any[] = [];
let shouldHang = false;
/** Thrown from the runner generator after all `nextRunnerIterations` have
 *  been yielded — simulates a mid-stream network error (not an abort). */
let throwAfterIterations: Error | null = null;

const recordUsageCalls: any[] = [];
const trackedClaudeStream = vi.fn((opts: any) => {
  const runner = (async function* () {
    for (const events of nextRunnerIterations) {
      if (shouldHang) {
        await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          );
        });
      }
      yield (async function* () {
        for (const e of events) yield e;
      })();
    }
    if (throwAfterIterations) throw throwAfterIterations;
  })();
  const recordUsage = vi.fn(async (...args: any[]) => { recordUsageCalls.push(args); });
  return { runner, recordUsage };
});

vi.mock('../src/services/ai/client.js', () => ({ trackedClaudeStream }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true, getChatModel: () => ({}) }));
vi.mock('../src/services/agents/dealChatAgent/tools.js', () => ({ getDealChatTools: () => [] }));
vi.mock('../src/services/ai/models.js', () => ({ getModelConfig: () => ({ model: 'claude-sonnet-5', maxTokens: 16000, betas: [] }) }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
// Real getFirmContextBlock() hits Supabase; unmocked it's a live network
// call against a fake test host that fails DNS (ENOTFOUND) and takes ~7s
// to give up, blowing past the timeout windows these tests assert on. The
// SUT already does `.catch(() => '')` around it, so mocking only removes
// the real-network wait — it doesn't change what the SUT sees.
vi.mock('../src/services/firmContextService.js', () => ({
  getFirmContextBlock: async () => '',
}));

beforeEach(() => {
  process.env.DEAL_CHAT_AGENT_TIMEOUT_MS = '150';
  nextRunnerIterations = [];
  shouldHang = false;
  throwAfterIterations = null;
  trackedClaudeStream.mockClear();
  recordUsageCalls.length = 0;
});

async function drain(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('runDealChatAgentStreaming bounds', () => {
  it('passes an AbortSignal to trackedClaudeStream', async () => {
    nextRunnerIterations = [[
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    ]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    expect(trackedClaudeStream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('completes a fast run and yields a done event with the accumulated text', async () => {
    nextRunnerIterations = [[
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fast reply' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const done = events.find((e) => e.type === 'done');
    expect(done.response).toBe('fast reply');
    expect(done.truncated).toBe(false);
  });

  it('yields an error event when the run never resolves within the timeout', async () => {
    shouldHang = true;
    nextRunnerIterations = [[{ type: 'message_start', message: { usage: { input_tokens: 0 } } }]];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const start = Date.now();
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const elapsed = Date.now() - start;
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/timed out/i);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it('stops after the iteration cap and yields an error event', async () => {
    nextRunnerIterations = Array.from({ length: 15 }, () => [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
    ]);
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toMatch(/maximum number of tool calls/i);
  });

  // Cost-accuracy (usage-cost-accuracy): message_start usage carries cache
  // tokens and the served model — both must be accumulated across the
  // ReAct loop's iterations and passed into recordUsage(), or a cached deal
  // chat turn drops most of its real input from the bill.
  it('accumulates cache tokens and the served model from message_start across iterations, then forwards them to recordUsage', async () => {
    nextRunnerIterations = [
      [
        {
          type: 'message_start',
          message: {
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 5000,
              cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
            },
          },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'part one ' } },
        { type: 'message_delta', usage: { output_tokens: 10 } },
      ],
      [
        {
          type: 'message_start',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 50, cache_read_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
          },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'part two' } },
        { type: 'message_delta', usage: { output_tokens: 5 } },
      ],
    ];
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    const done = events.find((e) => e.type === 'done');
    expect(done.response).toBe('part one part two');

    expect(recordUsageCalls).toHaveLength(1);
    const [usage, status, servedModel] = recordUsageCalls[0];
    expect(status).toBe('success');
    expect(servedModel).toBe('claude-sonnet-4-6');
    expect(usage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 10_000,
      cacheWrite5mTokens: 200,
      cacheWrite1hTokens: 0,
    });
  });

  it('forwards the served model on the error path too', async () => {
    nextRunnerIterations = [[
      { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 20 } } },
    ]];
    throwAfterIterations = new Error('mid-stream network error');
    const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
    const events = await drain(runDealChatAgentStreaming({ dealId: 'd1', orgId: 'o1', message: 'hi', dealContext: '' }));
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    expect(recordUsageCalls).toHaveLength(1);
    const [usage, status, servedModel] = recordUsageCalls[0];
    expect(status).toBe('error');
    expect(servedModel).toBe('claude-sonnet-4-6');
    expect(usage.inputTokens).toBe(20);
  });
});
