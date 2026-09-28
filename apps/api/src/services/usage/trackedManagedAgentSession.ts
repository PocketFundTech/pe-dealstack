import { recordUsageEvent } from './trackedLLM.js';

const MANAGED_AGENT_MODEL = process.env.AI_AGENT_MODEL || 'claude-sonnet-5';

export async function recordManagedAgentSessionUsage(params: {
  operation: string;
  status: 'success' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWrite5mTokens?: number;
    cacheWrite1hTokens?: number;
  };
  durationMs: number;
  /**
   * Authoritative session cost in USD (Managed Agents `usage.list_cost`,
   * already includes tokens + web search + runtime). Used as-is instead of
   * the token × price computation — see trackedLLM.ts costOverrideUsd.
   */
  costOverrideUsd?: number;
  /** Model that actually served the session, when known — falls back to the
   *  configured/hard-coded AI_AGENT_MODEL otherwise. */
  model?: string;
  webSearchRequests?: number;
  activeSeconds?: number;
}): Promise<void> {
  const extraMetadata: Record<string, unknown> = {};
  if (params.webSearchRequests !== undefined) extraMetadata.webSearchRequests = params.webSearchRequests;
  if (params.activeSeconds !== undefined) extraMetadata.activeSeconds = params.activeSeconds;

  await recordUsageEvent({
    operation: params.operation,
    provider: 'anthropic',
    model: params.model || MANAGED_AGENT_MODEL,
    promptTokens: params.usage.inputTokens,
    completionTokens: params.usage.outputTokens,
    cacheReadTokens: params.usage.cacheReadTokens,
    cacheWrite5mTokens: params.usage.cacheWrite5mTokens,
    cacheWrite1hTokens: params.usage.cacheWrite1hTokens,
    costOverrideUsd: params.costOverrideUsd,
    status: params.status,
    durationMs: params.durationMs,
    ...(Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : {}),
  });
}
