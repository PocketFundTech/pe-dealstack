/**
 * C2: Verify that runImportBatch honours a concurrent cancel.
 *
 * When the guarded update (.neq('status', 'cancelled')) finds no matching row
 * (returns { data: null }), the function must return false (stop the loop)
 * rather than continuing or flipping the status to 'completed'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Use vi.hoisted so mockFrom is available inside vi.mock factories (which are
// hoisted to the top of the file by vitest, before variable declarations).
// ---------------------------------------------------------------------------
const { mockFrom, listPage: mockListPage } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------
vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// HubSpotClient mock — listPage returns one company + nextCursor.
// ---------------------------------------------------------------------------
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage: mockListPage, listPropertyNames: vi.fn().mockResolvedValue(['name']) };
  }),
}));

// ---------------------------------------------------------------------------
// Dedup mock — always 'created', bypasses real DB.
// ---------------------------------------------------------------------------
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
}));

// ---------------------------------------------------------------------------
// Mappers mock — minimal valid shapes.
// ---------------------------------------------------------------------------
vi.mock('../src/services/hubspot/mappers.js', () => ({
  mapCompany: vi.fn().mockReturnValue({
    hubspotId: 'hs-1', name: 'Acme', industry: null,
    website: null, description: null, hubspotProperties: {},
  }),
  mapContact: vi.fn(),
  mapDeal: vi.fn(),
}));

import { runImportBatch } from '../src/services/hubspot/importEngine.js';

// ---------------------------------------------------------------------------
// Helper: chainable Supabase query builder.
// ---------------------------------------------------------------------------
function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

describe('C2 — runImportBatch honours concurrent cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when the guarded advance-cursor update matches no row (job was cancelled mid-batch)', async () => {
    /**
     * Query sequence inside runImportBatch:
     *   1. loadJob  → from('ImportJob').select('*').eq('id', ...).maybeSingle()
     *                 → running job (not cancelled at start)
     *   2. client.listPage → one result + nextCursor → advance-cursor branch
     *   3. Record loop → upsertByHubspotId is mocked, no real DB calls
     *   4. Advance-cursor guarded update:
     *        from('ImportJob').update({...}).eq(...).neq('status','cancelled').select('id').maybeSingle()
     *        → { data: null }  ← simulates cancelled (neq matched zero rows)
     *   Expected: runImportBatch returns false.
     */

    const loadJobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-99',
          organizationId: 'org-A',
          status: 'running',
          objectCounts: {},
          currentObject: 'companies',
          cursor: null,
        },
      }),
    });

    const guardedUpdateChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: null }), // cancelled — no row matched
    });

    let callIndex = 0;
    mockFrom.mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) return loadJobChain;    // loadJob
      return guardedUpdateChain;                    // guarded advance-cursor update
    });

    mockListPage.mockResolvedValue({
      results: [{ id: 'hs-1', properties: { name: 'Acme' } }],
      nextCursor: 'cursor-2',
    });

    const result = await runImportBatch('job-99', 'fake-token');

    expect(result).toBe(false);
    // The guarded update must have used .neq('status', 'cancelled')
    expect(guardedUpdateChain.neq).toHaveBeenCalledWith('status', 'cancelled');
    // We should have called from() exactly twice (loadJob + guarded update)
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('returns false immediately when job status is already cancelled at load time', async () => {
    const loadJobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'job-100',
          organizationId: 'org-A',
          status: 'cancelled',
          objectCounts: {},
          currentObject: null,
          cursor: null,
        },
      }),
    });

    mockFrom.mockReturnValue(loadJobChain);
    mockListPage.mockResolvedValue({ results: [], nextCursor: null });

    const result = await runImportBatch('job-100', 'fake-token');
    expect(result).toBe(false);
    // listPage must NOT have been called — bail out before fetching
    expect(mockListPage).not.toHaveBeenCalled();
  });
});
