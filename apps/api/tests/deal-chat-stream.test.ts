import { describe, it, expect, vi, beforeEach } from 'vitest';

const toolRunnerCalls: any[] = [];
let nextRunnerIterations: any[] = []; // array of arrays of stream events

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        toolRunner: (req: any) => {
          toolRunnerCalls.push(req);
          return (async function* () {
            for (const events of nextRunnerIterations) {
              yield (async function* () {
                for (const e of events) yield e;
              })();
            }
          })();
        },
      },
    };
  }
  return { default: MockAnthropic };
});

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

async function getClient() {
  return await import('../src/services/ai/client.js');
}

beforeEach(() => {
  toolRunnerCalls.length = 0;
  recorded.length = 0;
  nextRunnerIterations = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('trackedClaudeStream', () => {
  it('calls toolRunner with role-resolved model, stream:true, and passed tools/system/messages', async () => {
    nextRunnerIterations = [[{ type: 'message_stop' }]];
    const { trackedClaudeStream } = await getClient();
    const { runner } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'noop' }],
    });
    for await (const stream of runner) {
      for await (const _event of stream) {
        // drain
      }
    }
    expect(toolRunnerCalls[0]).toMatchObject({
      model: 'claude-sonnet-5',
      stream: true,
      system: 'sys',
      tools: [{ name: 'noop' }],
    });
  });

  it('recordUsage() writes a UsageEvent with the resolved model and given token counts', async () => {
    nextRunnerIterations = [[{ type: 'message_stop' }]];
    const { trackedClaudeStream } = await getClient();
    const { recordUsage } = trackedClaudeStream({
      operation: 'deal_chat',
      role: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    await recordUsage({ inputTokens: 300, outputTokens: 50 }, 'success');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'deal_chat',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      promptTokens: 300,
      completionTokens: 50,
      status: 'success',
    });
  });
});
