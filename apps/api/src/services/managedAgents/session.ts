import { getAnthropicClient } from '../ai/client.js';
import { log } from '../../utils/logger.js';

export type ToolHandler = (organizationId: string, input: any) => Promise<unknown>;

export interface DrainSessionResult {
  status: 'completed' | 'failed';
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CreateSessionAndDrainParams {
  agentId: string;
  environmentId: string;
  organizationId: string;
  initialMessage: string;
  toolHandlers: Record<string, ToolHandler>;
}

export async function createSessionAndDrain(params: CreateSessionAndDrainParams): Promise<DrainSessionResult> {
  const client = getAnthropicClient();
  const session = await client.beta.sessions.create({
    agent: params.agentId,
    environment_id: params.environmentId,
    // The webhook handler looks up organizationId from session metadata to
    // know which org's research to mark failed — it has no other way to
    // map a session ID back to an org.
    metadata: { organizationId: params.organizationId },
  });

  const usage = { inputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();

  // Stream-first (shared/managed-agents-client-patterns.md Pattern 7), plus
  // history + dedupe (Pattern 1) — the session can't exist before create()
  // returns, so there is always a gap between session creation and the
  // stream opening; only reading history closes it.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: params.initialMessage }] }],
  });

  const handleEvent = async (event: any): Promise<DrainSessionResult | null> => {
    if (seen.has(event.id)) return null;
    seen.add(event.id);

    if (event.type === 'span.model_request_end' && event.model_usage) {
      usage.inputTokens += event.model_usage.input_tokens ?? 0;
      usage.outputTokens += event.model_usage.output_tokens ?? 0;
    }

    if (event.type === 'agent.custom_tool_use') {
      const handler = params.toolHandlers[event.name];
      let result: unknown;
      if (!handler) {
        result = { error: `Unknown tool: ${event.name}` };
      } else {
        try {
          result = await handler(params.organizationId, event.input);
        } catch (err) {
          log.error('managed-agents custom tool handler threw', {
            tool: event.name,
            organizationId: params.organizationId,
            error: err instanceof Error ? err.message : String(err),
          });
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: event.id,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        ],
      });
      return null;
    }

    if (event.type === 'session.status_terminated') {
      return { status: 'completed', usage };
    }
    if (event.type === 'session.status_idle') {
      if (event.stop_reason?.type === 'requires_action') return null;
      return { status: 'completed', usage };
    }
    return null;
  };

  for await (const event of client.beta.sessions.events.list(session.id)) {
    const result = await handleEvent(event);
    if (result) return result;
  }
  for await (const event of stream) {
    const result = await handleEvent(event);
    if (result) return result;
  }

  return { status: 'failed', error: 'Stream ended without a terminal event', usage };
}
