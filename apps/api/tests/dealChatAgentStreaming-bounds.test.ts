import { describe, it, expect, vi, beforeEach } from 'vitest';

let nextRunnerIterations: any[] = [];
let shouldHang = false;

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
  })();
  return { runner, recordUsage: vi.fn(async () => {}) };
});

vi.mock('../src/services/ai/client.js', () => ({ trackedClaudeStream }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true, getChatModel: () => ({}) }));
vi.mock('../src/services/agents/dealChatAgent/tools.js', () => ({ getDealChatTools: () => [] }));
vi.mock('../src/services/ai/models.js', () => ({ getModelConfig: () => ({ model: 'claude-sonnet-5', maxTokens: 16000, betas: [] }) }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

beforeEach(() => {
  process.env.DEAL_CHAT_AGENT_TIMEOUT_MS = '150';
  nextRunnerIterations = [];
  shouldHang = false;
  trackedClaudeStream.mockClear();
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
});
