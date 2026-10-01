/**
 * Normalizer: raw as-printed Claude extraction → the existing
 * ClassificationResult interface (financialClassifier.ts), so the validator,
 * orchestrator, store node, and UI are untouched.
 *
 * - Scale conversion to canonical MILLIONS happens HERE (deterministic code),
 *   not in prompts — the top source of legacy scale errors (spec §3.2).
 *   Converted values are cleaned to 12 significant digits to kill
 *   reciprocal-multiply float noise — never a fixed decimal cutoff, which
 *   would zero out small values (see cleanFloat).
 * - Ratio-like fields (name ends `_pct`, `_ratio`, or `_multiple`) are never
 *   scaled — matches the suffix convention the prompt requires for any
 *   invented ratio/rate/multiple name (extractionSchema.ts).
 * - Provenance folds into the legacy `${name}_source` string convention: the
 *   VERBATIM sourceQuote (matching financialClassifier.ts's own convention —
 *   see extractionPrompt.ts's source_quote examples), falling back to a bare
 *   `p{page}` marker only when no quote was captured. A prefix-wrapped quote
 *   would never literally appear in the source document, which silently
 *   defeats storeNode.ts's scoreSourceMatch() substring check.
 * - Missing income-statement subtotals (EBITDA, EBIT, gross profit, margins)
 *   are derived deterministically (financialDerivations.ts), tagged
 *   `<key>_source: "derived: …"`.
 * - Alias canonicalization is delegated to validateLineItems (financialSchema),
 *   which exports its alias table so this module has a single source of truth.
 */

import type {
  ClassificationResult,
  ClassifiedStatement,
} from '../financialClassifier.js';
import {
  validateLineItems, LINE_ITEM_ALIASES, incomeStatementSchema, balanceSheetSchema, cashFlowSchema,
} from '../financialSchema.js';
import {
  computeDerivedFields, normalizeCashFlowSigns, normalizeIncomeStatementSigns, nestedLineItemKey,
} from '../financialDerivations.js';

/** Standard (non-_source) keys — never renamed under a parent. */
const STANDARD_KEYS: ReadonlySet<string> = new Set(
  [incomeStatementSchema, balanceSheetSchema, cashFlowSchema]
    .flatMap((schema) => Object.keys(schema.shape))
    .filter((k) => !k.endsWith('_source')),
);

/**
 * Aliases ("sales" → revenue) are protected too, EXCEPT under their own
 * target: a "Sales" account the extractor placed under revenue is a
 * component of revenue — renamed revenue_sales — not a second copy of it
 * that dropDuplicateAliases would delete.
 */
function protectedKeysFor(parent: string | null | undefined): ReadonlySet<string> {
  if (!parent) return STANDARD_KEYS;
  return new Set([
    ...STANDARD_KEYS,
    ...Object.entries(LINE_ITEM_ALIASES).filter(([, target]) => target !== parent).map(([alias]) => alias),
  ]);
}
import type { ExtractionResponse, RawStatement } from './extractionSchema.js';

const SCALE_TO_MILLIONS: Record<RawStatement['unitScale'], number> = {
  UNITS: 1 / 1_000_000,
  THOUSANDS: 1 / 1_000,
  LAKHS: 1 / 10, // 1 lakh = 100,000
  MILLIONS: 1,
  CRORES: 10, // 1 crore = 10,000,000
  BILLIONS: 1_000,
};

/**
 * Kill float noise from the reciprocal scale factors above (99999 × 1e-6 =
 * 0.09999899999999999) WITHOUT a fixed decimal cutoff. The previous
 * round-to-4-decimals rule was a $100 floor in MILLIONS: any value below
 * 0.00005M became 0 and everything else snapped to the nearest $100 — which
 * is how an INR-crore P&L tagged UNITS came out as 200/200/300 revenue and
 * 0 EBITDA. 12 significant digits is far beyond any printed precision.
 */
function cleanFloat(n: number): number {
  return Number(n.toPrecision(12));
}

/**
 * Post-pass after validateLineItems: when both an alias and its canonical
 * target are present (validateLineItems only renames when the canonical key
 * is absent), drop the alias so the record has a single, unambiguous key.
 */
function dropDuplicateAliases(
  record: Record<string, unknown>,
  warnings: string[],
): void {
  for (const [alias, canonical] of Object.entries(LINE_ITEM_ALIASES)) {
    if (alias in record && canonical in record) {
      delete record[alias];
      delete record[`${alias}_source`];
      warnings.push(`Dropped duplicate alias "${alias}" (canonical "${canonical}" present)`);
    }
  }
}

function foldPeriodLineItems(
  items: Array<{ name: string; value: number | null; sourcePage: number | null; sourceQuote: string | null; parent?: string | null }>,
  factor: number,
): Record<string, number | string | null> {
  const record: Record<string, number | string | null> = {};
  for (const item of items) {
    // Raw accounts nest under their parent ("sand_cos" + cogs → cogs_sand_cos)
    // so the table can show them under COGS instead of after Net Income.
    const name = nestedLineItemKey(item.name.trim().toLowerCase().replace(/\s+/g, '_'), item.parent, protectedKeysFor(item.parent));
    // First non-null value wins — a null placeholder shouldn't shadow a
    // real value reported under the same name later in the array.
    if (name in record && record[name] !== null) continue;
    const isUnscaled = name.endsWith('_pct') || name.endsWith('_ratio') || name.endsWith('_multiple');
    record[name] = item.value === null ? null : isUnscaled ? item.value : cleanFloat(item.value * factor);
    if (item.sourcePage !== null || item.sourceQuote !== null) {
      const page = item.sourcePage !== null ? `p${item.sourcePage}` : 'p?';
      record[`${name}_source`] = item.sourceQuote !== null ? item.sourceQuote : page;
    }
  }
  return record;
}

export function toClassificationResult(raw: ExtractionResponse): ClassificationResult {
  const warnings: string[] = [...raw.warnings];
  const statements: ClassifiedStatement[] = [];

  for (const stmt of raw.statements) {
    const factor = SCALE_TO_MILLIONS[stmt.unitScale];
    if (stmt.unitScale !== 'MILLIONS') {
      warnings.push(`${stmt.statementType}: converted ${stmt.unitScale} → MILLIONS (×${factor})`);
    }
    if (stmt.currency && stmt.currency.toUpperCase() !== 'USD') {
      warnings.push(`${stmt.statementType}: currency is ${stmt.currency} — values NOT converted to USD`);
    }

    const periods = stmt.periods.map((p) => {
      const folded = foldPeriodLineItems(p.lineItems, factor);
      const { normalized, warnings: itemWarnings } = validateLineItems(stmt.statementType, folded);
      warnings.push(...itemWarnings.map((w) => `${stmt.statementType} ${p.period}: ${w}`));
      dropDuplicateAliases(normalized, warnings);
      // Derive EBITDA / EBIT / GP / margins the statement doesn't print —
      // same rules as the legacy engine (financialDerivations.ts).
      if (stmt.statementType === 'INCOME_STATEMENT') {
        warnings.push(...normalizeIncomeStatementSigns(normalized, p.period));
        computeDerivedFields(normalized);
      }
      // Cash outflows (capex, repayments, distributions…) stored ≤ 0.
      if (stmt.statementType === 'CASH_FLOW') warnings.push(...normalizeCashFlowSigns(normalized, p.period));
      return {
        period: p.period,
        periodType: p.periodType,
        confidence: Math.max(0, Math.min(100, Math.round(p.confidence))),
        lineItems: normalized as Record<string, number | null>,
      };
    });

    statements.push({
      statementType: stmt.statementType,
      unitScale: 'MILLIONS', // post-conversion canonical scale
      currency: stmt.currency || 'USD',
      periods,
      sheetName: stmt.sheetName ?? null,
      sourceKind: stmt.sourceKind ?? null,
    });
  }

  return {
    statements,
    overallConfidence: Math.max(0, Math.min(100, Math.round(raw.overallConfidence))),
    warnings,
  };
}
