/** 5 Oct testing, item 8: uploads created duplicate deals for the same company. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let deals: any[] = [];
let queried: Record<string, unknown> = {};
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => { queried[k] = v; return b; },
        is: (k: string, v: unknown) => { queried[`is:${k}`] = v; return b; },
        order: () => b,
        limit: async () => ({ data: live(), error: null }),
        range: async (from: number, to: number) => ({ data: live().slice(from, to + 1), error: null }),
      };
      return b;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const live = () => deals.filter((d) => d.organizationId === queried.organizationId && d.deletedAt == null
  && (!('is:hubspotId' in queried) || d.hubspotId == null));
const { normaliseCompanyName, findLiveDealForCompany, loadLiveDealIndex } = await import('../src/services/dealDuplicates.js');

beforeEach(() => {
  queried = {};
  deals = [
    { id: 'd1', name: 'Strong Ready Mix', organizationId: 'o1', deletedAt: null, company: { name: 'Strong Ready Mix, Ltd.' } },
    { id: 'd2', name: 'Acme Holdings', organizationId: 'o1', deletedAt: '2026-10-01', company: { name: 'Acme Inc' } },
    { id: 'd3', name: 'Northwind', organizationId: 'o2', deletedAt: null, company: { name: 'Northwind' } },
  ];
});

describe('normaliseCompanyName', () => {
  it.each([
    ['Strong Ready Mix, Ltd.', 'strong ready mix'],
    ['STRONG READY MIX LTD', 'strong ready mix'],
    ['Acme, Inc.', 'acme'],
    ['Smith & Sons LLC', 'smith and sons'],
  ])('%s → %s', (a, b) => expect(normaliseCompanyName(a)).toBe(b));
});

describe('findLiveDealForCompany', () => {
  it('finds the live deal whatever the suffix / case the document uses', async () => {
    await expect(findLiveDealForCompany('o1', 'STRONG READY MIX LTD')).resolves.toEqual({ id: 'd1', name: 'Strong Ready Mix' });
  });

  it('ignores deleted deals and other orgs', async () => {
    await expect(findLiveDealForCompany('o1', 'Acme, Inc.')).resolves.toBeNull();
    await expect(findLiveDealForCompany('o1', 'Northwind')).resolves.toBeNull();
    expect(queried['is:deletedAt']).toBeNull();
  });

  it('never matches on a too-short or missing name', async () => {
    await expect(findLiveDealForCompany('o1', 'Co.')).resolves.toBeNull();
    await expect(findLiveDealForCompany('o1', null)).resolves.toBeNull();
  });
});

describe('loadLiveDealIndex', () => {
  it('keys live deals by normalised company and deal name, skipping deleted and other-org deals', async () => {
    const index = await loadLiveDealIndex('o1');
    expect(index.get('strong ready mix')).toEqual({ id: 'd1', name: 'Strong Ready Mix' });
    expect(index.has('acme')).toBe(false);
    expect(index.has('northwind')).toBe(false);
  });

  it('pages past the first 1,000 deals', async () => {
    deals = Array.from({ length: 1500 }, (_, i) => ({ id: `x${i}`, name: `Target ${i}`, organizationId: 'o1', deletedAt: null, company: null }));
    const index = await loadLiveDealIndex('o1');
    expect(index.get('target 1499')).toEqual({ id: 'x1499', name: 'Target 1499' });
  });

  it('unlinkedOnly leaves out deals a HubSpot deal already owns (HubSpot import)', async () => {
    deals = [
      { id: 'cim', name: 'Acme', organizationId: 'o1', deletedAt: null, hubspotId: null, company: { name: 'Acme Inc' } },
      { id: 'hs', name: 'Beta', organizationId: 'o1', deletedAt: null, hubspotId: '123', company: { name: 'Beta LLC' } },
    ];
    const index = await loadLiveDealIndex('o1', { unlinkedOnly: true });
    expect(queried['is:hubspotId']).toBeNull();
    expect(index.get('acme')).toEqual({ id: 'cim', name: 'Acme' });
    expect(index.has('beta')).toBe(false);
  });
});
