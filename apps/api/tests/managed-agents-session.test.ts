import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentEvents: any[] = [];
let historyEvents: any[] = [];
let liveEvents: any[] = [];

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      sessions: {
        create: vi.fn(async () => ({ id: 'sesn_test1', status: 'idle' })),
        events: {
          send: vi.fn(async (_id: string, body: any) => {
            sentEvents.push(...body.events);
          }),
          list: vi.fn(async function* () {
            for (const e of historyEvents) yield e;
          }),
          stream: vi.fn(async function* () {
            for (const e of liveEvents) yield e;
          }),
        },
      },
    };
  }
  return { default: MockAnthropic };
});

async function getSession() {
  return await import('../src/services/managedAgents/session.js');
}

beforeEach(() => {
  sentEvents.length = 0;
  historyEvents = [];
  liveEvents = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('createSessionAndDrain', () => {
  it('sends the kickoff message and returns completed on a terminal idle event', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'session.status_running' },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'Research this firm',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({ type: 'user.message' });
  });

  it('dispatches agent.custom_tool_use to the matching handler and submits the result', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'agent.custom_tool_use', name: 'save_firm_profile', input: { firm: { description: 'x' } } },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const handler = vi.fn(async () => ({ saved: true }));
    const { createSessionAndDrain } = await getSession();

    await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'Research this firm',
      toolHandlers: { save_firm_profile: handler },
    });

    expect(handler).toHaveBeenCalledWith('org_1', { firm: { description: 'x' } });
    const resultEvent = sentEvents.find((e) => e.type === 'user.custom_tool_result');
    expect(resultEvent).toMatchObject({ custom_tool_use_id: 'sevt_1' });
  });

  it('continues past requires_action idle and only stops on a terminal idle', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'agent.custom_tool_use', name: 'noop_tool', input: {} },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_1'] } },
      { id: 'sevt_3', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
  });

  it('accumulates token usage from span.model_request_end events', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'span.model_request_end', model_usage: { input_tokens: 100, output_tokens: 20 } },
      { id: 'sevt_2', type: 'span.model_request_end', model_usage: { input_tokens: 50, output_tokens: 10 } },
      { id: 'sevt_3', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it('returns failed when the stream ends with no terminal event', async () => {
    liveEvents = [{ id: 'sevt_1', type: 'session.status_running' }];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('failed');
  });
});
