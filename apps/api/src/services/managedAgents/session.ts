import { getAnthropicClient } from '../ai/client.js';
import { log } from '../../utils/logger.js';

export type ToolHandler = (organizationId: string, input: any) => Promise<unknown>;

export interface DrainSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

export interface DrainSessionResult {
  status: 'completed' | 'failed';
  error?: string;
  usage: DrainSessionUsage;
  /**
   * Authoritative session cost in USD, from the session's `usage.list_cost`
   * (already includes tokens + web search + runtime — see the Managed Agents
   * API reference). `amount` is an integer string in CENTS. Present whenever
   * the final session record could be retrieved, even on a failed/errored
   * drain — Anthropic still bills whatever the session actually did.
   */
  costOverrideUsd?: number;
  /** Model that actually served the session, from `session.agent.model.id`. */
  model?: string;
  webSearchRequests?: number;
  activeSeconds?: number;
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

  // Attach the session's authoritative final usage (list_cost, cache tokens,
  // web search count, active_seconds, served model) to whatever result we're
  // about to return. `list_cost.amount` is an integer string in CENTS.
  // Best-effort — a failed retrieve falls back to the token counts we
  // accumulated from stream events rather than losing the result entirely.
  const finalize = async (partial: DrainSessionResult): Promise<DrainSessionResult> => {
    try {
      const finalSession = await client.beta.sessions.retrieve(session.id);
      const su = finalSession.usage;
      const listCost = su?.list_cost;
      return {
        ...partial,
        usage: {
          inputTokens: su?.input_tokens ?? partial.usage.inputTokens,
          outputTokens: su?.output_tokens ?? partial.usage.outputTokens,
          cacheReadTokens: su?.cache_read_input_tokens,
          cacheWrite5mTokens: su?.cache_creation?.ephemeral_5m_input_tokens,
          cacheWrite1hTokens: su?.cache_creation?.ephemeral_1h_input_tokens,
        },
        costOverrideUsd: listCost ? Number(listCost.amount) / 100 : partial.costOverrideUsd,
        model: finalSession.agent?.model?.id ?? partial.model,
        webSearchRequests: su?.server_tool_use?.web_search_requests,
        activeSeconds: su?.active_seconds,
      };
    } catch (err) {
      log.warn('createSessionAndDrain: failed to retrieve final session usage — recording accumulated stream usage only', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return partial;
    }
  };

  // Never throw past this point — a thrown error here would skip usage
  // recording for a session Anthropic has already billed. Any failure while
  // draining events is captured as a 'failed' result instead, and finalize()
  // still attempts to pull the authoritative final cost for it.
  try {
    for await (const event of client.beta.sessions.events.list(session.id)) {
      const result = await handleEvent(event);
      if (result) return await finalize(result);
    }
    for await (const event of stream) {
      const result = await handleEvent(event);
      if (result) return await finalize(result);
    }

    return await finalize({ status: 'failed', error: 'Stream ended without a terminal event', usage });
  } catch (err) {
    log.error('createSessionAndDrain: event loop threw — recording usage for the partial session', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return await finalize({
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      usage,
    });
  }
}
