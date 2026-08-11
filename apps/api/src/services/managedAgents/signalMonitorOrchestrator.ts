import { createSessionAndDrain } from './session.js';
import { recordManagedAgentSessionUsage } from '../usage/trackedManagedAgentSession.js';
import { listDealsForOrg } from './tools/listDealsForOrg.js';
import { createSignalNotification } from './tools/createSignalNotification.js';
import { SIGNAL_MONITOR_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID, assertManagedAgentsConfigured } from './config.js';

export interface SignalMonitorRunResult {
  status: 'completed' | 'failed';
  error?: string;
}

export async function runSignalMonitorViaManagedAgents(organizationId: string): Promise<SignalMonitorRunResult> {
  assertManagedAgentsConfigured();
  const start = Date.now();
  const result = await createSessionAndDrain({
    agentId: SIGNAL_MONITOR_AGENT_ID,
    environmentId: MANAGED_AGENTS_ENVIRONMENT_ID,
    organizationId,
    initialMessage: "Scan this organization's active deals for signals.",
    toolHandlers: {
      list_deals_for_org: listDealsForOrg,
      create_signal_notification: createSignalNotification,
    },
  });

  await recordManagedAgentSessionUsage({
    operation: 'signal_monitor_managed_agent',
    status: result.status === 'completed' ? 'success' : 'error',
    usage: result.usage,
    durationMs: Date.now() - start,
  });

  return result.status === 'completed' ? { status: 'completed' } : { status: 'failed', error: result.error };
}
