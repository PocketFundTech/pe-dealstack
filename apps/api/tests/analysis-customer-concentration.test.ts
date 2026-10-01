/**
 * Fix plan F1 (part 2): customer concentration and related-party flags from
 * document facts — the SRM analyst found "one customer at 39% of revenue
 * (also a part-owner)" by hand.
 */
import { describe, it, expect } from 'vitest';
import { analyzeFinancials } from '../src/services/analysis/index.js';
import {
  computeConcentrationRedFlags, computeConcentrationQoEFlags, type ConcentrationFacts, type CustomerFact,
} from '../src/services/analysis/customerConcentrationFlags.js';

const facts = (over: Partial<ConcentrationFacts> = {}): ConcentrationFacts => ({
  customers: [], topCustomers: null, relatedPartyTransactions: [], documentsRead: ['CIM.pdf'], generatedAt: '2026-10-01T00:00:00Z', ...over,
});
const customer = (name: string, revenueSharePct: number | null, over: Partial<CustomerFact> = {}): CustomerFact => ({
  name, revenueSharePct, relatedParty: false, relationship: null, quote: `${name} accounted for ${revenueSharePct}% of revenue`, document: 'CIM.pdf', ...over,
});
const ids = (f: ConcentrationFacts) => computeConcentrationRedFlags(f).map((x) => x.id);
const flag = (f: ConcentrationFacts, id: string) => computeConcentrationRedFlags(f).find((x) => x.id === id);

// SRM: one customer at 39% of revenue, also a part-owner of the company.
const SRM = facts({
  customers: [customer('Apex Builders', 39, {
    relatedParty: true, relationship: 'part-owner of the company',
    quote: 'Apex Builders, a part-owner of the company, represented 39% of FY2024 revenue.',
  })],
});

describe('concentration flag rules', () => {
  it('SRM: 39% customer who is also a part-owner → critical concentration + critical related party, citing the quote', () => {
    const conc = flag(SRM, 'customer_concentration')!;
    expect(conc.severity).toBe('critical');
    expect(conc.title).toBe('One Customer Is 39% of Revenue');
    expect(conc.evidence).toBe('"Apex Builders, a part-owner of the company, represented 39% of FY2024 revenue." (CIM.pdf)');
    const rp = flag(SRM, 'related_party_customer')!;
    expect(rp.severity).toBe('critical');
    expect(rp.title).toBe('Related-Party Customer: Apex Builders');
    expect(rp.detail).toContain('Apex Builders (part-owner of the company), 39% of revenue');
    expect(rp.evidence).toContain('CIM.pdf');
  });

  it('top customer thresholds: <20 none, 20-35 warning, ≥35 critical', () => {
    expect(ids(facts({ customers: [customer('A', 19.9)] }))).not.toContain('customer_concentration');
    expect(flag(facts({ customers: [customer('A', 20)] }), 'customer_concentration')!.severity).toBe('warning');
    expect(flag(facts({ customers: [customer('A', 34.9)] }), 'customer_concentration')!.severity).toBe('warning');
    expect(flag(facts({ customers: [customer('A', 35)] }), 'customer_concentration')!.severity).toBe('critical');
  });

  it('uses the largest customer when several are listed', () => {
    const f = facts({ customers: [customer('Small', 12), customer('Big', 27), customer('Mid', 18)] });
    expect(flag(f, 'customer_concentration')!.detail).toMatch(/^Big accounts for 27%/);
  });

  it('top-5 ≥ 60% → warning, from the document aggregate', () => {
    const f = facts({ topCustomers: { count: 5, sharePct: 62, quote: 'Top five customers represent 62% of sales.', document: 'MP.pdf' } });
    const t = flag(f, 'top_customers_concentration')!;
    expect(t.severity).toBe('warning');
    expect(t.title).toBe('Top 5 Customers Are 62% of Revenue');
    expect(t.evidence).toBe('"Top five customers represent 62% of sales." (MP.pdf)');
    expect(ids(facts({ topCustomers: { count: 5, sharePct: 59, quote: 'q', document: 'd' } }))).not.toContain('top_customers_concentration');
  });

  it('a top-10 aggregate does not trigger the top-5 rule; the listed top 5 are summed instead', () => {
    expect(ids(facts({ topCustomers: { count: 10, sharePct: 70, quote: 'q', document: 'd' } }))).toEqual([]);
    const f = facts({ customers: [customer('A', 18), customer('B', 16), customer('C', 14), customer('D', 8), customer('E', 6), customer('F', 5)] });
    expect(flag(f, 'top_customers_concentration')!.title).toBe('Top 5 Customers Are 62% of Revenue');
  });

  it('related-party customer: material share (≥10%) critical, small or unknown share warning', () => {
    const rp = (pct: number | null) => facts({ customers: [customer('Owner Co', pct, { relatedParty: true, relationship: 'owned by the founder' })] });
    expect(flag(rp(10), 'related_party_customer')!.severity).toBe('critical');
    expect(flag(rp(6), 'related_party_customer')!.severity).toBe('warning');
    expect(flag(rp(null), 'related_party_customer')!.severity).toBe('warning');
  });

  it('related-party suppliers / transactions → warning with each quote', () => {
    const f = facts({ relatedPartyTransactions: [
      { counterparty: 'Rock Quarry LLC', relationship: 'owned by the CEO', nature: 'supplies aggregates', quote: 'Aggregates are bought from Rock Quarry LLC, owned by the CEO.', document: 'Notes.pdf' },
    ] });
    const t = flag(f, 'related_party_transactions')!;
    expect(t.severity).toBe('warning');
    expect(t.detail).toContain('Rock Quarry LLC (owned by the CEO) — supplies aggregates');
    expect(t.evidence).toContain('(Notes.pdf)');
  });

  it('no facts / empty facts → no flags (never invent)', () => {
    expect(computeConcentrationRedFlags(null)).toEqual([]);
    expect(computeConcentrationRedFlags(undefined)).toEqual([]);
    expect(computeConcentrationRedFlags(facts())).toEqual([]);
  });

  it('QoE flags mirror the red flags with metric + evidence', () => {
    const q = computeConcentrationQoEFlags(SRM);
    expect(q.map((f) => [f.id, f.severity, f.category])).toEqual([
      ['customer_concentration', 'critical', 'Revenue Quality'],
      ['related_party_customer', 'critical', 'Related Parties'],
    ]);
    expect(q[0].metric).toBe('39% of revenue');
    expect(q[0].evidence).toContain('CIM.pdf');
  });
});

describe('analyzeFinancials integration', () => {
  const rows = [
    { statementType: 'INCOME_STATEMENT', periodType: 'HISTORICAL', period: '2023', lineItems: { revenue: 21, ebitda: 2.5 } },
    { statementType: 'INCOME_STATEMENT', periodType: 'HISTORICAL', period: '2024', lineItems: { revenue: 27.3, ebitda: 2.2 } },
  ];

  it('feeds red flags, Key Findings (QoE flags) and lowers the QoE score', async () => {
    const without = await analyzeFinancials('srm', rows);
    const withFacts = await analyzeFinancials('srm', rows, { concentration: SRM });
    expect(withFacts.redFlags!.map((f) => f.id)).toEqual(expect.arrayContaining(['customer_concentration', 'related_party_customer']));
    expect(withFacts.qoe.flags.map((f) => f.id)).toEqual(expect.arrayContaining(['customer_concentration', 'related_party_customer']));
    expect(withFacts.qoe.score).toBe(Math.max(0, without.qoe.score - 24));
  });

  it('is unchanged without facts (backward compatible)', async () => {
    const a = await analyzeFinancials('x', rows);
    const b = await analyzeFinancials('x', rows, { concentration: null });
    expect(b.redFlags).toEqual(a.redFlags);
    expect(b.qoe.flags).toEqual(a.qoe.flags);
  });
});
