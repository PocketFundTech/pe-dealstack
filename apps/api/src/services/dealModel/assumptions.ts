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
import type { LineDriver } from '@ai-crm/shared';
import { buildLineCatalogue, type LineCatalogue } from './lineCatalogue.js';
import { seedLineDrivers, resolveLineDrivers } from './drivers.js';
import type { BalanceDrivers } from '@ai-crm/shared';
import { readBalanceItems, resolveBalanceDrivers, seedBalanceDrivers, type BalanceItems } from './balanceItems.js';

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
  /**
   * Every income-statement line on the statement (standard keys and
   * `<parent>_<label>` accounts), in millions. The flat fields below are
   * kept as a summary for callers and older fixtures; the model reads
   * `lines` (lineCatalogue.rowLines falls back to the flat fields).
   */
  lines?: Record<string, number>;
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
  /** Balance sheet + cash flow items for the same period (fix plan E3), in millions. */
  balance?: BalanceItems;
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
 *
 * Balance sheets and cash flows (fix plan E3) attach to the income
 * statement of the same canonical period as `balance`; one in another
 * currency, or for a period with no P&L, is left out rather than failing
 * the whole model.
 */
export function normaliseStatements(statements: StatementLike[]): NormalisedFinancials {
  const historical = statements.filter(
    (s) => s.isActive !== false && (s.periodType ?? 'HISTORICAL') !== 'PROJECTED',
  );
  const usable = historical.filter((s) => s.statementType === 'INCOME_STATEMENT');

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

      // Every line, scaled — ratios stay out (they aren't amounts).
      const lines: Record<string, number> = {};
      for (const [k, v] of Object.entries(li)) {
        const n = scaled(v);
        if (n !== undefined && !/(_pct|_ratio|_multiple)$/.test(k)) lines[k] = n;
      }
      row.lines = lines;

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
    if (base.lines && extra.lines) base.lines = { ...extra.lines, ...base.lines };
    byKey.set(r._key, base);
  }

  for (const s of historical) {
    if (s.statementType !== 'BALANCE_SHEET' && s.statementType !== 'CASH_FLOW') continue;
    if ((s.currency || 'USD').toUpperCase() !== currency) continue;
    const target = byKey.get(parsePeriod(s.period)?.canonicalKey ?? s.period);
    if (!target) continue;
    const factor = TO_MILLIONS[(s.unitScale as UnitScale) ?? 'MILLIONS'] ?? 1;
    const items = readBalanceItems(s.statementType, s.lineItems ?? {}, (v) => {
      const n = num(v);
      return n === undefined ? undefined : r3(n * factor);
    });
    // First statement for a period wins per item; a second only fills gaps.
    target.balance = { ...items, ...target.balance };
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

export const DRIVER_METHODS = ['PCT_REVENUE', 'GROWTH', 'FIXED', 'SUBTOTAL'] as const;
const lineDriverSchema = z.object({
  method: z.enum(DRIVER_METHODS),
  // Percent for GROWTH / PCT_REVENUE (bounded in the route), millions for FIXED.
  values: z.array(z.number().min(-1e7).max(1e7)).max(10),
});

const daysArray = z.array(z.number().min(0).max(730)).max(10);
const balanceDriversSchema = z.object({
  nwcMethod: z.enum(['DAYS', 'PCT_REVENUE']),
  dso: daysArray,
  dio: daysArray,
  dpo: daysArray,
  nwcPct: z.array(z.number().min(-100).max(100)).max(10),
  capexMethod: z.enum(['TOTAL', 'SPLIT']),
  capexPct: z.array(z.number().min(0).max(100)).max(10),
  capexMaintPct: z.array(z.number().min(0).max(100)).max(10),
  capexGrowthPct: z.array(z.number().min(0).max(100)).max(10),
});

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
  /** Per P&L line (fix plan E1) — see drivers.ts. Optional: rows saved before E1 have none. */
  lineDrivers: z.record(z.string(), lineDriverSchema).optional(),
  /** Pre-E1 fields, still accepted and migrated into lineDrivers on read. */
  revenueGrowthPct: pctArray.optional(),
  ebitdaMarginPct: pctArray.optional(),
  daPctRevenue: z.number().min(0).max(100).optional(),
  /** Working capital + capex per projected year (fix plan E3) — see balanceItems.ts. */
  balanceDrivers: balanceDriversSchema.optional(),
  /** Pre-E3 scalars, still accepted and migrated into balanceDrivers on read. */
  capexPctRevenue: z.number().min(0).max(100).optional(),
  nwcPctRevenue: z.number().min(-100).max(100).optional(),
  /** Optional second debt tranche (same quantum mode as the senior) and minimum cash. */
  debt2Quantum: z.number().min(0).optional(),
  debt2InterestRate: z.number().min(0).max(50).optional(),
  debt2AmortPct: z.number().min(0).max(100).optional(),
  minCash: z.number().min(0).max(1e7).optional(),
  taxRate: z.number().min(0).max(60),
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

type LegacyKeys = 'revenueGrowthPct' | 'ebitdaMarginPct' | 'daPctRevenue' | 'capexPctRevenue' | 'nwcPctRevenue';
type CompletedKeys = 'lineDrivers' | 'balanceDrivers' | 'debt2Quantum' | 'debt2InterestRate' | 'debt2AmortPct' | 'minCash';

/** Assumptions with a driver for every line of the deal's catalogue, and every E3 field filled. */
export type ResolvedAssumptions = Omit<ModelAssumptions, LegacyKeys | CompletedKeys> & {
  lineDrivers: Record<string, LineDriver>;
  balanceDrivers: BalanceDrivers;
  debt2Quantum: number;
  debt2InterestRate: number;
  debt2AmortPct: number;
  minCash: number;
};

export interface DealSeed {
  evMultiple?: number | null;
  currency?: string | null;
}

/**
 * Starting assumptions derived from history.
 *
 * Conservative by construction: every line is held at its historical
 * full-year average (revenue at the trailing CAGR, clamped to a believable
 * band), and the exit multiple equals the entry multiple — assuming
 * multiple expansion by default would flatter every return the model
 * produces.
 */
export function deriveDefaults(
  history: HistoricalRow[],
  deal: DealSeed = {},
  catalogue: LineCatalogue = buildLineCatalogue(history),
): ResolvedAssumptions {
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
    // No second tranche unless the user adds one; its rate is a starting point.
    debt2Quantum: 0,
    debt2InterestRate: 12,
    debt2AmortPct: 0,
    cashSweepPct: 50,
    minCash: 0,

    projectionYears,
    lineDrivers: seedLineDrivers(history, catalogue, projectionYears),
    balanceDrivers: seedBalanceDrivers(history, catalogue, projectionYears),
    taxRate: 25,

    // Same as entry: no assumed multiple expansion.
    exitMultiple: entryMultiple,
    exitYear: projectionYears,
    wacc: 12,
    dscrTarget: 1.25,

    unitScale: 'MILLIONS',
    currency: (deal.currency || 'USD').toUpperCase(),
  };
}

/**
 * Saved (possibly partial, possibly pre-E1) assumptions → a complete set
 * with a driver for every catalogue line. Saved values win; anything missing
 * comes from the derived defaults; legacy growth / margin are migrated.
 */
export function resolveAssumptions(
  saved: Partial<ModelAssumptions> | null | undefined,
  history: HistoricalRow[],
  deal: DealSeed = {},
  catalogue: LineCatalogue = buildLineCatalogue(history),
): ResolvedAssumptions {
  const defaults = deriveDefaults(history, deal, catalogue);
  if (!saved) return defaults;
  const {
    lineDrivers, revenueGrowthPct, ebitdaMarginPct, daPctRevenue,
    balanceDrivers, capexPctRevenue, nwcPctRevenue, ...rest
  } = saved;
  const merged = { ...defaults, ...rest } as ResolvedAssumptions;
  const years = merged.projectionYears;
  const sameYears = years === defaults.projectionYears;
  const seeded = sameYears ? defaults.lineDrivers : seedLineDrivers(history, catalogue, years);
  merged.lineDrivers = resolveLineDrivers(
    lineDrivers, { revenueGrowthPct, ebitdaMarginPct, daPctRevenue }, catalogue.lines, seeded, years,
  );
  merged.balanceDrivers = resolveBalanceDrivers(
    balanceDrivers, { nwcPctRevenue, capexPctRevenue },
    sameYears ? defaults.balanceDrivers : seedBalanceDrivers(history, catalogue, years), years,
  );
  merged.exitYear = Math.min(merged.exitYear, years);
  return merged;
}
