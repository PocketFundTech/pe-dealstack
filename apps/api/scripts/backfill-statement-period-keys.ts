/**
 * Backfill FinancialStatement period columns added by
 * financials-source-period-migration.sql (fix plan A4).
 *
 * Fills periodKey / periodKind / periodMonths / periodEndDate on rows stored
 * before the migration, using the same canonicalPeriodColumns() the
 * extraction pipeline writes for new rows. Only rows with a NULL periodKey
 * are touched; nothing else changes (which row is active stays the same).
 * Idempotent — safe to re-run. Optional: when the columns are empty the
 * app matches periods by parsing the label instead.
 *
 * sourceKind / sheetName are not backfilled: they can only be known from
 * the extraction itself, and Re-extract fills them.
 *
 * Usage (reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env):
 *   npx tsx scripts/backfill-statement-period-keys.ts --dry-run
 *   npx tsx scripts/backfill-statement-period-keys.ts
 */
import { canonicalPeriodColumns } from '../src/services/financialStatementStore.js';

interface Row {
  id: string;
  period: string;
  periodKey: string | null;
}

export interface PeriodKeyUpdate {
  id: string;
  periodKey: string;
  periodKind: string | null;
  periodMonths: number | null;
  periodEndDate: string | null;
}

/** Rows still missing a periodKey → the columns to write. */
export function planPeriodKeyBackfill(rows: Row[]): PeriodKeyUpdate[] {
  return rows
    .filter((r) => !r.periodKey && r.period)
    .map((r) => ({ id: r.id, ...canonicalPeriodColumns(r.period) }));
}

const PAGE = 1000;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { supabase } = await import('../src/supabase.js');

  let planned = 0;
  let written = 0;
  let failed = 0;
  // Always read page 0 of what's still missing: written rows drop out of
  // the filter, so paging forward would skip rows. In dry-run nothing is
  // written, so page through by offset instead.
  for (let offset = 0; ; offset += dryRun ? PAGE : 0) {
    const { data, error } = await supabase
      .from('FinancialStatement')
      .select('id, period, periodKey')
      .is('periodKey', null)
      .order('id')
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    const updates = planPeriodKeyBackfill(rows);
    planned += updates.length;
    if (dryRun) {
      for (const u of updates.slice(0, 5)) console.log('  would set', u);
      if (rows.length < PAGE) break;
      continue;
    }
    for (const u of updates) {
      const { id, ...cols } = u;
      const { error: upErr } = await supabase.from('FinancialStatement').update(cols).eq('id', id);
      if (upErr) { failed++; console.error('  failed', id, upErr.message); } else written++;
    }
    if (updates.length === 0 || failed > 0) break; // avoid looping on rows that can't be written
  }

  console.log(dryRun
    ? `Dry run: ${planned} rows would get period columns.`
    : `Done: ${written} rows updated, ${failed} failed.`);
}

if (process.argv[1]?.includes('backfill-statement-period-keys')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
