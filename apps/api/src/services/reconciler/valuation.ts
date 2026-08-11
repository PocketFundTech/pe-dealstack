// ─── Valuation Framing — Quantitative Reconciler (Phase 1) ─────────
//
// Pure-TS deterministic module. Given an asking price and a handful of
// numerator inputs (TTM gross revenue, TTM net income as SDE proxy,
// and a 3-month annualised revenue run-rate), emit a per-basis verdict
// describing how the asking-price multiple stacks up against published
// micro-SaaS comparable bands.
//
// Comp-band source:
//   FE International / Empire Flippers micro-SaaS averages, $100K-$5M
//   ARR (widely-published market data — used here as defaults).
//
//   FE International publishes annual SaaS Industry Reports; Empire
//   Flippers publishes monthly transaction data. Both consistently
//   land bootstrapped / micro-SaaS deals in this revenue band at
//   roughly 2.5x-4.0x trailing revenue and 3.0x-5.0x SDE.
//
// These constants are deliberately hard-coded for Phase 1. Phase 2 will
// surface a per-deal override (e.g. "this is a vertical SaaS with sticky
// customers, use 4.0x-6.0x") and persist the override + its rationale
// alongside the deal record.
//
// No LLM calls in this module — verdicts are pure threshold comparisons.

import type { ValuationFraming, ValuationVerdict } from './shared.js';

// ─── Comp-band reference table ─────────────────────────────────────
//
// One row per framing basis. `verdict` is decided by where the computed
// multiple falls inside `thresholds` (each entry is the inclusive lower
// bound of that bucket; the implicit upper bound is the next entry's
// lower bound, with the final ABOVE_BAND bucket open-ended).

interface CompBand {
  basis: string;
  comp_band_for_microSaaS: string;
  /** Ordered low→high. The last entry must be ABOVE_BAND. */
  thresholds: Array<{ min: number; verdict: ValuationVerdict }>;
}

const TTM_REVENUE_BAND: CompBand = {
  basis: 'TTM Gross Revenue',
  comp_band_for_microSaaS: '2.5x-4.0x',
  thresholds: [
    { min: 0,    verdict: 'BELOW_BAND' },
    { min: 2.5,  verdict: 'BOTTOM_OF_BAND_FAVORABLE' },
    { min: 3.0,  verdict: 'WITHIN_BAND' },
    { min: 3.5,  verdict: 'UPPER_HALF_OF_BAND' },
    { min: 4.0,  verdict: 'ABOVE_BAND' },
  ],
};

const TTM_NET_INCOME_BAND: CompBand = {
  basis: 'TTM Net Income (proxy for SDE)',
  comp_band_for_microSaaS: '3.0x-5.0x SDE',
  thresholds: [
    { min: 0,    verdict: 'BELOW_BAND' },
    { min: 3.0,  verdict: 'BOTTOM_OF_BAND_FAVORABLE' },
    { min: 3.5,  verdict: 'WITHIN_BAND' },
    { min: 4.5,  verdict: 'UPPER_HALF_OF_BAND' },
    { min: 5.0,  verdict: 'ABOVE_BAND' },
  ],
};

const THREE_MO_ARR_BAND: CompBand = {
  basis: '3-Month Annualized Revenue',
  comp_band_for_microSaaS: '2.5x-4.0x',
  // Same as TTM Gross Revenue.
  thresholds: TTM_REVENUE_BAND.thresholds,
};

// ─── Helpers ───────────────────────────────────────────────────────

function classify(multiple: number, band: CompBand): ValuationVerdict {
  // Walk from highest threshold downward; first one whose `min` is
  // <= multiple wins. Guarantees the open-ended ABOVE_BAND bucket is
  // selected when multiple exceeds the top threshold.
  for (let i = band.thresholds.length - 1; i >= 0; i--) {
    if (multiple >= band.thresholds[i].min) {
      return band.thresholds[i].verdict;
    }
  }
  // Defensive: the first threshold has min=0, so we should never
  // reach here for a finite, non-negative multiple.
  return 'BELOW_BAND';
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Public API ────────────────────────────────────────────────────

export function computeValuationFraming(input: {
  askingPriceUsd: number;
  ttmGrossRevenueUsd: number | null;
  ttmNetIncomeUsd: number | null;
  threeMoAnnualizedRevenueUsd: number | null;
}): ValuationFraming | null {
  const {
    askingPriceUsd,
    ttmGrossRevenueUsd,
    ttmNetIncomeUsd,
    threeMoAnnualizedRevenueUsd,
  } = input;

  // Need a positive asking price to compute multiples.
  if (!Number.isFinite(askingPriceUsd) || askingPriceUsd <= 0) {
    return null;
  }

  // Need at least one numerator input to emit a framing.
  if (
    ttmGrossRevenueUsd == null &&
    ttmNetIncomeUsd == null &&
    threeMoAnnualizedRevenueUsd == null
  ) {
    return null;
  }

  const framings: ValuationFraming['framings'] = [];

  const candidates: Array<{ value: number | null; band: CompBand }> = [
    { value: ttmGrossRevenueUsd,           band: TTM_REVENUE_BAND },
    { value: ttmNetIncomeUsd,              band: TTM_NET_INCOME_BAND },
    { value: threeMoAnnualizedRevenueUsd,  band: THREE_MO_ARR_BAND },
  ];

  for (const { value, band } of candidates) {
    if (value == null || !Number.isFinite(value) || value <= 0) continue;
    const multiple = roundTo2(askingPriceUsd / value);
    framings.push({
      basis: band.basis,
      value,
      multiple,
      comp_band_for_microSaaS: band.comp_band_for_microSaaS,
      verdict: classify(multiple, band),
    });
  }

  if (framings.length === 0) return null;

  return {
    askingPrice: askingPriceUsd,
    framings,
  };
}
