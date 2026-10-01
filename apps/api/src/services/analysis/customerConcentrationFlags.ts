/**
 * Customer concentration + related-party red flags (fix plan F1, part 2).
 *
 * The SRM analyst found by hand that one customer was 39% of revenue and was
 * also a part-owner of the company. Neither number is on the financial
 * statements — they're in the CIM / management presentation / notes — so the
 * facts are read once per deal by customerConcentrationReader.ts (one bounded
 * Claude call, cached) and turned into flags here by fixed rules:
 *
 *   top customer ≥ 35% of revenue          → critical
 *   top customer ≥ 20%                     → warning
 *   top 5 (or fewer) customers ≥ 60%       → warning
 *   related-party customer, share ≥ 10%    → critical (else warning)
 *   related-party suppliers / transactions → warning
 *
 * Every flag cites the verbatim quote and the document it came from. No facts
 * (no documents, nothing found) → no flags; nothing is ever inferred here.
 */

import type { QoEFlag, RedFlag } from './types.js';

export interface SourcedFact {
  /** Verbatim sentence from the document (checked against the text by the reader). */
  quote: string;
  /** Name of the document the quote was found in. */
  document: string;
}

export interface CustomerFact extends SourcedFact {
  name: string;
  /** Share of revenue in percent (0-100), null when the document gives no share. */
  revenueSharePct: number | null;
  /** True when the customer is an owner / shareholder / affiliate / under common control. */
  relatedParty: boolean;
  /** How it is related ("part-owner", "affiliate of the founder"), null when not related. */
  relationship: string | null;
}

export interface TopCustomersFact extends SourcedFact {
  /** How many customers the aggregate covers (top 3, top 5, top 10 …). */
  count: number;
  sharePct: number;
}

export interface RelatedPartyFact extends SourcedFact {
  counterparty: string;
  relationship: string;
  /** What flows between them: "supplies cement", "leases the plant" … */
  nature: string;
}

export interface ConcentrationFacts {
  customers: CustomerFact[];
  topCustomers: TopCustomersFact | null;
  /** Related-party suppliers, landlords and other non-customer transactions. */
  relatedPartyTransactions: RelatedPartyFact[];
  /** Documents whose text was read. */
  documentsRead: string[];
  generatedAt: string;
}

export const TOP_CUSTOMER_WARNING_PCT = 20;
export const TOP_CUSTOMER_CRITICAL_PCT = 35;
export const TOP_FIVE_WARNING_PCT = 60;
export const RELATED_CUSTOMER_MATERIAL_PCT = 10;

const pct = (v: number) => `${Math.round(v * 10) / 10}%`;
const cite = (f: SourcedFact) => `"${f.quote}" (${f.document})`;

function topCustomer(facts: ConcentrationFacts): CustomerFact | null {
  return facts.customers
    .filter((c) => c.revenueSharePct != null)
    .sort((a, b) => b.revenueSharePct! - a.revenueSharePct!)[0] ?? null;
}

/** Top-5-or-fewer share: the document's own aggregate, else the sum of the listed top 5 (needs 2+). */
function topFiveShare(facts: ConcentrationFacts): { count: number; sharePct: number; evidence: string } | null {
  const agg = facts.topCustomers;
  if (agg && agg.count <= 5) return { count: agg.count, sharePct: agg.sharePct, evidence: cite(agg) };
  const listed = facts.customers
    .filter((c) => c.revenueSharePct != null)
    .sort((a, b) => b.revenueSharePct! - a.revenueSharePct!)
    .slice(0, 5);
  if (listed.length < 2) return null;
  return {
    count: listed.length,
    sharePct: listed.reduce((s, c) => s + c.revenueSharePct!, 0),
    evidence: listed.map(cite).join(' · '),
  };
}

export function computeConcentrationRedFlags(facts: ConcentrationFacts | null | undefined): RedFlag[] {
  if (!facts) return [];
  const flags: RedFlag[] = [];

  const top = topCustomer(facts);
  if (top && top.revenueSharePct! >= TOP_CUSTOMER_WARNING_PCT) {
    const critical = top.revenueSharePct! >= TOP_CUSTOMER_CRITICAL_PCT;
    flags.push({
      id: 'customer_concentration',
      severity: critical ? 'critical' : 'warning',
      category: 'Customer Concentration',
      title: `One Customer Is ${pct(top.revenueSharePct!)} of Revenue`,
      detail: `${top.name} accounts for ${pct(top.revenueSharePct!)} of revenue. Losing or repricing this account would ${critical ? 'materially impair' : 'noticeably hit'} revenue and EBITDA — check the contract term, renewal history and pricing power.`,
      evidence: cite(top),
      // Icons must be in web-next's subset font (lib/iconFont.ts ICON_NAMES).
      icon: 'person',
    });
  }

  const top5 = topFiveShare(facts);
  if (top5 && top5.sharePct >= TOP_FIVE_WARNING_PCT) {
    flags.push({
      id: 'top_customers_concentration',
      severity: 'warning',
      category: 'Customer Concentration',
      title: `Top ${top5.count} Customers Are ${pct(top5.sharePct)} of Revenue`,
      detail: `Revenue depends on a handful of accounts. Get the customer cube (revenue by customer by year) to test retention and pricing.`,
      evidence: top5.evidence,
      icon: 'groups',
    });
  }

  const related = facts.customers.filter((c) => c.relatedParty);
  if (related.length > 0) {
    const material = related.some((c) => (c.revenueSharePct ?? 0) >= RELATED_CUSTOMER_MATERIAL_PCT);
    const describe = (c: CustomerFact) =>
      `${c.name}${c.relationship ? ` (${c.relationship})` : ''}${c.revenueSharePct != null ? `, ${pct(c.revenueSharePct)} of revenue` : ''}`;
    flags.push({
      id: 'related_party_customer',
      severity: material ? 'critical' : 'warning',
      category: 'Related Parties',
      title: related.length === 1 ? `Related-Party Customer: ${related[0].name}` : `${related.length} Related-Party Customers`,
      detail: `${related.map(describe).join('; ')}. Sales to an owner or affiliate may not be at arm's length and may not survive a change of control — confirm pricing against third-party customers and get a supply agreement as a closing condition.`,
      evidence: related.map(cite).join(' · '),
      icon: 'handshake',
    });
  }

  if (facts.relatedPartyTransactions.length > 0) {
    const t = facts.relatedPartyTransactions;
    flags.push({
      id: 'related_party_transactions',
      severity: 'warning',
      category: 'Related Parties',
      title: t.length === 1 ? `Related-Party Transaction: ${t[0].counterparty}` : `${t.length} Related-Party Suppliers / Transactions`,
      detail: `${t.map((x) => `${x.counterparty} (${x.relationship}) — ${x.nature}`).join('; ')}. Costs paid to related parties may be off-market; normalise them in the QoE and check they continue post-close.`,
      evidence: t.map(cite).join(' · '),
      icon: 'link',
    });
  }

  return flags;
}

/** The same findings for the Quality of Earnings card (Key Findings), so they move the QoE score. */
export function computeConcentrationQoEFlags(facts: ConcentrationFacts | null | undefined): QoEFlag[] {
  const top = facts ? topCustomer(facts) : null;
  return computeConcentrationRedFlags(facts).map((f) => ({
    id: f.id,
    severity: f.severity,
    category: f.category === 'Related Parties' ? 'Related Parties' : 'Revenue Quality',
    title: f.title,
    detail: f.detail,
    metric: f.id === 'customer_concentration' && top ? `${pct(top.revenueSharePct!)} of revenue` : undefined,
    evidence: f.evidence,
    icon: f.icon,
  }));
}
