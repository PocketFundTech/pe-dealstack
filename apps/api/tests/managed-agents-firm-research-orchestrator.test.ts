import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const createSessionAndDrain = vi.fn();
vi.mock('../src/services/managedAgents/session.js', () => ({ createSessionAndDrain }));

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

const acquireResearchLock = vi.fn();
const releaseResearchLock = vi.fn();
vi.mock('../src/services/managedAgents/researchLock.js', () => ({ acquireResearchLock, releaseResearchLock }));

vi.mock('../src/services/managedAgents/config.js', () => ({
  FIRM_RESEARCH_AGENT_ID: 'agent_firm',
  MANAGED_AGENTS_ENVIRONMENT_ID: 'env_1',
  assertManagedAgentsConfigured: vi.fn(),
}));

async function getOrchestrator() {
  return await import('../src/services/managedAgents/firmResearchOrchestrator.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
  mockSupabase.from.mockImplementation(() => ({
    update: () => ({ eq: async () => ({ error: null }) }),
  }));
});

describe('runFirmResearchViaManagedAgents', () => {
  it('skips the run and releases nothing when the lock cannot be acquired', async () => {
    acquireResearchLock.mockResolvedValue(false);
    const { runFirmResearchViaManagedAgents } = await getOrchestrator();

    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(createSessionAndDrain).not.toHaveBeenCalled();
    expect(releaseResearchLock).not.toHaveBeenCalled();
  });

  it('runs the session, records usage, and releases the lock on success', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockResolvedValue({ status: 'completed', usage: { inputTokens: 500, outputTokens: 100 } });

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(createSessionAndDrain).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_firm', environmentId: 'env_1', organizationId: 'org-1' }),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ operation: 'firm_research_managed_agent', provider: 'anthropic', promptTokens: 500, completionTokens: 100 });
    expect(releaseResearchLock).toHaveBeenCalledWith('org-1');
  });

  // Cost-accuracy (usage-cost-accuracy): the session's authoritative
  // list_cost / served model / cache tokens / web-search count must flow
  // through to the ledger row instead of being re-derived or dropped.
  it('forwards the session result costOverrideUsd, model, cache tokens and web-search metadata', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockResolvedValue({
      status: 'completed',
      usage: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 3000, cacheWrite5mTokens: 400 },
      costOverrideUsd: 7.42,
      model: 'claude-opus-5',
      webSearchRequests: 6,
      activeSeconds: 90,
    });

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      operation: 'firm_research_managed_agent',
      model: 'claude-opus-5',
      costOverrideUsd: 7.42,
      cacheReadTokens: 3000,
      cacheWrite5mTokens: 400,
    });
    expect(recorded[0].metadata).toMatchObject({ webSearchRequests: 6, activeSeconds: 90 });
  });

  // createSessionAndDrain no longer throws once a session exists (session.ts
  // catches its own event-loop errors) — this catch is reached only when the
  // session was never created, so there's no billable usage to lose.
  it('reaches the catch (no usage recorded) only when createSessionAndDrain itself throws before a session exists', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockRejectedValue(new Error('sessions.create unreachable'));
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: {} }, error: null }) }) }),
      update: (payload: any) => {
        updatedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(recorded).toHaveLength(0);
    expect(updatedSettings).toMatchObject({ researchStatus: 'failed', researchError: 'sessions.create unreachable' });
    expect(releaseResearchLock).toHaveBeenCalledWith('org-1');
  });

  it('marks researchStatus failed and releases the lock when the session fails', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockResolvedValue({ status: 'failed', error: 'boom', usage: { inputTokens: 0, outputTokens: 0 } });
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: {} }, error: null }) }) }),
      update: (payload: any) => {
        updatedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(updatedSettings).toMatchObject({ researchStatus: 'failed' });
    expect(releaseResearchLock).toHaveBeenCalledWith('org-1');
  });
});
