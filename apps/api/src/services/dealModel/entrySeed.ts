// Default entry multiple — and when the deal record's own multiple can't be trusted.
//
// The default entry multiple is deal size ÷ the deal record's EBITDA, but
// the model applies it to the base-period EBITDA from the statements. When
// those two EBITDAs are different numbers (SRM: 6.1 on the record, often an
// adjusted figure, vs 2.21 from the P&L), the multiple prices a different
// deal: 5.5x × 2.21 is neither the advertised EV nor a considered multiple,
// yet it looks perfectly plausible on the Assumptions sheet.

import type { BaseColumn } from './lineCatalogue.js';

/** Used when the deal record gives no usable multiple. */
export const DEFAULT_ENTRY_MULTIPLE = 5;

/** Relative gap above which the two EBITDAs are treated as different figures. */
export const EBITDA_GAP_THRESHOLD = 0.25;

/** |deal − statements| / statements, or null when either is missing or not positive. */
export function ebitdaGap(statementsEbitda: number | null | undefined, dealEbitda: number | null | undefined): number | null {
  if (typeof statementsEbitda !== 'number' || typeof dealEbitda !== 'number') return null;
  if (!(statementsEbitda > 0) || !(dealEbitda > 0)) return null;
  return Math.abs(dealEbitda - statementsEbitda) / statementsEbitda;
}

export interface EntrySeedInput {
  /** Deal size ÷ deal-record EBITDA, if the record has both. */
  impliedMultiple: number | null;
  /** Deal-record EBITDA, in millions. */
  dealEbitda: number | null;
  /** Base-period EBITDA the model will use, when it comes from the statements. */
  statementsEbitda: number | null;
  entrySource: BaseColumn['entrySource'];
}

export interface EntrySeed {
  /** Multiple to seed the default assumptions with; null → DEFAULT_ENTRY_MULTIPLE. */
  evMultiple: number | null;
  /** Plain-language reasons, shown on the Build model panel and in the workbook Notes. */
  warnings: string[];
}

export function entrySeed({ impliedMultiple, dealEbitda, statementsEbitda, entrySource }: EntrySeedInput): EntrySeed {
  // Entry EBITDA is the deal record's own (the statements have none): the
  // record's multiple and EBITDA belong together.
  if (entrySource !== 'base') return { evMultiple: impliedMultiple, warnings: [] };
  const gap = ebitdaGap(statementsEbitda, dealEbitda);
  if (gap === null || gap < EBITDA_GAP_THRESHOLD) return { evMultiple: impliedMultiple, warnings: [] };

  const warnings = [
    `The deal record's EBITDA (${dealEbitda!.toFixed(2)}) differs from the base-period EBITDA in the statements ` +
    `(${statementsEbitda!.toFixed(2)}) by ${Math.round(gap * 100)}%. The model uses the statements figure; ` +
    `if the deal record's figure is the right entry basis (e.g. adjusted EBITDA), update the base-period costs or the deal record.`,
  ];
  if (impliedMultiple !== null) {
    warnings.push(
      `The default entry multiple is ${DEFAULT_ENTRY_MULTIPLE.toFixed(1)}x, not the deal record's ${impliedMultiple.toFixed(2)}x ` +
      `(deal size ÷ deal-record EBITDA): that multiple belongs to a different EBITDA than the one the model uses. Set the entry multiple yourself.`,
    );
  }
  return { evMultiple: null, warnings };
}
