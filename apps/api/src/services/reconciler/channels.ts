// ─── Channel / Platform Concentration ──────────────────────────────
//
// Deterministic computation over FinancialStatement.lineItems that
// surfaces channel-tagged revenue (e.g. `revenue_stripe`,
// `revenue_wix_website_speedy`) and reports:
//   - per-channel breakdown for the latest stable window
//   - Herfindahl-Hirschman Index of platform shares (0-10000)
//   - verdict bucket using the FTC-adjusted "platform" thresholds
//   - a deterministic topChannelDependency narrative string
//
// Rationale: for a SaaS deal the single biggest diligence question is
// "what happens if the marketplace listing goes away?". The HHI gives
// a defensible single number, the channels[] array gives the story.
//
// Pure TS — no LLM calls. Returns null when no `revenue_<channel>`
// keys exist (the caller will skip the block entirely).
//
// IMPORTANT: lineItem values are stored in the statement's source unit
// scale (ACTUALS / THOUSANDS / MILLIONS / BILLIONS). Every read must
// go through toActualDollars(value, statement.unitScale) before summing.

import {
  type ChannelConcentrationAnalysis,
  type ReconcilerStatementInput,
  parsePeriodToYearMonth,
  toActualDollars,
} from './shared.js';

// ─── Channel slug detection ────────────────────────────────────────

/** Suffixes that mean "this is metadata about the revenue line, NOT a
 * channel-tagged amount". E.g. `revenue_source` is the source label,
 * not a Stripe-vs-Wix breakdown. Match on the LAST token of the slug. */
const RESERVED_SUFFIXES = new Set([
  'source',
  'pct',
  'percent',
  'ratio',
  'margin',
  'total',
]);

/** First-token tokens we recognise as a billing PLATFORM (vs. the
 * product/listing name that follows). When the slug starts with one
 * of these AND has more tokens, the display name is rendered as
 * "Platform - Product". Otherwise the whole slug is one name. */
const PLATFORM_TOKENS = new Set([
  'stripe',
  'wix',
  'shopify',
  'paddle',
  'chargebee',
  'recurly',
  'lemonsqueezy',
  'gumroad',
  'appstore',
  'googleplay',
]);

const PLATFORM_DISPLAY: Record<string, string> = {
  stripe: 'Stripe',
  wix: 'Wix',
  shopify: 'Shopify',
  paddle: 'Paddle',
  chargebee: 'Chargebee',
  recurly: 'Recurly',
  lemonsqueezy: 'LemonSqueezy',
  gumroad: 'Gumroad',
  appstore: 'App Store',
  googleplay: 'Google Play',
};

function titleCaseToken(token: string): string {
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/** Convert a channel slug (e.g. "wix_website_speedy") to its display
 * name. Special-cases bare `stripe` to "Stripe (direct)" because Stripe
 * is direct billing, not a marketplace listing. */
export function channelSlugToDisplayName(slug: string): string {
  const tokens = slug.split('_').filter(Boolean);
  if (tokens.length === 0) return slug;

  // Bare "stripe" — direct billing, distinct from marketplace listings.
  if (tokens.length === 1 && tokens[0] === 'stripe') {
    return 'Stripe (direct)';
  }

  const head = tokens[0]!;
  if (PLATFORM_TOKENS.has(head) && tokens.length > 1) {
    const platform = PLATFORM_DISPLAY[head] ?? titleCaseToken(head);
    const product = tokens.slice(1).map(titleCaseToken).join(' ');
    return `${platform} - ${product}`;
  }

  // Single-token, non-platform — just title-case it.
  // Multi-token, non-platform first — title-case all and join.
  return tokens.map(titleCaseToken).join(' ');
}

/** Extract the channel slug from a line-item key, or null if the key
 * is not a channel-tagged revenue line. Filters out the bare
 * `revenue` key and any key whose final token is in RESERVED_SUFFIXES. */
export function extractChannelSlug(key: string): string | null {
  if (!key.startsWith('revenue_')) return null;
  const slug = key.slice('revenue_'.length);
  if (!slug) return null;
  const tokens = slug.split('_').filter(Boolean);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1]!;
  if (RESERVED_SUFFIXES.has(last)) return null;
  return slug;
}

// ─── Period window selection ───────────────────────────────────────

interface PeriodWindow {
  asOfPeriod: string;
  /** Returns true when the given parsed period belongs in the window. */
  contains: (parsed: { year: number; month?: number }) => boolean;
}

/** Pick the most recent stable window for aggregation:
 *   - If any statement has a month, use the latest month's quarter
 *     (3 months), labelled "YYYY-Qn".
 *   - Otherwise use the latest year, labelled "YYYY".
 * Returns null when no statement has a parseable period. */
function selectPeriodWindow(
  statements: ReconcilerStatementInput[],
): PeriodWindow | null {
  let latestWithMonth: { year: number; month: number } | null = null;
  let latestYearOnly: number | null = null;

  for (const s of statements) {
    if (!s.isActive) continue;
    if (s.statementType !== 'INCOME_STATEMENT') continue;
    if (s.periodType === 'PROJECTED') continue;
    const parsed = parsePeriodToYearMonth(s.period);
    if (!parsed) continue;
    if (parsed.month != null) {
      if (
        latestWithMonth == null ||
        parsed.year > latestWithMonth.year ||
        (parsed.year === latestWithMonth.year &&
          parsed.month > latestWithMonth.month)
      ) {
        latestWithMonth = { year: parsed.year, month: parsed.month };
      }
    } else if (latestYearOnly == null || parsed.year > latestYearOnly) {
      latestYearOnly = parsed.year;
    }
  }

  if (latestWithMonth != null) {
    const { year, month } = latestWithMonth;
    const quarter = Math.ceil(month / 3); // 1..4
    const qStartMonth = (quarter - 1) * 3 + 1;
    const qEndMonth = qStartMonth + 2;
    return {
      asOfPeriod: `${year}-Q${quarter}`,
      contains: (p) =>
        p.month != null &&
        p.year === year &&
        p.month >= qStartMonth &&
        p.month <= qEndMonth,
    };
  }

  if (latestYearOnly != null) {
    const y = latestYearOnly;
    return {
      asOfPeriod: `${y}`,
      contains: (p) => p.year === y && p.month == null,
    };
  }

  return null;
}

// ─── Amount formatting for the narrative string ────────────────────

/** Format a dollar amount as "$XK" (rounded to nearest thousand) or
 * "$X.XM" (one decimal) for >= $1M. Used inside the narrative. */
function formatAmountShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) {
    const millions = amount / 1_000_000;
    // One decimal, but drop a trailing ".0" if it's an even count.
    const rounded = Math.round(millions * 10) / 10;
    const str = Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(1)}`;
    return `$${str}M`;
  }
  const k = Math.round(amount / 1_000);
  return `$${k}K`;
}

// ─── Main entry point ──────────────────────────────────────────────

export function computeChannelConcentration(
  statements: ReconcilerStatementInput[],
): ChannelConcentrationAnalysis | null {
  if (!Array.isArray(statements) || statements.length === 0) return null;

  // Quick check: do any active income statements carry a channel-tagged
  // revenue line at all? If not, bail early — nothing to compute.
  let anyChannelKey = false;
  for (const s of statements) {
    if (!s.isActive) continue;
    if (s.statementType !== 'INCOME_STATEMENT') continue;
    for (const k of Object.keys(s.lineItems)) {
      if (extractChannelSlug(k) != null) {
        anyChannelKey = true;
        break;
      }
    }
    if (anyChannelKey) break;
  }
  if (!anyChannelKey) return null;

  // Pick the window. If we can't parse any period, we can't aggregate.
  const window = selectPeriodWindow(statements);
  if (!window) return null;

  // Aggregate channel amounts in actual dollars across the window.
  // Track the bare `revenue` line separately — when present it is the
  // authoritative TOTAL revenue, and channel pct is computed against
  // it (so untagged revenue is reflected as <100% sum of channels).
  const amounts = new Map<string, number>();
  let bareRevenueTotal = 0;
  let bareRevenueSeen = false;
  for (const s of statements) {
    if (!s.isActive) continue;
    if (s.statementType !== 'INCOME_STATEMENT') continue;
    if (s.periodType === 'PROJECTED') continue;
    const parsed = parsePeriodToYearMonth(s.period);
    if (!parsed) continue;
    if (!window.contains(parsed)) continue;

    for (const [key, raw] of Object.entries(s.lineItems)) {
      if (key === 'revenue') {
        const dollars = toActualDollars(raw, s.unitScale);
        if (dollars != null) {
          bareRevenueTotal += dollars;
          bareRevenueSeen = true;
        }
        continue;
      }
      const slug = extractChannelSlug(key);
      if (slug == null) continue;
      const dollars = toActualDollars(raw, s.unitScale);
      if (dollars == null) continue;
      amounts.set(slug, (amounts.get(slug) ?? 0) + dollars);
    }
  }

  if (amounts.size === 0) return null;

  // Drop non-positive contributions (negative refunds shouldn't count
  // as a concentrated channel; zero is just noise).
  const positive: Array<{ slug: string; amount: number }> = [];
  for (const [slug, amount] of amounts) {
    if (amount > 0) positive.push({ slug, amount });
  }
  if (positive.length === 0) return null;

  const channelSum = positive.reduce((acc, c) => acc + c.amount, 0);
  // Denominator: bare `revenue` total when present and credible, else
  // the sum of channels. The bare line accounts for revenue not tagged
  // to any specific channel (e.g. one-off services, refunds netted in).
  // Only use the bare total when it is at least as large as the channel
  // sum — otherwise the data is internally inconsistent and we'd report
  // shares >100%, which is worse than just using the channel sum.
  const total =
    bareRevenueSeen && bareRevenueTotal >= channelSum && bareRevenueTotal > 0
      ? bareRevenueTotal
      : channelSum;
  if (total <= 0) return null;

  // Channel amounts in the output are reported as the MONTHLY AVERAGE
  // across the window (window total / number of months). Quarter
  // windows are 3 months; annual windows are 12. This matches the spec
  // narrative (e.g. "$43K/mo") and lets the UI present a "$/mo run-rate"
  // figure directly. HHI is computed from shares so it's unaffected.
  const isQuarterly = /^\d{4}-Q[1-4]$/.test(window.asOfPeriod);
  const monthsInWindow = isQuarterly ? 3 : 12;

  // Build channels[], sorted descending by amount.
  positive.sort((a, b) => b.amount - a.amount);
  const channels = positive.map((c) => {
    // Round monthly amount to nearest dollar for display stability —
    // sub-cent residue from THOUSANDS/MILLIONS scaling is meaningless.
    const monthlyAmount = c.amount / monthsInWindow;
    const amount = Math.round(monthlyAmount);
    const pctOfTotal = c.amount / total;
    return {
      name: channelSlugToDisplayName(c.slug),
      amount,
      // Round share to 3 decimals so output matches the spec's
      // "0.456 / 0.412 / 0.077" style. HHI is computed from the
      // unrounded share to avoid double-rounding.
      pctOfTotal: Math.round(pctOfTotal * 1000) / 1000,
    };
  });

  // HHI = Σ (share_pct)² where share_pct is on a 0-100 scale.
  // Compute from the UNROUNDED shares for fidelity, then round to int.
  let hhi = 0;
  for (const c of positive) {
    const sharePct = (c.amount / total) * 100;
    hhi += sharePct * sharePct;
  }
  const platformConcentrationHHI = Math.round(hhi);

  // Verdict thresholds tuned to user-validated calibration: HHI ≈ 3850
  // (Website Speedy Q1-26 — Stripe + Wix-WS + Shopify) reads as
  // MODERATELY_CONCENTRATED, not HIGHLY. Pure FTC platform-risk brackets
  // would put 3850 in the HIGHLY bucket but for a 3-5 channel SaaS at
  // this scale that's an over-call. Keep the spread wider.
  let platformConcentrationVerdict: ChannelConcentrationAnalysis['platformConcentrationVerdict'];
  if (platformConcentrationHHI < 2000) {
    platformConcentrationVerdict = 'UNCONCENTRATED';
  } else if (platformConcentrationHHI < 4000) {
    platformConcentrationVerdict = 'MODERATELY_CONCENTRATED';
  } else {
    platformConcentrationVerdict = 'HIGHLY_CONCENTRATED';
  }

  // Narrative — frames the largest MARKETPLACE listing as the at-risk
  // channel and Stripe direct billing (when present) as the survivor.
  // Marketplace listings (Wix, Shopify, App Store, etc.) can be pulled
  // by the platform owner; Stripe direct billing is just payment rails
  // and continues to flow regardless. When no Stripe is present, fall
  // back to "biggest channel + next biggest as survivor".
  // Amounts are reported per-month so the reader sees the immediate
  // monthly hit, not the quarter aggregate.
  const stripeDirect = positive.find((c) => c.slug === 'stripe');
  const nonStripeChannels = positive.filter((c) => c.slug !== 'stripe');

  let atRisk: { slug: string; amount: number } | undefined;
  let survivor: { slug: string; amount: number } | undefined;
  if (stripeDirect && nonStripeChannels.length > 0) {
    // Largest marketplace listing is the at-risk one; Stripe survives.
    atRisk = nonStripeChannels[0];
    survivor = stripeDirect;
  } else {
    // No Stripe (or only Stripe). Use straight top vs. second.
    atRisk = positive[0];
    survivor = positive[1];
  }

  let topChannelDependency: string;
  if (atRisk) {
    const atRiskName = channelSlugToDisplayName(atRisk.slug);
    const atRiskMonthly = atRisk.amount / monthsInWindow;
    const atRiskPctDisplay = Math.round((atRisk.amount / total) * 100);
    if (survivor) {
      const survivorName = channelSlugToDisplayName(survivor.slug);
      const survivorMonthly = survivor.amount / monthsInWindow;
      topChannelDependency =
        `If ${atRiskName} listing is removed or terms changed materially, ~` +
        `${formatAmountShort(atRiskMonthly)}/mo (${atRiskPctDisplay}% of revenue) ` +
        `is immediately at risk. ${survivorName} of ` +
        `${formatAmountShort(survivorMonthly)}/mo would survive.`;
    } else {
      topChannelDependency =
        `If ${atRiskName} listing is removed or terms changed materially, ~` +
        `${formatAmountShort(atRiskMonthly)}/mo (${atRiskPctDisplay}% of revenue) ` +
        `is immediately at risk. No diversifying channel is present.`;
    }
  } else {
    topChannelDependency = '';
  }

  return {
    asOfPeriod: window.asOfPeriod,
    channels,
    platformConcentrationHHI,
    platformConcentrationVerdict,
    topChannelDependency,
  };
}
