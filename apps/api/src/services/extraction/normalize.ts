/**
 * Normalizer: raw as-printed Claude extraction → the existing
 * ClassificationResult interface (financialClassifier.ts), so the validator,
 * orchestrator, store node, and UI are untouched.
 *
 * - Scale conversion to canonical MILLIONS happens HERE (deterministic code),
 *   not in prompts — the top source of legacy scale errors (spec §3.2).
 * - Percent fields (name ends `_pct`) are never scaled.
 * - Provenance folds into the legacy `${name}_source` string convention:
 *   `p{page}: "{quote}"`.
 * - Alias canonicalization is delegated to validateLineItems (financialSchema).
 */

import type {
  ClassificationResult,
  ClassifiedStatement,
} from '../financialClassifier.js';
import { validateLineItems } from '../financialSchema.js';
import type { ExtractionResponse, RawStatement } from './extractionSchema.js';

const SCALE_TO_MILLIONS: Record<RawStatement['unitScale'], number> = {
  UNITS: 1 / 1_000_000,
  THOUSANDS: 1 / 1_000,
  MILLIONS: 1,
  BILLIONS: 1_000,
};

/**
 * Mirrors the alias table in financialSchema.ts (validateLineItems).
 *
 * validateLineItems only renames alias→canonical when the canonical key is
 * ABSENT (`if (alias in normalized && !(canonical in normalized))`). When an
 * extraction reports BOTH the alias and the canonical name for the same
 * concept (e.g. a document lists "revenue" and "total_revenue" separately —
 * the model captured the same line twice under different labels),
 * validateLineItems leaves the alias in place untouched. dropDuplicateAliases
 * below removes that leftover duplicate deterministically, always preferring
 * the canonical key.
 */
const LEGACY_ALIASES: Record<string, string> = {
  total_revenue: 'revenue',
  net_revenue: 'revenue',
  net_sales: 'revenue',
  sales: 'revenue',
  operating_income: 'ebit',
  operating_profit: 'ebit',
  cost_of_revenue: 'cogs',
  cost_of_sales: 'cogs',
  cost_of_goods: 'cogs',
  selling_general_admin: 'sga',
  research_development: 'rd',
  depreciation_amortization: 'da',
  total_debt: 'long_term_debt',
  shareholders_equity: 'total_equity',
  stockholders_equity: 'total_equity',
};

/**
 * Post-pass after validateLineItems: when both an alias and its canonical
 * target are present (validateLineItems only renames when the canonical key
 * is absent), drop the alias so the record has a single, unambiguous key.
 */
function dropDuplicateAliases(
  record: Record<string, unknown>,
  warnings: string[],
): void {
  for (const [alias, canonical] of Object.entries(LEGACY_ALIASES)) {
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
    if (name in record) continue; // first occurrence wins
    const isPct = name.endsWith('_pct');
    record[name] = item.value === null ? null : isPct ? item.value : item.value * factor;
    if (item.sourcePage !== null || item.sourceQuote !== null) {
      const page = item.sourcePage !== null ? `p${item.sourcePage}` : 'p?';
      record[`${name}_source`] = item.sourceQuote !== null ? `${page}: "${item.sourceQuote}"` : page;
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
