// ─── Ground-Truth Aggregator ───────────────────────────────────────
//
// Phase 1 of the Quantitative Reconciler. Pure-TS, deterministic.
//
// Reads slim `ReconcilerStatementInput` rows (already in DB) and
// computes the canonical aggregates a PE analyst would produce in a
// spreadsheet:
//
//   • annualGrossRevenue / annualNetIncome / annualNetMargin keyed by
//     "<year>_full" (12 months) or "<year>_partial_<MonStart><MonEnd>"
//   • latestMonthMRR — most recent monthly period and its annualised view
//   • TTM_revenue / TTM_netIncome / TTM_netMargin — sum of last 12 months
//   • trailingThreeMonthAvgMRR + impliedARR_3MoAvg
//   • valuationContextAtAskingPrice — multiples vs ctx.askingPriceUsd
//
// Edge-cases handled:
//   • Sparse data (no monthly rows → MRR + TTM null; no annual data
//     either → empty annualGrossRevenue map)
//   • Mixed monthly + annual rows for the same year → prefer monthly
//     aggregation, drop the annual row for that year, and emit a
//     warning to console (see Phase-2 wrapper for collecting warnings)
//   • Heterogeneous unit scales (ACTUALS / THOUSANDS / MILLIONS / BILLIONS)
//     → every value normalised via `toActualDollars` BEFORE summing
//   • isActive === false rows skipped (DB soft-delete)
//   • Statements other than INCOME_STATEMENT skipped
//   • Missing revenue / net_income line items — month is included only
//     for the metrics where it has a finite value
//
// Smoke test (paste into a Node REPL with ts-node):
//   import { computeGroundTruth } from './groundTruth.js';
//   const stmts = [/* 36 monthly INCOME_STATEMENT rows … */];
//   const out = computeGroundTruth(stmts, { askingPriceUsd: 1_200_000 });
//   console.log(JSON.stringify(out, null, 2));

import {
  type ComputedGroundTruth,
  type ReconcilerContext,
  type ReconcilerStatementInput,
  REVENUE_KEYS,
  NET_INCOME_KEYS,
  getLineItemDollars,
  parsePeriodToYearMonth,
} from './shared.js';

// Three-letter month abbreviations used in partial-year keys
// ("2025_partial_JanJun"). Index 0 unused so MONTH_ABBR[1] === 'Jan'.
const MONTH_ABBR = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

interface MonthlyBucket {
  year: number;
  month: number;
  /** Sortable yyyymm key, e.g. 202603. */
  ord: number;
  /** "2026-03" canonical label. */
  iso: string;
  revenue: number | null;
  netIncome: number | null;
}

interface AnnualBucket {
  year: number;
  revenue: number | null;
  netIncome: number | null;
}

/**
 * Compute deterministic ground-truth aggregates over a deal's
 * INCOME_STATEMENT rows. See file header for full spec.
 */
export function computeGroundTruth(
  statements: ReconcilerStatementInput[],
  ctx?: ReconcilerContext,
): ComputedGroundTruth {
  // ─── 1. Filter to active income statements ─────────────────────
  const incomeRows = statements.filter(
    (s) =>
      s.statementType === 'INCOME_STATEMENT' && s.isActive !== false,
  );

  // ─── 2. Bucket each row into monthly or annual ─────────────────
  const monthly: MonthlyBucket[] = [];
  const annualByYear = new Map<number, AnnualBucket>();

  for (const row of incomeRows) {
    const parsed = parsePeriodToYearMonth(row.period);
    if (!parsed) continue;

    const revenue = getLineItemDollars(
      row.lineItems,
      REVENUE_KEYS,
      row.unitScale,
    );
    const netIncome = getLineItemDollars(
      row.lineItems,
      NET_INCOME_KEYS,
      row.unitScale,
    );

    if (parsed.month != null) {
      const ord = parsed.year * 100 + parsed.month;
      const iso = `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;
      monthly.push({
        year: parsed.year,
        month: parsed.month,
        ord,
        iso,
        revenue,
        netIncome,
      });
    } else {
      // Annual row. If we already have one for this year, keep the
      // first — duplicates are unusual but shouldn't double-count.
      if (!annualByYear.has(parsed.year)) {
        annualByYear.set(parsed.year, {
          year: parsed.year,
          revenue,
          netIncome,
        });
      }
    }
  }

  // Sort monthly chronologically — TTM and latest-month logic both
  // depend on this ordering.
  monthly.sort((a, b) => a.ord - b.ord);

  // ─── 3. Detect overlap between monthly and annual rows ─────────
  // When monthly aggregation is available for a year, we drop the
  // annual row for that year to avoid double-counting (e.g. a CIM
  // that includes both a monthly P&L AND an annual summary row).
  const yearsWithMonthly = new Set(monthly.map((m) => m.year));
  for (const year of yearsWithMonthly) {
    if (annualByYear.has(year)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reconciler.computeGroundTruth] Both monthly and annual rows ` +
          `present for ${year}; dropping annual to avoid double-counting.`,
      );
      annualByYear.delete(year);
    }
  }

  // ─── 4. Build annual aggregates from monthly + standalone annuals ─
  const annualGrossRevenue: Record<string, number> = {};
  const annualNetIncome: Record<string, number> = {};
  const annualNetMargin: Record<string, number> = {};

  // 4a. Monthly → grouped by year
  const byYear = new Map<number, MonthlyBucket[]>();
  for (const m of monthly) {
    const arr = byYear.get(m.year) ?? [];
    arr.push(m);
    byYear.set(m.year, arr);
  }

  for (const [year, months] of byYear.entries()) {
    const sortedMonths = months.slice().sort((a, b) => a.month - b.month);
    const monthCount = sortedMonths.length;
    const minMonth = sortedMonths[0]!.month;
    const maxMonth = sortedMonths[sortedMonths.length - 1]!.month;

    const yearKey =
      monthCount === 12
        ? `${year}_full`
        : `${year}_partial_${MONTH_ABBR[minMonth]}${MONTH_ABBR[maxMonth]}`;

    const sumRev = sumNullable(sortedMonths.map((m) => m.revenue));
    const sumNi = sumNullable(sortedMonths.map((m) => m.netIncome));

    if (sumRev != null) annualGrossRevenue[yearKey] = roundDollars(sumRev);
    if (sumNi != null) annualNetIncome[yearKey] = roundDollars(sumNi);
    if (sumRev != null && sumNi != null && sumRev !== 0) {
      annualNetMargin[yearKey] = roundFraction(sumNi / sumRev);
    }
  }

  // 4b. Annual rows that didn't have any monthly counterpart
  for (const a of annualByYear.values()) {
    const yearKey = `${a.year}_full`;
    if (a.revenue != null) {
      annualGrossRevenue[yearKey] = roundDollars(a.revenue);
    }
    if (a.netIncome != null) {
      annualNetIncome[yearKey] = roundDollars(a.netIncome);
    }
    if (a.revenue != null && a.netIncome != null && a.revenue !== 0) {
      annualNetMargin[yearKey] = roundFraction(a.netIncome / a.revenue);
    }
  }

  // ─── 5. Latest-month MRR + TTM aggregates (need monthly data) ──
  let latestMonthMRR: ComputedGroundTruth['latestMonthMRR'] = null;
  let TTM_revenue: number | null = null;
  let TTM_netIncome: number | null = null;
  let TTM_netMargin: number | null = null;
  let trailingThreeMonthAvgMRR: number | null = null;
  let impliedARR_3MoAvg: number | null = null;

  if (monthly.length > 0) {
    const latest = monthly[monthly.length - 1]!;
    if (latest.revenue != null && latest.netIncome != null) {
      const grossRevenue = latest.revenue;
      const netIncome = latest.netIncome;
      latestMonthMRR = {
        month: latest.iso,
        grossRevenue: roundDollars(grossRevenue),
        impliedAnnualizedRevenue: roundDollars(grossRevenue * 12),
        netIncome: roundDollars(netIncome),
        netMargin:
          grossRevenue !== 0 ? roundFraction(netIncome / grossRevenue) : 0,
      };
    } else if (latest.revenue != null) {
      // Revenue but no net income — still emit an MRR block but mark
      // netIncome/netMargin as 0 only when truly missing would be
      // misleading. We choose to leave latestMonthMRR null in that
      // case so downstream consumers don't infer a 0% margin.
      latestMonthMRR = null;
    }

    // TTM — sum of last 12 months. If fewer than 12 months exist we
    // still sum what's there (callers can detect via month count) but
    // anchor the label to the last available month.
    const ttmMonths = monthly.slice(-12);
    if (ttmMonths.length > 0) {
      const ttmRev = sumNullable(ttmMonths.map((m) => m.revenue));
      const ttmNi = sumNullable(ttmMonths.map((m) => m.netIncome));
      if (ttmRev != null) TTM_revenue = roundDollars(ttmRev);
      if (ttmNi != null) TTM_netIncome = roundDollars(ttmNi);
      if (ttmRev != null && ttmNi != null && ttmRev !== 0) {
        TTM_netMargin = roundFraction(ttmNi / ttmRev);
      }
    }

    // 3-month avg MRR (mean of last 3 months' revenue, ignoring nulls
    // only when revenue is missing; if any of last 3 missing, skip).
    const last3 = monthly.slice(-3);
    if (last3.length === 3 && last3.every((m) => m.revenue != null)) {
      const sum = last3.reduce((s, m) => s + (m.revenue as number), 0);
      const avg = sum / 3;
      trailingThreeMonthAvgMRR = roundDollars(avg);
      impliedARR_3MoAvg = roundDollars(avg * 12);
    }
  }

  // ─── 6. Valuation context (only when asking price provided) ────
  const out: ComputedGroundTruth = {
    annualGrossRevenue,
    annualNetIncome,
    annualNetMargin,
    latestMonthMRR,
    TTM_revenue,
    TTM_netIncome,
    TTM_netMargin,
    trailingThreeMonthAvgMRR,
    impliedARR_3MoAvg,
  };

  if (ctx?.askingPriceUsd != null && Number.isFinite(ctx.askingPriceUsd)) {
    const askingPrice = ctx.askingPriceUsd;
    out.valuationContextAtAskingPrice = {
      askingPrice,
      multipleOf_TTM_GrossRevenue:
        TTM_revenue != null && TTM_revenue !== 0
          ? roundMultiple(askingPrice / TTM_revenue)
          : null,
      multipleOf_TTM_NetIncome:
        TTM_netIncome != null && TTM_netIncome !== 0
          ? roundMultiple(askingPrice / TTM_netIncome)
          : null,
      multipleOf_3MoARR:
        impliedARR_3MoAvg != null && impliedARR_3MoAvg !== 0
          ? roundMultiple(askingPrice / impliedARR_3MoAvg)
          : null,
    };
  }

  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Sum an array of (number | null), returning null only if EVERY
 * entry is null. A single null among finite numbers is treated as 0
 * — common in real CIMs where a single missing month shouldn't void
 * the whole TTM. */
function sumNullable(values: Array<number | null>): number | null {
  let total = 0;
  let anyFinite = false;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      total += v;
      anyFinite = true;
    }
  }
  return anyFinite ? total : null;
}

/** Round to whole dollars — output is always integer dollars per spec. */
function roundDollars(n: number): number {
  return Math.round(n);
}

/** Round a margin/fraction to 3 decimals (e.g. 0.475). */
function roundFraction(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Round a valuation multiple to 2 decimals (e.g. 3.32x). */
function roundMultiple(n: number): number {
  return Math.round(n * 100) / 100;
}
