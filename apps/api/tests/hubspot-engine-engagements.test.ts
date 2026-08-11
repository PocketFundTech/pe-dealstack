import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, listDealStageLabels, upsertContactInteractionByHubspotId } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  listDealStageLabels: vi.fn().mockResolvedValue({}),
  upsertContactInteractionByHubspotId: vi.fn().mockResolvedValue('created'),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return { listPage, listPropertyNames: vi.fn().mockResolvedValue(['hs_note_body']), listDealStageLabels };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: vi.fn().mockResolvedValue('created'),
  upsertContactInteractionByHubspotId,
}));
vi.mock('../src/services/hubspot/mappers.js', () => ({ mapCompany: vi.fn(), mapContact: vi.fn(), mapDeal: vi.fn() }));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

function runningNotesJob(jobId: string) {
  return makeChain({
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: jobId, organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'notes', cursor: null },
    }),
  });
}

describe('runImportBatch — engagement import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageLabelCache();
  });

  it('resolves the associated HubSpot contact to a local contactId and upserts one ContactInteraction', async () => {
    const jobChain = runningNotesJob('job-1');
    const contactLookupChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'local-contact-1' } }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain; // 'Contact'
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-note-1',
        properties: { hs_note_body: 'Called about term sheet', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-1' }] } },
      }],
      nextCursor: null,
    });

    await runImportBatch('job-1', 'tok');

    expect(contactLookupChain.eq).toHaveBeenCalledWith('hubspotId', 'hs-contact-1');
    expect(upsertContactInteractionByHubspotId).toHaveBeenCalledWith(
      'local-contact-1', 'hs-note-1',
      expect.objectContaining({ type: 'NOTE', description: 'Called about term sheet' }),
      'fill',
    );
  });

  it('creates one ContactInteraction per associated contact for a multi-contact engagement', async () => {
    const jobChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'job-2', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject: 'meetings', cursor: null },
      }),
    });
    const contactLookupChain = makeChain({
      maybeSingle: vi.fn()
        .mockResolvedValueOnce({ data: { id: 'local-contact-1' } })
        .mockResolvedValueOnce({ data: { id: 'local-contact-2' } }),
    });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-2' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain;
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-meeting-1',
        properties: { hs_meeting_title: 'Kickoff', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-1' }, { id: 'hs-contact-2' }] } },
      }],
      nextCursor: null,
    });

    await runImportBatch('job-2', 'tok');

    expect(upsertContactInteractionByHubspotId).toHaveBeenCalledTimes(2);
    expect(upsertContactInteractionByHubspotId).toHaveBeenNthCalledWith(1, 'local-contact-1', 'hs-meeting-1', expect.anything(), 'fill');
    expect(upsertContactInteractionByHubspotId).toHaveBeenNthCalledWith(2, 'local-contact-2', 'hs-meeting-1', expect.anything(), 'fill');
  });

  it('skips an engagement with no resolvable local contact, without throwing', async () => {
    const jobChain = runningNotesJob('job-3');
    const noContactMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-3' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return noContactMatch;
    });

    listPage.mockResolvedValue({
      results: [{
        id: 'hs-note-1', properties: { hs_note_body: 'x', hs_timestamp: '1721000000000' },
        associations: { contacts: { results: [{ id: 'hs-contact-unmatched' }] } },
      }],
      nextCursor: null,
    });

    const result = await runImportBatch('job-3', 'tok');

    // 'notes' isn't the last entry in ORDER (calls/meetings/emails/tasks
    // follow), so a drained page with no more results advances the job to
    // the next object type rather than completing it. The behavior under
    // test is that the skip doesn't throw and is counted correctly below.
    expect(result).toBe(true);
    expect(upsertContactInteractionByHubspotId).not.toHaveBeenCalled();
    // Verify the job update reflects processed=1, created=0 (skipped, not failed)
    const finalUpdateCall = (finalUpdateChain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as { objectCounts: Record<string, { processed: number; created: number; failed: number }> };
    expect(finalUpdateCall.objectCounts.notes).toMatchObject({ processed: 1, created: 0, failed: 0 });
  });

  it('resolves the same HubSpot contact id only once across multiple engagements in a batch', async () => {
    const jobChain = runningNotesJob('job-4');
    const contactLookupChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'local-contact-1' } }) });
    const finalUpdateChain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-4' } }) });

    let importJobCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ImportJob') { importJobCalls += 1; return importJobCalls === 1 ? jobChain : finalUpdateChain; }
      return contactLookupChain;
    });

    listPage.mockResolvedValue({
      results: [
        { id: 'hs-note-1', properties: { hs_note_body: 'a', hs_timestamp: '1721000000000' }, associations: { contacts: { results: [{ id: 'hs-contact-1' }] } } },
        { id: 'hs-note-2', properties: { hs_note_body: 'b', hs_timestamp: '1721000000000' }, associations: { contacts: { results: [{ id: 'hs-contact-1' }] } } },
      ],
      nextCursor: null,
    });

    await runImportBatch('job-4', 'tok');

    const contactCalls = mockFrom.mock.calls.filter((c) => c[0] === 'Contact').length;
    expect(contactCalls).toBe(1);
  });
});
