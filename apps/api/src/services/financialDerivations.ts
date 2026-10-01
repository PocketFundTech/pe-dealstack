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
 *
 * Also holds the cash-flow sign pass (normalizeCashFlowSigns) — outflows ≤ 0.
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

// ─── Cash-flow sign convention ──────────────────────────────
// Cash outflows are stored ≤ 0. Documents (and valuation models) print them
// either way — "Owner distributions 1,300" vs "(1,300)" — and nothing used
// to normalise them, so the SRM deal showed +$1.3M distributions. Consumers
// that need a magnitude (capex vs D&A, FCF) already take Math.abs.

const OUTFLOW_KEY_RE =
  /^(capex|capital_expenditures?|acquisitions?|debt_repayments?|repayments?_of_(debt|borrowings|loans?)|principal_repayments?|dividends?(_paid)?|(owner|shareholder|member|partner)?_?distributions?|share_repurchases?|stock_buybacks?|purchases?_of_(property|equipment|ppe|fixed_assets|investments))(_|$)/;

/** True for a cash-flow line that is by definition a use of cash. */
export function isCashOutflowKey(key: string): boolean {
  if (key.endsWith('_source') || key.endsWith('_pct') || key.endsWith('_ratio') || key.endsWith('_multiple')) return false;
  if (/proceeds|net_|_net$|received/.test(key)) return false;
  return OUTFLOW_KEY_RE.test(key);
}

/** Flip positive outflows to negative in place; returns one warning per flip. */
export function normalizeCashFlowSigns(li: Items, periodLabel: string): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(li)) {
    if (typeof value === 'number' && value > 0 && isCashOutflowKey(key)) {
      li[key] = -value;
      warnings.push(`CASH_FLOW ${periodLabel}: ${key} stored as an outflow (${value} → ${-value})`);
    }
  }
  return warnings;
}

// ─── Income-statement account conventions (fix plan C1) ────────

const CONTRA_REVENUE_RE = /(^|_)(discounts?|refunds?|returns?|returned|allowances?|rebates?)(_|$)/;

/** Contra-revenue accounts nested under revenue (revenue_discounts …) are stored ≤ 0. */
export function normalizeIncomeStatementSigns(li: Items, periodLabel: string): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(li)) {
    if (typeof value === 'number' && value > 0 && key.startsWith('revenue_') && !key.endsWith('_source')
      && CONTRA_REVENUE_RE.test(key.slice('revenue_'.length))) {
      li[key] = -value;
      warnings.push(`INCOME_STATEMENT ${periodLabel}: ${key} stored as contra-revenue (${value} → ${-value})`);
    }
  }
  return warnings;
}

/**
 * Key for a raw account the extractor placed under `parent`: the existing
 * `<parent>_<label>` convention the UI and legacy engine already use
 * ("sand_cos" under cogs → "cogs_sand_cos"). Standard keys are unchanged.
 */
export function nestedLineItemKey(name: string, parent: string | null | undefined, standardKeys: ReadonlySet<string>): string {
  if (!parent || name === parent || standardKeys.has(name) || name.startsWith(`${parent}_`)) return name;
  const rest = name.split('_').filter((t) => t && t !== parent).join('_');
  return rest ? `${parent}_${rest}` : name;
}
