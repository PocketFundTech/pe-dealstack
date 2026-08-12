import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks BEFORE importing the module under test.
const { mockSupabase, mockListPage, mockUpsertInteraction, capturedUpdates } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
  mockListPage: vi.fn(),
  mockUpsertInteraction: vi.fn(),
  capturedUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function HubSpotClientMock() {
    return {
      listPropertyNames: vi.fn().mockResolvedValue([]),
      listPage: mockListPage,
      listDealStageLabels: vi.fn().mockResolvedValue({}),
    };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn(),
  upsertContactInteractionByHubspotId: mockUpsertInteraction,
}));

const JOB_ROW = {
  id: 'job-1',
  organizationId: 'org-1',
  status: 'running',
  objectCounts: {},
  currentObject: 'notes',
  cursor: null,
};

describe('runImportBatch — engagement contact-resolution accounting', () => {
  beforeEach(() => {
    capturedUpdates.length = 0;
    mockSupabase.from.mockReset();
    mockListPage.mockReset();
    mockUpsertInteraction.mockReset();

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'ImportJob') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: JOB_ROW, error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            capturedUpdates.push(patch);
            return {
              eq: () => ({
                neq: () => ({
                  select: () => ({ maybeSingle: async () => ({ data: { id: 'job-1' }, error: null }) }),
                }),
              }),
            };
          },
        };
      }
      if (table === 'Contact') {
        return {
          select: () => ({
            eq: () => ({
              eq: (_col: string, hubspotContactId: string) => ({
                maybeSingle: async () => ({
                  data: hubspotContactId === 'hs-contact-1' ? { id: 'local-contact-1' } : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    // One note has a resolvable contact association, one doesn't.
    mockListPage.mockResolvedValue({
      results: [
        {
          id: 'note-1',
          properties: { hs_note_body: 'has a matching contact', hs_timestamp: '1700000000000' },
          associations: { contacts: { results: [{ id: 'hs-contact-1' }] } },
        },
        {
          id: 'note-2',
          properties: { hs_note_body: 'no association resolves', hs_timestamp: '1700000000000' },
          associations: { contacts: { results: [{ id: 'hs-contact-unknown' }] } },
        },
      ],
      nextCursor: null,
    });
    mockUpsertInteraction.mockResolvedValue('created');
  });

  it('counts a resolved contact as created and an unresolved one as skipped, not silently dropped', async () => {
    const { runImportBatch } = await import('../src/services/hubspot/importEngine.js');

    const more = await runImportBatch('job-1', 'fake-token');

    expect(more).toBe(true);
    // Exactly one interaction row is written — for the note whose contact resolved.
    expect(mockUpsertInteraction).toHaveBeenCalledTimes(1);
    expect(mockUpsertInteraction).toHaveBeenCalledWith(
      'local-contact-1',
      'note-1',
      expect.objectContaining({ type: 'NOTE' }),
      'fill',
    );

    const savedCounts = capturedUpdates.at(-1)?.objectCounts as any;
    expect(savedCounts.notes).toEqual({ processed: 2, created: 1, updated: 0, failed: 0, skipped: 1 });
  });
});
