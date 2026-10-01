// ─── Deal model — Low / Base / High cases (fix plan E2) ───────────
// "There is no high/base/low scenario; even basic models should have quick
// scenario analysis" (analyst feedback, SRM deal).
//
// Each case is a full assumption set stored as its own DealModel row
// (name + UNIQUE("dealId", name) already exist — no migration). When Low
// or High has never been saved it is seeded from Base with these deltas;
// once seeded every number is an ordinary editable input (panel tabs, and
// blue Low / High columns in the workbook):
//
//   revenue growth   ±3pp on every revenue line driven by Growth %
//   EBITDA margin    ±2pp, taken out of (Low: added to) the % of revenue
//                    cost lines in proportion to their size — Fixed cost
//                    lines are left alone
//   exit multiple    ±1.0x (never below 0.5x)
//
// Working capital, capex and debt drivers (fix plan E3) start EQUAL to Base
// in Low and High: no delta is obvious enough to impose (a weaker year
// doesn't reliably mean longer receivable days or less capex). They are
// ordinary Low / High inputs once seeded.
//
// Structural choices — projection years, entry basis, debt mode, currency,
// and the working-capital / capex methods (days vs % of revenue, total vs
// maintenance + growth) — are the Base case's in every case, so the
// workbook has one layout.

import { MODEL_CASES, type LineDriver, type ModelCase, type ModelLine } from '@ai-crm/shared';
import type { HistoricalRow, ModelAssumptions, ResolvedAssumptions } from './assumptions.js';
import { resolveAssumptions, type DealSeed } from './assumptions.js';
import type { LineCatalogue } from './lineCatalogue.js';

export { MODEL_CASES, type ModelCase };

/** DealModel.name per case. "Base case" is the name rows were saved under before E2. */
export const CASE_ROW_NAMES: Record<ModelCase, string> = {
  Low: 'Low case',
  Base: 'Base case',
  High: 'High case',
};

export const SCENARIO_DELTAS: Record<Exclude<ModelCase, 'Base'>, { revenueGrowthPp: number; ebitdaMarginPp: number; exitMultipleX: number }> = {
  Low: { revenueGrowthPp: -3, ebitdaMarginPp: -2, exitMultipleX: -1 },
  High: { revenueGrowthPp: 3, ebitdaMarginPp: 2, exitMultipleX: 1 },
};

const MIN_EXIT_MULTIPLE = 0.5;
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** "low" / "Low" / "Low case" → 'Low'; undefined → 'Base'; anything else → null. */
export function parseCase(raw: unknown): ModelCase | null {
  if (raw === undefined || raw === null || raw === '') return 'Base';
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/\s*case$/, '');
  return MODEL_CASES.find((c) => c.toLowerCase() === key) ?? null;
}

/** Low / High from Base, with the documented deltas. */
export function seedScenario(base: ResolvedAssumptions, lines: ModelLine[], which: Exclude<ModelCase, 'Base'>): ResolvedAssumptions {
  const d = SCENARIO_DELTAS[which];
  const drivers: Record<string, LineDriver> = {};
  for (const [k, v] of Object.entries(base.lineDrivers)) drivers[k] = { method: v.method, values: [...v.values] };

  const inputs = lines.filter((l) => l.kind === 'INPUT' && !l.historicalOnly);
  for (const l of inputs.filter((x) => x.revenueLine && drivers[x.key]?.method === 'GROWTH')) {
    drivers[l.key].values = drivers[l.key].values.map((v) => round(v + d.revenueGrowthPp, 2));
  }

  const costs = inputs.filter((l) => l.costLine && drivers[l.key]?.method === 'PCT_REVENUE');
  for (let y = 0; y < base.projectionYears; y++) {
    const total = costs.reduce((t, l) => t + (drivers[l.key].values[y] ?? 0), 0);
    if (total <= 0) continue;
    const factor = Math.max(0, (total - d.ebitdaMarginPp) / total);
    for (const l of costs) drivers[l.key].values[y] = round((drivers[l.key].values[y] ?? 0) * factor, 4);
  }

  const bd = base.balanceDrivers;
  return {
    ...base,
    balanceDrivers: Object.fromEntries(Object.entries(bd).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) as typeof bd,
    lineDrivers: drivers,
    exitMultiple: Math.max(MIN_EXIT_MULTIPLE, round(base.exitMultiple + d.exitMultipleX, 2)),
  };
}

/** Saved Low / High forced onto the Base case's structure (one workbook layout). */
export function alignToBase(
  saved: Partial<ModelAssumptions>,
  base: ResolvedAssumptions,
  history: HistoricalRow[],
  deal: DealSeed,
  catalogue: LineCatalogue,
): ResolvedAssumptions {
  const resolved = resolveAssumptions({
    ...saved,
    projectionYears: base.projectionYears,
    entryBasis: base.entryBasis,
    debtQuantumMode: base.debtQuantumMode,
    unitScale: base.unitScale,
    currency: base.currency,
  }, history, deal, catalogue);
  // Every series is always filled, so switching method keeps the case's own figures.
  resolved.balanceDrivers = {
    ...resolved.balanceDrivers,
    nwcMethod: base.balanceDrivers.nwcMethod,
    capexMethod: base.balanceDrivers.capexMethod,
  };
  return resolved;
}

export type CaseSet = Record<ModelCase, ResolvedAssumptions>;

/** All three cases: saved rows where they exist, Base derived, Low / High seeded from Base. */
export function resolveCases(
  saved: Partial<Record<ModelCase, Partial<ModelAssumptions> | null>>,
  history: HistoricalRow[],
  deal: DealSeed,
  catalogue: LineCatalogue,
): CaseSet {
  const base = resolveAssumptions(saved.Base ?? null, history, deal, catalogue);
  const side = (c: 'Low' | 'High') => {
    const row = saved[c];
    return row ? alignToBase(row, base, history, deal, catalogue) : seedScenario(base, catalogue.lines, c);
  };
  return { Low: side('Low'), Base: base, High: side('High') };
}
