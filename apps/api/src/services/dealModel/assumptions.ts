// ─── Deal model — inputs ──────────────────────────────────────────
// Normalises extracted financials onto one basis, and derives a sensible
// starting set of assumptions from them.
//
// UNITS ARE THE TRAP HERE. AGENTS.md says values are stored in millions,
// but FinancialStatement carries a `unitScale` column and a billions
// migration shipped. A workbook built from a mixed-scale set looks
// completely plausible and is wrong by 1000x, which is worse than
// producing nothing. Everything is rescaled to MILLIONS before it reaches
// the workbook, and mixed currencies are refused outright rather than
// silently summed.
//
// Derivation is deliberately deterministic — no LLM. These are starting
// points the user edits, and a number that moves between runs would
// destroy trust in the model faster than a wrong one.

import { z } from 'zod';
import { parsePeriod, comparePeriods, type PeriodKind } from '@ai-crm/shared';
import { comparePeriodChronologically } from '../../utils/periodChrono.js';
import { computeDerivedFields } from '../financialDerivations.js';
import { selectBasePeriod, isFullYearRow, withPeriodMeta } from './basePeriod.js';

export class UnitMismatchError extends Error {
  code = 'UNIT_MISMATCH';
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UnitMismatchError';
  }
}

export type UnitScale = 'MILLIONS' | 'THOUSANDS' | 'ACTUALS';

/** Factor that converts a value at `scale` into millions. */
const TO_MILLIONS: Record<UnitScale, number> = {
  MILLIONS: 1,
  THOUSANDS: 1 / 1_000,
  ACTUALS: 1 / 1_000_000,
};

export interface HistoricalRow {
  period: string;
  revenue?: number;
  cogs?: number;
  grossProfit?: number;
  opex?: number;
  ebitda?: number;
  netIncome?: number;
  da?: number;
  sourcePeriodType?: string;
  /** Canonical period (packages/shared parsePeriod) — drives base-period selection. */
  kind?: PeriodKind | 'LTM';
  months?: number | null;
  fiscalYear?: number;
  endMonth?: number;
  /** EBITDA wasn't printed; derived from EBIT + D&A etc. (financialDerivations.ts). */
  ebitdaDerived?: boolean;
}

interface StatementLike {
  statementType: string;
  period: string;
  periodType?: string;
  currency?: string;
  unitScale?: string;
  isActive?: boolean;
  lineItems: Record<string, unknown> | null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Round to 3dp — enough for millions, avoids float dust in the workbook. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface NormalisedFinancials {
  rows: HistoricalRow[];
  unitScale: 'MILLIONS';
  currency: string;
}

/**
 * Project active income statements onto one scale and currency.
 *
 * Only HISTORICAL and LTM rows survive: feeding a PROJECTED row in as
 * history would compound our forecast on top of the seller's.
 */
export function normaliseStatements(statements: StatementLike[]): NormalisedFinancials {
  const usable = statements.filter(
    (s) =>
      s.statementType === 'INCOME_STATEMENT' &&
      s.isActive !== false &&
      (s.periodType ?? 'HISTORICAL') !== 'PROJECTED',
  );

  const currencies = new Set(usable.map((s) => (s.currency || 'USD').toUpperCase()));
  if (currencies.size > 1) {
    throw new UnitMismatchError(
      `This deal has financials in more than one currency (${[...currencies].join(', ')}). ` +
        'Reconcile them before building a model.',
    );
  }
  const currency = [...currencies][0] ?? 'USD';

  const mapped: Array<HistoricalRow & { _key: string; _count: number }> = usable
    .map((s) => {
      const scale = (s.unitScale as UnitScale) ?? 'MILLIONS';
      const factor = TO_MILLIONS[scale] ?? 1;
      // Fill EBITDA / EBIT / GP the statement doesn't print, with the same
      // rules as extraction — rows stored before that fix have no EBITDA.
      const li: Record<string, unknown> = { ...(s.lineItems ?? {}) };
      const hadEbitda = num(li.ebitda) !== undefined;
      if (num(li.da) === undefined && num(li.depreciation_amortization) !== undefined) li.da = li.depreciation_amortization;
      computeDerivedFields(li as Record<string, number | string | null | undefined>);

      const scaled = (v: unknown): number | undefined => {
        const n = num(v);
        return n === undefined ? undefined : r3(n * factor);
      };

      const revenue = scaled(li.revenue);
      const cogs = scaled(li.cogs);
      let grossProfit = scaled(li.gross_profit) ?? scaled(li.grossProfit);
      if (grossProfit === undefined && revenue !== undefined && cogs !== undefined) {
        grossProfit = r3(revenue - cogs);
      }

      const parsed = parsePeriod(s.period);
      const row: HistoricalRow & { _key: string; _count: number } = {
        period: s.period,
        sourcePeriodType: s.periodType ?? 'HISTORICAL',
        _key: parsed?.canonicalKey ?? s.period,
        _count: 0,
      };
      if (parsed) {
        row.kind = s.periodType === 'LTM' ? 'LTM' : parsed.kind;
        row.months = parsed.months;
        row.fiscalYear = parsed.fiscalYear;
        row.endMonth = Number(parsed.endDate.slice(5, 7));
      }
      if (revenue !== undefined) row.revenue = revenue;
      if (cogs !== undefined) row.cogs = cogs;
      if (grossProfit !== undefined) row.grossProfit = grossProfit;

      const opex = scaled(li.total_opex) ?? scaled(li.opex) ?? scaled(li.operating_expenses);
      if (opex !== undefined) row.opex = opex;

      const ebitda = scaled(li.ebitda);
      if (ebitda !== undefined) {
        row.ebitda = ebitda;
        if (!hadEbitda) row.ebitdaDerived = true;
      }

      const netIncome = scaled(li.net_income) ?? scaled(li.netIncome);
      if (netIncome !== undefined) row.netIncome = netIncome;

      const da = scaled(li.depreciation_amortization) ?? scaled(li.d_and_a) ?? scaled(li.da);
      if (da !== undefined) row.da = da;

      row._count = Object.values(li).filter((v) => typeof v === 'number').length;
      return row;
    });

  // One column per canonical period: "FY2024 (Jan - Dec 2024)" from the P&L
  // and "2024" from a valuation summary are the same year. The richer row
  // keeps its label and values; the other only fills gaps.
  const byKey = new Map<string, HistoricalRow & { _key: string; _count: number }>();
  for (const r of mapped) {
    const existing = byKey.get(r._key);
    if (!existing) { byKey.set(r._key, r); continue; }
    const [base, extra] = existing._count >= r._count ? [existing, r] : [r, existing];
    const target = base as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (target[k] === undefined && v !== undefined) target[k] = v;
    }
    byKey.set(r._key, base);
  }

  const rows: HistoricalRow[] = [...byKey.values()]
    .map(({ _key: _k, _count: _c, ...row }) => row)
    .sort((a, b) => {
      const pa = parsePeriod(a.period);
      const pb = parsePeriod(b.period);
      return pa && pb ? comparePeriods(pa, pb) : comparePeriodChronologically(a.period, b.period);
    });

  return { rows, unitScale: 'MILLIONS', currency };
}

// ============================================================
// Assumptions
// ============================================================

const pctArray = z.array(z.number().min(-100).max(500));

export const assumptionsSchema = z.object({
  // Entry
  entryMultiple: z.number().positive().max(100),
  entryBasis: z.enum(['EBITDA', 'REVENUE']),
  transactionFeesPct: z.number().min(0).max(25),
  // Capital structure
  debtQuantumMode: z.enum(['MULTIPLE', 'ABSOLUTE']),
  debtQuantum: z.number().min(0),
  interestRate: z.number().min(0).max(50),
  amortPctPerYear: z.number().min(0).max(100),
  cashSweepPct: z.number().min(0).max(100),
  // Operating
  projectionYears: z.number().int().min(1).max(10),
  revenueGrowthPct: pctArray,
  ebitdaMarginPct: pctArray,
  capexPctRevenue: z.number().min(0).max(100),
  nwcPctRevenue: z.number().min(-100).max(100),
  taxRate: z.number().min(0).max(60),
  daPctRevenue: z.number().min(0).max(100),
  // Exit & discounting
  exitMultiple: z.number().positive().max(100),
  exitYear: z.number().int().min(1).max(10),
  wacc: z.number().min(0).max(50),
  dscrTarget: z.number().min(0).max(10),
  // Presentation
  unitScale: z.enum(['MILLIONS', 'THOUSANDS']),
  currency: z.string().min(1).max(8),
});

export type ModelAssumptions = z.infer<typeof assumptionsSchema>;

const DEFAULT_PROJECTION_YEARS = 5;
/** Growth bounds. Extrapolating one explosive year produces a fantasy. */
const MAX_SEEDED_GROWTH = 30;
const MIN_SEEDED_GROWTH = -15;

function cagrPct(first: number, last: number, years: number): number | null {
  if (first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

export interface DealSeed {
  evMultiple?: number | null;
  currency?: string | null;
}

/**
 * Starting assumptions derived from history.
 *
 * Conservative by construction: growth is the trailing CAGR clamped to a
 * believable band, margin is held flat at the latest actual, and the exit
 * multiple equals the entry multiple — assuming multiple expansion by
 * default would flatter every return the model produces.
 */
export function deriveDefaults(
  history: HistoricalRow[],
  deal: DealSeed = {},
): ModelAssumptions {
  const withRevenue = history.filter((r) => typeof r.revenue === 'number' && r.revenue! > 0);
  // Growth from full fiscal years over the real span of years — a 9-month
  // YTD is not a year, and 2021 → 2024 is 3 years even with 2022 missing.
  const fullYears = withRevenue.map(withPeriodMeta).filter(isFullYearRow);
  // Labels the parser can't date ("Year 1") keep the old row-count behaviour.
  const hasMeta = fullYears.length > 0;
  const years = hasMeta ? fullYears : withRevenue;
  const latest = years.at(-1);
  const earliest = years[0];

  let growth = 5;
  if (latest && earliest && years.length > 1) {
    const span = hasMeta ? (latest.fiscalYear ?? 0) - (earliest.fiscalYear ?? 0) : years.length - 1;
    const derived = cagrPct(earliest.revenue!, latest.revenue!, span);
    if (derived !== null) {
      growth = Math.max(MIN_SEEDED_GROWTH, Math.min(MAX_SEEDED_GROWTH, derived));
    }
  }

  // Margin from the base period (LTM or last full year), never a YTD.
  const base = selectBasePeriod(history)?.row;
  let margin = 15;
  if (base?.revenue && typeof base.ebitda === 'number' && base.revenue !== 0) {
    const derived = (base.ebitda / base.revenue) * 100;
    if (Number.isFinite(derived)) margin = Math.max(-50, Math.min(80, derived));
  }

  const projectionYears = DEFAULT_PROJECTION_YEARS;
  const entryMultiple = deal.evMultiple && deal.evMultiple > 0 ? deal.evMultiple : 5;

  return {
    entryMultiple,
    entryBasis: 'EBITDA',
    transactionFeesPct: 2,

    debtQuantumMode: 'MULTIPLE',
    debtQuantum: 2.5,
    interestRate: 10,
    amortPctPerYear: 5,
    cashSweepPct: 50,

    projectionYears,
    revenueGrowthPct: Array.from({ length: projectionYears }, () => Math.round(growth * 10) / 10),
    ebitdaMarginPct: Array.from({ length: projectionYears }, () => Math.round(margin * 10) / 10),
    capexPctRevenue: 3,
    nwcPctRevenue: 10,
    taxRate: 25,
    daPctRevenue: 3,

    // Same as entry: no assumed multiple expansion.
    exitMultiple: entryMultiple,
    exitYear: projectionYears,
    wacc: 12,
    dscrTarget: 1.25,

    unitScale: 'MILLIONS',
    currency: (deal.currency || 'USD').toUpperCase(),
  };
}
