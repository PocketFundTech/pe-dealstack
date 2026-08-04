import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function getTool() {
  return await import('../src/services/managedAgents/tools/saveFirmProfile.js');
}

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('saveFirmProfile', () => {
  it('merges new firm fields into an empty settings.firmProfile', async () => {
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Organization') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { settings: {} }, error: null }) }),
          }),
          update: (payload: any) => {
            updatedSettings = payload.settings;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const { saveFirmProfile } = await getTool();
    const result = await saveFirmProfile('org-1', { firm: { description: 'A PE firm', sectors: ['SaaS'] } });

    expect(result).toEqual({ saved: true });
    expect(updatedSettings.firmProfile.description).toBe('A PE firm');
    expect(updatedSettings.firmProfile.sectors).toEqual(['SaaS']);
    expect(updatedSettings.researchStatus).toBe('running');
  });

  it('dedupes portfolio companies by lowercased name across calls', async () => {
    let storedSettings: any = { firmProfile: { portfolioCompanies: [{ name: 'Acme Co' }] } };
    mockSupabase.from.mockImplementation((table: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: storedSettings }, error: null }) }) }),
      update: (payload: any) => {
        storedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { saveFirmProfile } = await getTool();
    await saveFirmProfile('org-1', {
      firm: { portfolioCompanies: [{ name: 'acme co', sector: 'Fintech' }, { name: 'Beta Inc' }] },
    });

    expect(storedSettings.firmProfile.portfolioCompanies).toHaveLength(2);
    const names = storedSettings.firmProfile.portfolioCompanies.map((c: any) => c.name.toLowerCase());
    expect(names).toContain('acme co');
    expect(names).toContain('beta inc');
  });

  it('returns saved: false without calling Supabase when organizationId is empty', async () => {
    const { saveFirmProfile } = await getTool();
    const result = await saveFirmProfile('', { firm: { description: 'x' } });
    expect(result).toEqual({ saved: false });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
