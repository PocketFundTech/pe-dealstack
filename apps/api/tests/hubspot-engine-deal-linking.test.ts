/**
 * 7 Oct testing (David's HubSpot): the import created a second deal for a
 * company that already had one in Avise (uploaded from a CIM). A HubSpot deal
 * with no hubspotId match must link to the live, not-yet-linked Avise deal
 * for the same company (exact normalised name), and the job must say so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, listPage, upsertByHubspotId, loadLiveDealIndex } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  listPage: vi.fn(),
  upsertByHubspotId: vi.fn(),
  loadLiveDealIndex: vi.fn(),
}));

vi.mock('../src/supabase.js', () => ({ supabase: { from: mockFrom } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () {
    return {
      listPage,
      listPropertyNames: vi.fn().mockResolvedValue(['dealname']),
      listDealStageLabels: vi.fn().mockResolvedValue({}),
      countObjects: vi.fn().mockResolvedValue(null),
    };
  }),
}));
vi.mock('../src/services/hubspot/dedup.js', () => ({ upsertByHubspotId }));
vi.mock('../src/services/dealDuplicates.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/dealDuplicates.js')>()),
  loadLiveDealIndex,
}));

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

function makeChain(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [] }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  };
  return Object.assign(base, overrides);
}

/**
 * Wire supabase: ImportJob load → the job; Company lookups by hubspotId →
 * `companies[hsId]`; final ImportJob update captured in `saved`.
 */
function setup(currentObject: string, companies: Record<string, { id: string; name: string }>) {
  const saved: Array<Record<string, unknown>> = [];
  const companyChains: Array<Record<string, any>> = [];
  let importJobCalls = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'ImportJob') {
      importJobCalls += 1;
      if (importJobCalls === 1) {
        return makeChain({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'job-1', organizationId: 'org-A', status: 'running', objectCounts: {}, currentObject, cursor: null },
          }),
        });
      }
      const chain = makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1' } }) });
      (chain.update as any).mockImplementation((patch: Record<string, unknown>) => { saved.push(patch); return chain; });
      return chain;
    }
    if (table === 'Company') {
      let hsId: string | null = null;
      const chain = makeChain();
      chain.eq = vi.fn().mockImplementation((col: string, v: string) => { if (col === 'hubspotId') hsId = v; return chain; });
      chain.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve({ data: hsId ? companies[hsId] ?? null : { id: 'stub' } }));
      companyChains.push(chain);
      return chain;
    }
    return makeChain();
  });
  return { saved, companyChains };
}

function deal(id: string, dealname: string, companyHsId: string | null) {
  return {
    id,
    properties: { dealname },
    associations: companyHsId ? { companies: { results: [{ id: companyHsId }] } } : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStageLabelCache();
});

describe('deals — link to the existing Avise deal for the same company', () => {
  it('passes the unlinked CIM deal as adoptId and counts it as matched', async () => {
    const { saved } = setup('deals', { 'hs-c1': { id: 'company-acme', name: 'Acme, Inc.' } });
    loadLiveDealIndex.mockResolvedValue(new Map([['acme', { id: 'cim-deal', name: 'Acme Inc' }]]));
    upsertByHubspotId.mockResolvedValue('linked');
    listPage.mockResolvedValue({ results: [deal('hs-d1', 'Acme growth round', 'hs-c1')], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    expect(loadLiveDealIndex).toHaveBeenCalledWith('org-A', { unlinkedOnly: true });
    const call = upsertByHubspotId.mock.calls[0];
    expect(call[0]).toBe('Deal');
    expect(call[3]).toMatchObject({ companyId: 'company-acme' });
    expect(call[4]).toEqual({ column: 'name', value: 'Acme growth round', adoptId: 'cim-deal' });
    const counts = saved.at(-1)!.objectCounts as Record<string, Record<string, number>>;
    expect(counts.deals).toMatchObject({ processed: 1, created: 0, updated: 1, matched: 1 });
  });

  it('loads the index once per batch and never offers the same Avise deal to a second HubSpot deal', async () => {
    setup('deals', { 'hs-c1': { id: 'company-acme', name: 'Acme' } });
    loadLiveDealIndex.mockResolvedValue(new Map([
      ['acme', { id: 'cim-deal', name: 'Acme' }],
    ]));
    upsertByHubspotId.mockResolvedValueOnce('linked').mockResolvedValueOnce('created');
    listPage.mockResolvedValue({
      results: [deal('hs-d1', 'Acme 2024', 'hs-c1'), deal('hs-d2', 'Acme add-on', 'hs-c1')],
      nextCursor: null,
    });

    await runImportBatch('job-1', 'tok');

    expect(loadLiveDealIndex).toHaveBeenCalledTimes(1);
    expect(upsertByHubspotId.mock.calls[0][4]).toMatchObject({ adoptId: 'cim-deal' });
    expect(upsertByHubspotId.mock.calls[1][4]).toMatchObject({ adoptId: null });
  });

  it('only matches an exact normalised company name — no fuzzy matching', async () => {
    setup('deals', { 'hs-c1': { id: 'company-acme', name: 'Acme Logistics' } });
    loadLiveDealIndex.mockResolvedValue(new Map([['acme', { id: 'cim-deal', name: 'Acme' }]]));
    upsertByHubspotId.mockResolvedValue('created');
    listPage.mockResolvedValue({ results: [deal('hs-d1', 'Acme Logistics', 'hs-c1')], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    expect(upsertByHubspotId.mock.calls[0][4]).toMatchObject({ adoptId: null });
  });

  it.each([
    ['no associated company', null, {}],
    ['an "Unknown Company" placeholder', 'hs-c1', { 'hs-c1': { id: 'c1', name: 'Unknown Company' } }],
    ['a name under 3 normalised characters', 'hs-c1', { 'hs-c1': { id: 'c1', name: 'AB Ltd' } }],
  ] as const)('skips matching for %s', async (_label, companyHsId, companies) => {
    setup('deals', companies as Record<string, { id: string; name: string }>);
    loadLiveDealIndex.mockResolvedValue(new Map([['unknown', { id: 'x', name: 'x' }], ['ab', { id: 'y', name: 'y' }]]));
    upsertByHubspotId.mockResolvedValue('created');
    listPage.mockResolvedValue({ results: [deal('hs-d1', 'Some deal', companyHsId)], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    expect(loadLiveDealIndex).not.toHaveBeenCalled();
    expect(upsertByHubspotId.mock.calls[0][4]).toMatchObject({ adoptId: null });
  });

  it('wires the deal to its own HubSpot company, not the first company with the same name', async () => {
    setup('deals', {
      'hs-c1': { id: 'acme-1', name: 'Acme' },
      'hs-c2': { id: 'acme-2', name: 'Acme' },
    });
    loadLiveDealIndex.mockResolvedValue(new Map());
    upsertByHubspotId.mockResolvedValue('created');
    listPage.mockResolvedValue({ results: [deal('hs-d2', 'Acme two', 'hs-c2')], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    expect(upsertByHubspotId.mock.calls[0][3]).toMatchObject({ companyId: 'acme-2' });
  });

  it('escapes LIKE wildcards when it falls back to resolving the company by name', async () => {
    // Company row exists for the hubspotId but (as in older data) without an id
    // in the select — forces the by-name resolution path.
    const { companyChains } = setup('deals', { 'hs-c1': { name: '100%_Growth' } as { id: string; name: string } });
    loadLiveDealIndex.mockResolvedValue(new Map());
    upsertByHubspotId.mockResolvedValue('created');
    listPage.mockResolvedValue({ results: [deal('hs-d1', 'Growth deal', 'hs-c1')], nextCursor: null });

    await runImportBatch('job-1', 'tok');

    const byName = companyChains.find((c) => (c.ilike as any).mock.calls.length > 0)!;
    expect(byName.ilike).toHaveBeenCalledWith('name', '100\\%\\_Growth');
  });
});

describe('companies — linked rows are counted', () => {
  it('counts a "linked" company as updated and matched', async () => {
    const { saved } = setup('companies', {});
    upsertByHubspotId.mockResolvedValueOnce('linked').mockResolvedValueOnce('created');
    listPage.mockResolvedValue({
      results: [
        { id: 'hs-c1', properties: { name: 'Acme' } },
        { id: 'hs-c2', properties: { name: 'Acme' } },
      ],
      nextCursor: null,
    });

    await runImportBatch('job-1', 'tok');

    const counts = saved.at(-1)!.objectCounts as Record<string, Record<string, number>>;
    expect(counts.companies).toMatchObject({ processed: 2, created: 1, updated: 1, matched: 1 });
  });
});
