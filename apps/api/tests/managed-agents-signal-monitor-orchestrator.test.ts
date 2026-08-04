import { describe, it, expect, vi, beforeEach } from 'vitest';

const createSessionAndDrain = vi.fn();
vi.mock('../src/services/managedAgents/session.js', () => ({ createSessionAndDrain }));

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

vi.mock('../src/services/managedAgents/config.js', () => ({
  SIGNAL_MONITOR_AGENT_ID: 'agent_signal',
  MANAGED_AGENTS_ENVIRONMENT_ID: 'env_1',
  assertManagedAgentsConfigured: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
});

describe('runSignalMonitorViaManagedAgents', () => {
  it('creates a session for the org and returns completed on success', async () => {
    createSessionAndDrain.mockResolvedValue({ status: 'completed', usage: { inputTokens: 200, outputTokens: 40 } });
    const { runSignalMonitorViaManagedAgents } = await import('../src/services/managedAgents/signalMonitorOrchestrator.js');

    const result = await runSignalMonitorViaManagedAgents('org-1');

    expect(createSessionAndDrain).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_signal', environmentId: 'env_1', organizationId: 'org-1' }),
    );
    expect(result).toEqual({ status: 'completed' });
    expect(recorded[0]).toMatchObject({ operation: 'signal_monitor_managed_agent', promptTokens: 200, completionTokens: 40 });
  });

  it('returns failed when the session fails', async () => {
    createSessionAndDrain.mockResolvedValue({ status: 'failed', error: 'boom', usage: { inputTokens: 0, outputTokens: 0 } });
    const { runSignalMonitorViaManagedAgents } = await import('../src/services/managedAgents/signalMonitorOrchestrator.js');

    const result = await runSignalMonitorViaManagedAgents('org-1');
    expect(result).toEqual({ status: 'failed', error: 'boom' });
  });
});
