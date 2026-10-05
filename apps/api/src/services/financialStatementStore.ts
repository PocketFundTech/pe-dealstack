/**
 * FinancialStatement row writes for the deep pass, including the canonical
 * period + provenance columns from financials-source-period-migration.sql
 * (fix plan A4 + B1).
 *
 * MIGRATIONS ARE MANUAL (founder runs the SQL), so this works before AND
 * after the columns exist: the first write tries them; if PostgREST says a
 * column doesn't exist, it remembers that for the life of the process and
 * writes the original columns only. Matching never depends on the columns
 * either — callers fall back to parsing the label (periodKeyOf).
 */

import { parsePeriod } from '@ai-crm/shared';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import type { SourceKind, StatementType } from './financialClassifier.js';
import type { DocAuthorityMeta } from './financialSourceAuthority.js';
import { resolveSourceKind, type SourceCandidate } from './financialSourceSelection.js';

/** An active FinancialStatement row as read with select('*'). New columns are absent pre-migration. */
export interface ActiveRow {
  id: string;
  documentId: string | null;
  period: string;
  lineItems: Record<string, unknown> | null;
  periodKey?: string | null;
  sourceKind?: SourceKind | null;
  sheetName?: string | null;
}

export interface ExtendedColumns {
  periodKey: string;
  periodKind: string | null;
  periodMonths: number | null;
  periodEndDate: string | null;
  sourceKind: SourceKind;
  sheetName: string | null;
}

export function canonicalPeriodColumns(label: string): Pick<ExtendedColumns, 'periodKey' | 'periodKind' | 'periodMonths' | 'periodEndDate'> {
  const p = parsePeriod(label);
  return {
    periodKey: p?.canonicalKey ?? label.trim(),
    periodKind: p?.kind ?? null,
    periodMonths: p?.months ?? null,
    periodEndDate: p?.endDate ?? null,
  };
}

export function candidateFromRow(
  row: ActiveRow,
  statementType: StatementType,
  docMetaById: Map<string, DocAuthorityMeta>,
): SourceCandidate {
  const doc = row.documentId ? docMetaById.get(row.documentId) : undefined;
  return {
    sourceKind: resolveSourceKind(row.sourceKind, row.sheetName, doc?.name),
    doc,
    statementType,
    lineItems: row.lineItems,
    period: row.period,
  };
}

export async function deactivateRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase
    .from('FinancialStatement')
    .update({ isActive: false, mergeStatus: 'auto' })
    .in('id', ids);
}

/** null = not yet known; flips to false on the first "column does not exist". */
let extendedColumnsAvailable: boolean | null = null;

/** Test hook. */
export function resetExtendedColumnsProbe(): void {
  extendedColumnsAvailable = null;
}

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42703 = Postgres undefined_column; PGRST204 = column not in PostgREST's schema cache.
  return error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message ?? '');
}

export async function upsertStatementRow(
  base: Record<string, unknown>,
  extended: ExtendedColumns,
): Promise<{ data: { id: string } | null; error: { code?: string; message?: string } | null }> {
  const write = (row: Record<string, unknown>) =>
    supabase
      .from('FinancialStatement')
      .upsert(row, { onConflict: 'dealId,statementType,period,documentId' })
      .select('id')
      .single();

  if (extendedColumnsAvailable !== false) {
    const res = await write({ ...base, ...extended });
    if (!isMissingColumnError(res.error)) {
      if (!res.error) extendedColumnsAvailable = true;
      return res;
    }
    extendedColumnsAvailable = false;
    log.warn('FinancialStatement canonical-period / provenance columns missing — run financials-source-period-migration.sql. Writing without them.');
  }
  return write(base);
}
