import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentEvents: any[] = [];
let historyEvents: any[] = [];
let liveEvents: any[] = [];
/** What sessions.retrieve() returns — defaults to a session with no usage
 *  info, so tests that don't care about the final-usage retrieve still work.
 *  Set per-test to exercise the authoritative list_cost / cache / model
 *  fields (session.ts finalize()). */
let retrievedSession: any = { id: 'sesn_test1', usage: {}, agent: { model: { id: 'claude-sonnet-5' } } };
let retrieveError: Error | null = null;
/** Thrown from the live-events generator after `liveEvents` is exhausted —
 *  used to test that an event-loop error never escapes createSessionAndDrain. */
let streamThrowError: Error | null = null;

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      sessions: {
        create: vi.fn(async () => ({ id: 'sesn_test1', status: 'idle' })),
        retrieve: vi.fn(async () => {
          if (retrieveError) throw retrieveError;
          return retrievedSession;
        }),
        events: {
          send: vi.fn(async (_id: string, body: any) => {
            sentEvents.push(...body.events);
          }),
          list: vi.fn(async function* () {
            for (const e of historyEvents) yield e;
          }),
          stream: vi.fn(async function* () {
            for (const e of liveEvents) yield e;
            if (streamThrowError) throw streamThrowError;
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
  retrievedSession = { id: 'sesn_test1', usage: {}, agent: { model: { id: 'claude-sonnet-5' } } };
  retrieveError = null;
  streamThrowError = null;
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

  // Cost-accuracy (usage-cost-accuracy): the session's usage.list_cost is
  // the authoritative charge (tokens + web search $10/1k + runtime $0.08/h)
  // and must be recorded as-is via costOverrideUsd rather than re-derived
  // from token counts. list_cost.amount is an integer string in CENTS.
  it('attaches the authoritative list_cost (cents → USD), cache tokens, web search count and served model on completion', async () => {
    liveEvents = [{ id: 'sevt_1', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
    retrievedSession = {
      id: 'sesn_test1',
      agent: { model: { id: 'claude-opus-5' } },
      usage: {
        input_tokens: 5000,
        output_tokens: 800,
        cache_read_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 },
        list_cost: { amount: '742', currency: 'USD' }, // $7.42
        server_tool_use: { web_search_requests: 6 },
        active_seconds: 90,
      },
    };
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
    expect(result.costOverrideUsd).toBeCloseTo(7.42, 6);
    expect(result.model).toBe('claude-opus-5');
    expect(result.usage).toEqual({
      inputTokens: 5000,
      outputTokens: 800,
      cacheReadTokens: 3000,
      cacheWrite5mTokens: 400,
      cacheWrite1hTokens: 0,
    });
    expect(result.webSearchRequests).toBe(6);
    expect(result.activeSeconds).toBe(90);
  });

  // Prod incident risk: the original implementation let an event-loop error
  // propagate out of createSessionAndDrain, skipping usage recording for a
  // session Anthropic had already billed. It must never throw once the
  // session exists — it should return a 'failed' result with whatever usage
  // is known (finalize() still tries the authoritative retrieve).
  it('never throws when the event stream errors — returns failed with usage attached', async () => {
    liveEvents = [{ id: 'sevt_1', type: 'span.model_request_end', model_usage: { input_tokens: 10, output_tokens: 2 } }];
    streamThrowError = new Error('connection reset');
    retrievedSession = {
      id: 'sesn_test1',
      agent: { model: { id: 'claude-sonnet-5' } },
      usage: { input_tokens: 10, output_tokens: 2, list_cost: { amount: '5', currency: 'USD' } },
    };
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('connection reset');
  });

  it('falls back to accumulated stream usage when the final retrieve itself fails', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'span.model_request_end', model_usage: { input_tokens: 40, output_tokens: 8 } },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    retrieveError = new Error('sessions.retrieve unavailable');
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 8 });
    expect(result.costOverrideUsd).toBeUndefined();
  });
});
