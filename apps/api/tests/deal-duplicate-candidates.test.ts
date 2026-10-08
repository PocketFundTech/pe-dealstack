/**
 * Testers: "the app doesn't flag a duplicate deal before creating it" — the
 * document named the company differently ("CSP" vs "Community Solar Platform
 * Holdings") so the exact match never fired. Fuzzy candidates are only ever
 * used to ASK the user; these tests pin down what counts as "similar".
 */
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

const { scoreCompanyNameMatch, rankDuplicateCandidates, findDuplicateCandidates, jaroWinkler } = await import('../src/services/dealDuplicates.js');

describe('scoreCompanyNameMatch — exact', () => {
  it.each([
    ['Acme, Inc.', 'ACME inc'],
    ['Strong Ready Mix, Ltd.', 'strong ready mix'],
    ['Smith & Sons LLC', 'Smith and Sons'],
  ])('%s = %s', (a, b) => expect(scoreCompanyNameMatch(a, b)).toBe('exact'));
});

describe('scoreCompanyNameMatch — similar (ask the user)', () => {
  it.each([
    ['CSP', 'Community Solar Platform Holdings', 'acronym'],
    ['Community Solar Platform Holdings LLC', 'CSP', 'acronym, either side'],
    ['C.S.P.', 'Community Solar Platform', 'dotted acronym'],
    ['BOA', 'Bank of America', 'acronym with a stopword'],
    ['ABC', 'American Broadcasting Company', 'acronym whose last word is a legal suffix'],
    ['Northwind', 'Northwind Cold Chain', 'name + extra words'],
    ['Strong Ready Mix', 'Strong Ready Mix Concrete', 'name + extra words'],
    ['Blue Ridge', 'Blue Ridge Capital Partners', 'name + generic words'],
    ['NorthWind Logistics', 'North Wind Logistics', 'spacing'],
    ['Acme Partners', 'Acme Capital', 'same distinctive word, different generic padding'],
    ['Solar Brightline', 'Brightline Solar', 'same words, other order'],
    ['Brightline Renewables', 'Brightlyne Renewables', 'typo in a long word'],
    ['The Cobalt Company', 'Cobalt', 'stopwords + suffix'],
  ])('%s ~ %s (%s)', (a, b) => expect(scoreCompanyNameMatch(a, b)).toBe('similar'));
});

describe('scoreCompanyNameMatch — not a match', () => {
  it.each([
    ['Summit Partners', 'Apex Partners', 'only a generic word shared'],
    ['Summit Partners', 'Summit Health', 'different second word, neither a prefix'],
    ['Capital Partners', 'Capital Partners Group Europe', 'prefix is generic words only'],
    ['American Tower', 'American Airlines', 'shared geographic word'],
    ['Acme Health', 'Acme Wealth', 'short words must match exactly'],
    ['Brighton Health', 'Brighton Wealth', 'short words must match exactly'],
    ['CSP', 'Cobalt Solar', 'acronym length ≠ word count'],
    ['CSP', 'Community Platform Solar', 'initials in the wrong order'],
    ['AB', 'Alpha Beta', 'two-letter acronym is too weak'],
    ['Co.', 'Co', 'too short'],
    ['Northwind', 'Southwind', 'different name'],
    ['', 'Acme', 'empty'],
    [null, 'Acme', 'missing'],
  ])('%s ≁ %s (%s)', (a, b) => expect(scoreCompanyNameMatch(a as any, b)).toBeNull());
});

describe('jaroWinkler', () => {
  it('is 1 for equal strings and high for a one-letter typo', () => {
    expect(jaroWinkler('brightline', 'brightline')).toBe(1);
    expect(jaroWinkler('brightline', 'brightlyne')).toBeGreaterThan(0.92);
    expect(jaroWinkler('northwind', 'zebra')).toBeLessThan(0.6);
  });
});

describe('rankDuplicateCandidates', () => {
  const rows = [
    { id: 'd1', name: 'CSP', company: { name: 'CSP' } },
    { id: 'd2', name: 'Unrelated Co', company: { name: 'Unrelated' } },
    { id: 'd3', name: 'Community Solar Platform', company: [{ name: 'Community Solar Platform Holdings' }] },
    { id: 'd4', name: 'Community Solar', company: null },
    { id: 'd5', name: 'Community Solar Platform Two', company: null },
    { id: 'd6', name: 'Community Solar Platform III', company: null },
  ];

  it('puts exact matches first and caps the list at 3', () => {
    const out = rankDuplicateCandidates('Community Solar Platform Holdings, LLC', rows);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 'd3', name: 'Community Solar Platform', companyName: 'Community Solar Platform Holdings', reason: 'exact' });
    expect(out.slice(1).every((c) => c.reason === 'similar')).toBe(true);
    expect(out.map((c) => c.id)).not.toContain('d2');
  });

  it('matches on the deal name when the company name differs', () => {
    const out = rankDuplicateCandidates('CSP', [{ id: 'x', name: 'Community Solar Platform', company: { name: 'Something Else Entirely' } }]);
    expect(out).toEqual([{ id: 'x', name: 'Community Solar Platform', companyName: 'Something Else Entirely', reason: 'similar' }]);
  });

  it('returns nothing when nothing looks alike', () => {
    expect(rankDuplicateCandidates('Zephyr Analytics', rows)).toEqual([]);
  });
});

describe('findDuplicateCandidates', () => {
  beforeEach(() => {
    queried = {};
    deals = [
      { id: 'd1', name: 'Community Solar Platform', organizationId: 'o1', deletedAt: null, company: { name: 'Community Solar Platform Holdings' } },
      { id: 'd2', name: 'CSP', organizationId: 'o1', deletedAt: '2026-10-01', company: { name: 'CSP' } },
      { id: 'd3', name: 'CSP', organizationId: 'o2', deletedAt: null, company: { name: 'CSP' } },
    ];
  });

  it('finds a similar live deal in the same org only', async () => {
    await expect(findDuplicateCandidates('o1', 'CSP')).resolves.toEqual([
      { id: 'd1', name: 'Community Solar Platform', companyName: 'Community Solar Platform Holdings', reason: 'similar' },
    ]);
    expect(queried['is:deletedAt']).toBeNull();
  });

  it('returns [] for a missing name without querying', async () => {
    await expect(findDuplicateCandidates('o1', null)).resolves.toEqual([]);
    expect(queried.organizationId).toBeUndefined();
  });
});
