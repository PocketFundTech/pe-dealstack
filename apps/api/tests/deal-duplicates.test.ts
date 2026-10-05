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
        limit: async () => ({ data: deals.filter((d) => d.organizationId === queried.organizationId && d.deletedAt == null), error: null }),
      };
      return b;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const { normaliseCompanyName, findLiveDealForCompany } = await import('../src/services/dealDuplicates.js');

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
