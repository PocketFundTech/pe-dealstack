import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));

import { mergeBlankOnly, mergeForImport, upsertByHubspotId, upsertContactInteractionByHubspotId } from '../src/services/hubspot/dedup.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    // update()/insert() end the chain on `.eq()`/`insert()` itself (no further
    // call), so mockReturnThis() makes `await chain...` resolve to `chain`
    // itself — destructuring `{ error }` off it reads this property.
    error: null,
  };
  return Object.assign(base, overrides);
}

describe('mergeBlankOnly', () => {
  it('fills only blank/null fields on the existing row', () => {
    const existing = { name: 'Acme', industry: null, website: '' };
    const incoming = { name: 'Acme Corp', industry: 'Mfg', website: 'acme.com' };
    expect(mergeBlankOnly(existing, incoming)).toEqual({
      name: 'Acme',          // non-empty existing preserved
      industry: 'Mfg',       // null filled
      website: 'acme.com',   // empty-string filled
    });
  });

  it('never introduces keys absent from incoming', () => {
    expect(mergeBlankOnly({ a: 'x' }, { a: '', b: 'y' })).toEqual({ a: 'x', b: 'y' });
  });

  it('ignores incoming null/empty so it cannot blank a populated field', () => {
    expect(mergeBlankOnly({ a: 'keep' }, { a: null })).toEqual({ a: 'keep' });
  });
});

describe('mergeForImport', () => {
  it('fill mode leaves a populated field untouched', () => {
    expect(mergeForImport({ name: 'Stale Name' }, { name: 'Correct Name' }, 'fill'))
      .toEqual({ name: 'Stale Name' });
  });

  it('refresh mode overwrites a populated field from HubSpot', () => {
    expect(mergeForImport({ name: 'Stale Name' }, { name: 'Correct Name' }, 'refresh'))
      .toEqual({ name: 'Correct Name' });
  });

  it('refresh mode still refuses to blank a populated field', () => {
    expect(mergeForImport({ name: 'Keep Me' }, { name: null }, 'refresh'))
      .toEqual({ name: 'Keep Me' });
  });

  it('refresh mode still fills blanks', () => {
    expect(mergeForImport({ name: '', industry: null }, { name: 'Acme', industry: 'Mfg' }, 'refresh'))
      .toEqual({ name: 'Acme', industry: 'Mfg' });
  });

  /**
   * customFields is written by multiple non-HubSpot sources too (AI follow-up
   * notes, CSV-import custom columns). Wholesale-replacing it on refresh would
   * silently delete that data — it must merge key-by-key instead.
   */
  it('refresh mode merges a nested plain-object field by key instead of replacing it wholesale', () => {
    const existing = { customFields: { aiFollowUp: { questions: ['Q1'] }, boardSeats: 2 } };
    const incoming = { customFields: { source: 'hubspot', dealstage: 'Due Diligence' } };
    expect(mergeForImport(existing, incoming, 'refresh')).toEqual({
      customFields: {
        aiFollowUp: { questions: ['Q1'] },
        boardSeats: 2,
        source: 'hubspot',
        dealstage: 'Due Diligence',
      },
    });
  });

  it('fill mode never touches a nested object field that already has keys', () => {
    const existing = { customFields: { aiFollowUp: { questions: ['Q1'] } } };
    const incoming = { customFields: { source: 'hubspot' } };
    expect(mergeForImport(existing, incoming, 'fill')).toEqual({
      customFields: { aiFollowUp: { questions: ['Q1'] } },
    });
  });
});

describe('upsertByHubspotId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies the caller\'s mode when the record was already linked by hubspotId', async () => {
    // hubspotId match succeeds on the first query — this record was created by
    // a prior HubSpot import, so the caller's mode should apply directly.
    const hubspotIdMatch = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'row-1', name: 'Stale Name' } }),
    });
    const updateChain = makeChain();
    mockFrom.mockReturnValueOnce(hubspotIdMatch).mockReturnValueOnce(updateChain);

    await upsertByHubspotId('Company', 'org-A', 'hs-1', { name: 'Correct Name', hubspotProperties: {} }, { column: 'name', value: 'Correct Name' }, 'refresh');

    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Correct Name' }));
  });

  it('forces fill mode when the record is adopted by natural key, even if the caller asked for refresh', async () => {
    // No hubspotId match; falls back to a natural-key (name) match — this
    // record was created manually by a user, not by a prior import, so it
    // must never be overwritten on first link regardless of the caller's mode.
    const noHubspotIdMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const naturalKeyMatch = makeChain({
      limit: vi.fn().mockResolvedValue({ data: [{ id: 'row-2', name: 'User Entered Name' }] }),
    });
    const updateChain = makeChain();
    mockFrom.mockReturnValueOnce(noHubspotIdMatch).mockReturnValueOnce(naturalKeyMatch).mockReturnValueOnce(updateChain);

    await upsertByHubspotId('Company', 'org-A', 'hs-1', { name: 'HubSpot Name', hubspotProperties: {} }, { column: 'name', value: 'User Entered Name' }, 'refresh');

    // Adopted by natural key ⇒ forced to 'fill' ⇒ the pre-existing name survives.
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'User Entered Name' }));
  });

  it('orders the natural-key fallback query so duplicate names resolve deterministically', async () => {
    const noHubspotIdMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const naturalKeyMatch = makeChain({ limit: vi.fn().mockResolvedValue({ data: [] }) });
    const insertChain = makeChain();
    mockFrom.mockReturnValueOnce(noHubspotIdMatch).mockReturnValueOnce(naturalKeyMatch).mockReturnValueOnce(insertChain);

    await upsertByHubspotId('Company', 'org-A', 'hs-1', { name: 'Acme', hubspotProperties: {} }, { column: 'name', value: 'Acme' });

    expect(naturalKeyMatch.order).toHaveBeenCalledWith('createdAt', { ascending: true });
  });

  /**
   * Neither the insert nor update path checked Supabase's `{ error }` response
   * — a NOT NULL violation (e.g. Deal.companyId when company resolution
   * failed), a connection blip, anything — was silently swallowed and the
   * record was counted as 'created'/'updated' even though nothing was written.
   */
  it('throws when the update call returns a Supabase error, instead of reporting success', async () => {
    const hubspotIdMatch = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'row-1', name: 'Acme' } }),
    });
    const updateChain = makeChain({ error: { message: 'null value in column "companyId" violates not-null constraint' } });
    mockFrom.mockReturnValueOnce(hubspotIdMatch).mockReturnValueOnce(updateChain);

    await expect(
      upsertByHubspotId('Deal', 'org-A', 'hs-1', { name: 'Big Deal', hubspotProperties: {} }, { column: 'name', value: 'Big Deal' }),
    ).rejects.toThrow(/companyId/);
  });

  it('throws when the insert call returns a Supabase error, instead of reporting success', async () => {
    const noHubspotIdMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const insertChain = makeChain({ error: { message: 'duplicate key value violates unique constraint' } });
    mockFrom.mockReturnValueOnce(noHubspotIdMatch).mockReturnValueOnce(insertChain);

    await expect(
      upsertByHubspotId('Company', 'org-A', 'hs-1', { name: 'Acme', hubspotProperties: {} }),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('upsertContactInteractionByHubspotId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new ContactInteraction when no existing row matches (contactId, hubspotId)', async () => {
    const noMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const insertChain = makeChain();
    mockFrom.mockReturnValueOnce(noMatch).mockReturnValueOnce(insertChain);

    const result = await upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', {
      type: 'NOTE', title: null, description: 'Called about term sheet', date: '2026-08-01T00:00:00.000Z',
    }, 'fill');

    expect(result).toBe('created');
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-1', hubspotId: 'hs-note-1', type: 'NOTE', description: 'Called about term sheet',
    }));
  });

  it('updates the existing row when (contactId, hubspotId) already matches', async () => {
    const match = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ci-1', description: 'Old text' } }),
    });
    const updateChain = makeChain();
    mockFrom.mockReturnValueOnce(match).mockReturnValueOnce(updateChain);

    const result = await upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', {
      type: 'NOTE', title: null, description: 'Corrected text', date: '2026-08-01T00:00:00.000Z',
    }, 'refresh');

    expect(result).toBe('updated');
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ description: 'Corrected text' }));
  });

  it('throws instead of silently swallowing a Supabase error on insert', async () => {
    const noMatch = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) });
    const insertChain = makeChain({ error: { message: 'null value in column "contactId"' } });
    mockFrom.mockReturnValueOnce(noMatch).mockReturnValueOnce(insertChain);

    await expect(
      upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', { type: 'NOTE', title: null, description: 'x', date: null }, 'fill'),
    ).rejects.toThrow(/contactId/);
  });

  it('throws instead of silently swallowing a Supabase error on update', async () => {
    const match = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ci-1', description: 'Old text' } }),
    });
    const updateChain = makeChain({ error: { message: 'connection reset' } });
    mockFrom.mockReturnValueOnce(match).mockReturnValueOnce(updateChain);

    await expect(
      upsertContactInteractionByHubspotId('contact-1', 'hs-note-1', { type: 'NOTE', title: null, description: 'x', date: null }, 'refresh'),
    ).rejects.toThrow(/connection reset/);
  });
});
