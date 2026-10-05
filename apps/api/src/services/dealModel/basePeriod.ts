// ─── Deal model — base / entry period ─────────────────────────────
// The projections grow from one "base" column and the entry EBITDA is read
// from it. That used to be simply the last historical column, which on the
// SRM deal was "2025 YTD (Jan - Sep 2025)": 9 months with no EBITDA, so
// entry EBITDA, EV, debt and equity were all 0 and IRR came out "n/a" —
// and a 9-month revenue was grown as if it were a full year.
//
// Rule (fix plan D1): LTM = FY(n-1) + YTD(n) - YTD(n-1) when a prior-year
// YTD with the same months exists; otherwise the last full fiscal year.
// A YTD is shown in Historicals for information only, never used as a year.

import { parsePeriod } from '@ai-crm/shared';
import type { HistoricalRow } from './assumptions.js';

export type BaseBasis = 'LTM' | 'FY' | 'LATEST';

export interface BasePeriod {
  /** Header for the base column, e.g. "LTM Sep 2025" or "FY2024 (Jan - Dec 2024) A". */
  label: string;
  basis: BaseBasis;
  row: HistoricalRow;
  /** Explanation written to the Notes sheet. */
  note: string;
}

const METRICS = ['revenue', 'cogs', 'grossProfit', 'opex', 'ebitda', 'netIncome', 'da'] as const;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function r3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Fill period metadata from the label for rows built without it. */
export function withPeriodMeta(r: HistoricalRow): HistoricalRow {
  if (r.kind !== undefined) return r;
  const p = parsePeriod(r.period);
  if (!p) return r;
  return { ...r, kind: p.kind, months: p.months, fiscalYear: p.fiscalYear, endMonth: Number(p.endDate.slice(5, 7)) };
}

export function isFullYearRow(r: HistoricalRow): boolean {
  const m = withPeriodMeta(r);
  return m.kind === 'FY' && m.months === 12;
}

/** "2024" → "2024A"; "FY2024 (Jan - Dec 2024)" → "FY2024 (Jan - Dec 2024) A". */
function actualLabel(period: string): string {
  return /[)\s]$/.test(period) || period.length > 8 ? `${period} A` : `${period}A`;
}

export function selectBasePeriod(input: HistoricalRow[]): BasePeriod | null {
  if (input.length === 0) return null;
  const history = input.map(withPeriodMeta);
  const fullYears = history.filter(isFullYearRow);
  const lastFy = fullYears.at(-1);

  const ytds = history.filter((r) => r.kind === 'YTD' && r.months != null);
  const latestYtd = ytds.at(-1);
  if (latestYtd && lastFy && latestYtd.fiscalYear === (lastFy.fiscalYear ?? 0) + 1) {
    const priorYtd = ytds.find(
      (r) => r.fiscalYear === latestYtd.fiscalYear! - 1 && r.months === latestYtd.months,
    );
    if (priorYtd) {
      const row: HistoricalRow = { period: '', kind: 'LTM', months: 12, fiscalYear: latestYtd.fiscalYear };
      for (const m of METRICS) {
        const a = lastFy[m];
        const b = latestYtd[m];
        const c = priorYtd[m];
        if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number') row[m] = r3(a + b - c);
      }
      // Every P&L line (E1), not just the summary metrics.
      if (lastFy.lines && latestYtd.lines && priorYtd.lines) {
        row.lines = {};
        for (const [k, a] of Object.entries(lastFy.lines)) {
          const b = latestYtd.lines[k];
          const c = priorYtd.lines[k];
          if (typeof b === 'number' && typeof c === 'number') row.lines[k] = r3(a + b - c);
        }
      }
      if (row.ebitda !== undefined && (lastFy.ebitdaDerived || latestYtd.ebitdaDerived || priorYtd.ebitdaDerived)) {
        row.ebitdaDerived = true;
      }
      const endMonth = latestYtd.endMonth ?? latestYtd.months!;
      row.period = `LTM ${MONTH_ABBR[endMonth - 1]} ${latestYtd.fiscalYear}`;
      return {
        label: row.period,
        basis: 'LTM',
        row,
        note: `Base / entry period is ${row.period} = ${lastFy.period} + ${latestYtd.period} − ${priorYtd.period}.`,
      };
    }
  }

  if (lastFy) {
    const skipped = history.filter((r) => r !== lastFy && history.indexOf(r) > history.indexOf(lastFy));
    const partial = skipped.length
      ? ` Later partial periods (${skipped.map((r) => r.period).join(', ')}) are shown in Historicals for information only — no prior-year comparable was available to build an LTM.`
      : '';
    return {
      label: actualLabel(lastFy.period),
      basis: 'FY',
      row: input[history.indexOf(lastFy)],
      note: `Base / entry period is the last full fiscal year, ${lastFy.period}.${partial}`,
    };
  }

  const latest = history.at(-1)!;
  return {
    label: actualLabel(latest.period),
    basis: 'LATEST',
    row: input[input.length - 1],
    note: `No full fiscal year was found — the base period is ${latest.period}, which may not cover 12 months. Check the entry values.`,
  };
}
