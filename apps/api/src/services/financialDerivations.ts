/**
 * Derived income-statement fields, shared by both extraction engines.
 *
 * Previously this lived inside financialClassifier.ts and only ran on the
 * legacy engine, so on the live Claude path a P&L with no printed EBITDA line
 * (QuickBooks-style statements) stored no EBITDA at all — blank EBITDA and
 * margin in the table, and 0 entry EBITDA / EV / IRR "n/a" in the model.
 *
 * Only fills fields that are missing; never overwrites a reported value.
 * Each derived EBITDA is tagged `ebitda_source: "derived: <formula>"` so the
 * UI can mark it and source-match scoring can skip it (it's not a quote).
 * Assumes costs are positive (the extraction sign convention).
 */

export const DERIVED_SOURCE_PREFIX = 'derived:';

/** True for a `<key>_source` value written by this module rather than quoted from the document. */
export function isDerivedSource(sourceValue: unknown): boolean {
  return typeof sourceValue === 'string' && sourceValue.startsWith(DERIVED_SOURCE_PREFIX);
}

type Items = Record<string, number | string | null | undefined>;

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function computeDerivedFields(li: Items): void {
  const v = (k: string): number | null => (typeof li[k] === 'number' ? (li[k] as number) : null);
  const setDerived = (key: string, value: number, formula: string) => {
    li[key] = r4(value);
    li[`${key}_source`] = `${DERIVED_SOURCE_PREFIX} ${formula}`;
  };

  // gross_profit = revenue - cogs
  if (v('gross_profit') === null && v('revenue') !== null && v('cogs') !== null) {
    setDerived('gross_profit', v('revenue')! - v('cogs')!, 'revenue - cogs');
  }

  // ebitda, in order of reliability
  if (v('ebitda') === null) {
    if (v('ebit') !== null && v('da') !== null) {
      setDerived('ebitda', v('ebit')! + v('da')!, 'ebit + da');
    } else if (v('revenue') !== null && v('cogs') !== null && v('total_opex') !== null) {
      setDerived('ebitda', v('revenue')! - v('cogs')! - v('total_opex')!, 'revenue - cogs - total_opex');
    } else if (v('gross_profit') !== null && v('total_opex') !== null) {
      setDerived('ebitda', v('gross_profit')! - v('total_opex')!, 'gross_profit - total_opex');
    } else if (v('net_income') !== null && v('da') !== null
      && (v('interest_expense') !== null || v('tax') !== null)) {
      // QuickBooks-style statements: build up from the bottom line.
      setDerived('ebitda', v('net_income')! + (v('interest_expense') ?? 0) + (v('tax') ?? 0) + v('da')!,
        'net_income + interest_expense + tax + da');
    }
  }

  // ebit = ebitda - da
  if (v('ebit') === null && v('ebitda') !== null && v('da') !== null) {
    setDerived('ebit', v('ebitda')! - v('da')!, 'ebitda - da');
  }

  // Margins are ratios (unscaled, no provenance marker needed).
  if (v('gross_margin_pct') === null && v('gross_profit') !== null && v('revenue')) {
    li.gross_margin_pct = Math.round((v('gross_profit')! / v('revenue')!) * 10000) / 100;
  }
  if (v('ebitda_margin_pct') === null && v('ebitda') !== null && v('revenue')) {
    li.ebitda_margin_pct = Math.round((v('ebitda')! / v('revenue')!) * 10000) / 100;
  }
}
