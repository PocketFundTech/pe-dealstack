import { recordUsageEvent } from './trackedLLM.js';

const MANAGED_AGENT_MODEL = process.env.AI_AGENT_MODEL || 'claude-sonnet-5';

export async function recordManagedAgentSessionUsage(params: {
  operation: string;
  status: 'success' | 'error';
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}): Promise<void> {
  await recordUsageEvent({
    operation: params.operation,
    provider: 'anthropic',
    model: MANAGED_AGENT_MODEL,
    promptTokens: params.usage.inputTokens,
    completionTokens: params.usage.outputTokens,
    status: params.status,
    durationMs: params.durationMs,
  });
}
