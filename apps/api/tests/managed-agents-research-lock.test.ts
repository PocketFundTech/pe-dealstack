import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

async function getLock() {
  return await import('../src/services/managedAgents/researchLock.js');
}

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('acquireResearchLock', () => {
  it('acquires the lock when researchLockedAt is null', async () => {
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({
            select: async () => ({ data: [{ id: 'org-1' }], error: null }),
          }),
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(acquired).toBe(true);
  });

  it('falls back to the stale-lock branch when the null branch matches nothing', async () => {
    let staleAttempted = false;
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({
            select: async () => ({ data: [], error: null }),
          }),
          lt: () => {
            staleAttempted = true;
            return { select: async () => ({ data: [{ id: 'org-1' }], error: null }) };
          },
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(staleAttempted).toBe(true);
    expect(acquired).toBe(true);
  });

  it('returns false when neither branch matches (a fresh lock is already held)', async () => {
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({ select: async () => ({ data: [], error: null }) }),
          lt: () => ({ select: async () => ({ data: [], error: null }) }),
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(acquired).toBe(false);
  });
});

describe('releaseResearchLock', () => {
  it('clears researchLockedAt', async () => {
    let updated: any = null;
    mockSupabase.from.mockImplementation(() => ({
      update: (payload: any) => {
        updated = payload;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { releaseResearchLock } = await getLock();
    await releaseResearchLock('org-1');
    expect(updated).toEqual({ researchLockedAt: null });
  });
});
