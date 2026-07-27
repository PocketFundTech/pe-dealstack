/**
 * Normalizer: raw as-printed Claude extraction → the existing
 * ClassificationResult interface (financialClassifier.ts), so the validator,
 * orchestrator, store node, and UI are untouched.
 *
 * - Scale conversion to canonical MILLIONS happens HERE (deterministic code),
 *   not in prompts — the top source of legacy scale errors (spec §3.2).
 *   Converted values are rounded to 4 decimals to kill reciprocal-multiply
 *   float noise (mirrors financialClassifier.ts's own rounding convention).
 * - Ratio-like fields (name ends `_pct`, `_ratio`, or `_multiple`) are never
 *   scaled — matches the suffix convention the prompt requires for any
 *   invented ratio/rate/multiple name (extractionSchema.ts).
 * - Provenance folds into the legacy `${name}_source` string convention: the
 *   VERBATIM sourceQuote (matching financialClassifier.ts's own convention —
 *   see extractionPrompt.ts's source_quote examples), falling back to a bare
 *   `p{page}` marker only when no quote was captured. A prefix-wrapped quote
 *   would never literally appear in the source document, which silently
 *   defeats storeNode.ts's scoreSourceMatch() substring check.
 * - Alias canonicalization is delegated to validateLineItems (financialSchema),
 *   which exports its alias table so this module has a single source of truth.
 */

import type {
  ClassificationResult,
  ClassifiedStatement,
} from '../financialClassifier.js';
import { validateLineItems, LINE_ITEM_ALIASES } from '../financialSchema.js';
import type { ExtractionResponse, RawStatement } from './extractionSchema.js';

const SCALE_TO_MILLIONS: Record<RawStatement['unitScale'], number> = {
  UNITS: 1 / 1_000_000,
  THOUSANDS: 1 / 1_000,
  MILLIONS: 1,
  BILLIONS: 1_000,
};

/** Round to 4 decimals — kills float noise from the reciprocal scale factors above. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
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
  items: Array<{ name: string; value: number | null; sourcePage: number | null; sourceQuote: string | null }>,
  factor: number,
): Record<string, number | string | null> {
  const record: Record<string, number | string | null> = {};
  for (const item of items) {
    const name = item.name.trim().toLowerCase().replace(/\s+/g, '_');
    // First non-null value wins — a null placeholder shouldn't shadow a
    // real value reported under the same name later in the array.
    if (name in record && record[name] !== null) continue;
    const isUnscaled = name.endsWith('_pct') || name.endsWith('_ratio') || name.endsWith('_multiple');
    record[name] = item.value === null ? null : isUnscaled ? item.value : round4(item.value * factor);
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
    });
  }

  return {
    statements,
    overallConfidence: Math.max(0, Math.min(100, Math.round(raw.overallConfidence))),
    warnings,
  };
}
