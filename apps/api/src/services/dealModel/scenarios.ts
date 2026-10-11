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
//                    cost lines in proportion to their size; any remainder
//                    through the Fixed cost lines as money (fix plan G11)
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

import { MODEL_CASES, projectModel, type CaseSummary, type LineDriver, type ModelCase, type ModelLine } from '@ai-crm/shared';
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
export function seedScenario(
  base: ResolvedAssumptions, lines: ModelLine[], which: Exclude<ModelCase, 'Base'>, baseValues?: Record<string, number>,
): ResolvedAssumptions {
  return seedScenarioDetailed(base, lines, which, baseValues).assumptions;
}

/**
 * seedScenario, plus how much of the EBITDA-margin delta (pp, per projected
 * year) couldn't be applied. The delta goes through the % of revenue cost
 * lines first; any remainder through the Fixed cost lines as money
 * (projected revenue × pp) when `baseValues` is given (fix plan G11 — with
 * Fixed costs the ±2pp used to be skipped silently, so the three cases
 * showed different headers and the same EBITDA).
 */
export function seedScenarioDetailed(
  base: ResolvedAssumptions, lines: ModelLine[], which: Exclude<ModelCase, 'Base'>, baseValues?: Record<string, number>,
): { assumptions: ResolvedAssumptions; unappliedPp: number[] } {
  const d = SCENARIO_DELTAS[which];
  const drivers: Record<string, LineDriver> = {};
  for (const [k, v] of Object.entries(base.lineDrivers)) drivers[k] = { method: v.method, values: [...v.values] };

  const inputs = lines.filter((l) => l.kind === 'INPUT' && !l.historicalOnly);
  for (const l of inputs.filter((x) => x.revenueLine && drivers[x.key]?.method === 'GROWTH')) {
    drivers[l.key].values = drivers[l.key].values.map((v) => round(v + d.revenueGrowthPp, 2));
  }

  // Margin up (High) = costs down by d.ebitdaMarginPp of revenue.
  const wanted = Math.abs(d.ebitdaMarginPp);
  const cutting = d.ebitdaMarginPp > 0;
  const unappliedPp = Array.from({ length: base.projectionYears }, () => wanted);

  const pctCosts = inputs.filter((l) => l.costLine && drivers[l.key]?.method === 'PCT_REVENUE');
  for (let y = 0; y < base.projectionYears; y++) {
    const total = pctCosts.reduce((t, l) => t + (drivers[l.key].values[y] ?? 0), 0);
    if (total <= 0) continue;
    const applied = cutting ? Math.min(total, wanted) : wanted;
    const factor = (total + (cutting ? -applied : applied)) / total;
    for (const l of pctCosts) drivers[l.key].values[y] = round((drivers[l.key].values[y] ?? 0) * factor, 4);
    unappliedPp[y] -= applied;
  }

  const fixedCosts = inputs.filter((l) => l.costLine && drivers[l.key]?.method === 'FIXED');
  if (baseValues && fixedCosts.length && unappliedPp.some((u) => u > 1e-9)) {
    const revenue = projectModel(lines, baseValues, { ...base, lineDrivers: drivers }).revenue;
    for (let y = 0; y < base.projectionYears; y++) {
      const rev = revenue[y] ?? 0;
      const total = fixedCosts.reduce((t, l) => t + (drivers[l.key].values[y] ?? 0), 0);
      if (unappliedPp[y] <= 1e-9 || rev <= 0 || total <= 0) continue;
      const wantMoney = (rev * unappliedPp[y]) / 100;
      const money = cutting ? Math.min(total, wantMoney) : wantMoney;
      const factor = (total + (cutting ? -money : money)) / total;
      for (const l of fixedCosts) drivers[l.key].values[y] = round((drivers[l.key].values[y] ?? 0) * factor, 4);
      unappliedPp[y] -= (money / rev) * 100;
    }
  }

  const bd = base.balanceDrivers;
  return {
    assumptions: {
      ...base,
      balanceDrivers: Object.fromEntries(Object.entries(bd).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) as typeof bd,
      lineDrivers: drivers,
      exitMultiple: Math.max(MIN_EXIT_MULTIPLE, round(base.exitMultiple + d.exitMultipleX, 2)),
    },
    unappliedPp: unappliedPp.map((u) => Math.max(0, round(u, 4))),
  };
}

/**
 * Plain-language notes for seeded (never saved) Low / High cases whose
 * EBITDA-margin delta couldn't be applied in full — shown on the Build model
 * panel and the workbook's Notes sheet.
 */
export function scenarioSeedNotes(
  saved: Partial<Record<ModelCase, unknown>>, base: ResolvedAssumptions, lines: ModelLine[], baseValues: Record<string, number>,
): string[] {
  const notes: string[] = [];
  for (const which of ['Low', 'High'] as const) {
    if (saved[which]) continue;
    const { unappliedPp } = seedScenarioDetailed(base, lines, which, baseValues);
    const worst = Math.max(0, ...unappliedPp);
    if (worst < 0.05) continue;
    const pp = SCENARIO_DELTAS[which].ebitdaMarginPp;
    notes.push(
      `${which} case: the ${pp > 0 ? '+' : ''}${pp}pp EBITDA margin change could not be applied in full ` +
      `(up to ${worst.toFixed(1)}pp short) because the cost lines are too small to ${pp > 0 ? 'cut' : 'change'} that much. ` +
      `Edit the ${which} case's cost drivers to set the margin you want, then save it.`,
    );
  }
  return notes;
}

// Above these, a buyout's returns are almost always a data error (most often
// a thousands-vs-millions unit mismatch in the extracted history), not a deal.
const IMPLAUSIBLE_IRR = 1; // 100%
const IMPLAUSIBLE_MOM = 20;

/** A panel / workbook warning when the case's returns are too high to be real. */
export function implausibleReturnsNote(summary: Pick<CaseSummary, 'irr' | 'mom'>): string | null {
  const { irr, mom } = summary;
  const irrBad = irr !== null && irr > IMPLAUSIBLE_IRR;
  const momBad = mom !== null && mom > IMPLAUSIBLE_MOM;
  if (!irrBad && !momBad) return null;
  const figures = [
    irr !== null ? `${Math.round(irr * 100).toLocaleString('en-US')}% IRR` : null,
    mom !== null ? `${Math.round(mom).toLocaleString('en-US')}x MoM` : null,
  ].filter(Boolean).join(' and ');
  return (
    `These returns (${figures}) are not realistic for a buyout — check the source financials before relying on them. ` +
    `The usual cause is a unit mismatch (figures in thousands read as millions, or the reverse) in one or more historical periods; ` +
    `see the Validation Flags on the Financial Statements panel.`
  );
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
  /** Base-column values: lets the margin delta reach Fixed cost lines (G11). */
  baseValues?: Record<string, number>,
): CaseSet {
  const base = resolveAssumptions(saved.Base ?? null, history, deal, catalogue);
  const side = (c: 'Low' | 'High') => {
    const row = saved[c];
    return row ? alignToBase(row, base, history, deal, catalogue) : seedScenario(base, catalogue.lines, c, baseValues);
  };
  return { Low: side('Low'), Base: base, High: side('High') };
}
