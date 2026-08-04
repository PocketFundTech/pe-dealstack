import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('listDealsForOrg', () => {
  it('queries active deals scoped to the organization, excluding passed/closed-lost', async () => {
    let capturedFilters: any[] = [];
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Deal') throw new Error(`Unexpected table: ${table}`);
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          capturedFilters.push(['eq', col, val]);
          return builder;
        },
        neq: (col: string, val: any) => {
          capturedFilters.push(['neq', col, val]);
          return builder;
        },
        order: () => builder,
        limit: async () => ({
          data: [{ id: 'deal-1', name: 'Acme', industry: 'SaaS', stage: 'DILIGENCE', revenue: 5, Company: { name: 'Acme Co' } }],
          error: null,
        }),
      };
      return builder;
    });

    const { listDealsForOrg } = await import('../src/services/managedAgents/tools/listDealsForOrg.js');
    const result = await listDealsForOrg('org-1', {});

    expect(capturedFilters).toContainEqual(['eq', 'organizationId', 'org-1']);
    expect(capturedFilters).toContainEqual(['neq', 'status', 'PASSED']);
    expect(capturedFilters).toContainEqual(['neq', 'stage', 'CLOSED_LOST']);
    expect(result).toEqual({
      deals: [{ id: 'deal-1', name: 'Acme', industry: 'SaaS', stage: 'DILIGENCE', revenue: 5, company: 'Acme Co' }],
    });
  });
});

describe('createSignalNotification', () => {
  it('inserts an Activity row for the flagged deal', async () => {
    let inserted: any = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Activity') throw new Error(`Unexpected table: ${table}`);
      return {
        insert: async (payload: any) => {
          inserted = payload;
          return { error: null };
        },
      };
    });

    const { createSignalNotification } = await import('../src/services/managedAgents/tools/createSignalNotification.js');
    const result = await createSignalNotification('org-1', {
      dealId: 'deal-1',
      signalType: 'leadership_change',
      severity: 'critical',
      title: 'CEO departure',
      description: 'The CEO resigned last week.',
      suggestedAction: 'Reach out to the board.',
    });

    expect(result).toEqual({ created: true });
    expect(inserted).toMatchObject({
      dealId: 'deal-1',
      type: 'AI_SIGNAL',
      title: '[CRITICAL] CEO departure',
      description: 'The CEO resigned last week.. Suggested action: Reach out to the board.',
    });
  });

  it('returns created: false when dealId is missing', async () => {
    const { createSignalNotification } = await import('../src/services/managedAgents/tools/createSignalNotification.js');
    const result = await createSignalNotification('org-1', {
      dealId: '',
      signalType: 'leadership_change',
      severity: 'critical',
      title: 't',
      description: 'd',
      suggestedAction: 'a',
    });
    expect(result).toEqual({ created: false });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
