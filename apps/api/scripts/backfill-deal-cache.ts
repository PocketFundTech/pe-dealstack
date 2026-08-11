/**
 * Backfill Deal.cached* columns for every existing deal.
 *
 * Phase 2 of the unitScale fix. The deal-cache-migration.sql adds
 * cachedRevenue / cachedEbitda / cachedEbitdaMargin / cachedPeriod /
 * cachedCurrency / cachedAt to the Deal table. The live extraction
 * pipeline (runDeepPass) refreshes them on every upsert, but existing
 * deals whose financials were extracted before this change went out
 * still have NULLs. This script walks every Deal in every org, pulls
 * the latest active INCOME_STATEMENT, and writes the canonical cache.
 *
 * Idempotent — safe to re-run. Each deal's cache is overwritten with
 * the freshly-computed value, so running this twice yields the same
 * end state. (It's a derived view; we never read the previous cache
 * value to make decisions.)
 *
 * Usage:
 *   npx tsx scripts/backfill-deal-cache.ts
 *
 *   # Preview every write without touching the DB. Recommended before
 *   # any prod run.
 *   npx tsx scripts/backfill-deal-cache.ts --dry-run
 *
 *   # Optional: only backfill deals missing a cache (faster on
 *   # already-populated DBs).
 *   npx tsx scripts/backfill-deal-cache.ts --only-missing
 *
 *   # Optional: limit to one organization (for staged rollouts).
 *   npx tsx scripts/backfill-deal-cache.ts --org=<orgId>
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (mirrors
 * the live API process). Bypasses RLS via the service role key.
 */

import { supabase } from '../src/supabase.js';
import {
  refreshDealCache,
  fetchLatestIncomeStatement,
  buildCacheRecord,
} from '../src/services/dealCacheWriteback.js';

interface DealRow {
  id: string;
  organizationId: string | null;
  name: string | null;
  cachedAt: string | null;
}

function parseArgs(argv: string[]): {
  onlyMissing: boolean;
  orgId: string | null;
  dryRun: boolean;
} {
  let onlyMissing = false;
  let orgId: string | null = null;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--only-missing') onlyMissing = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--org=')) orgId = arg.slice('--org='.length);
  }
  return { onlyMissing, orgId, dryRun };
}

function fmtMoney(n: number | null): string {
  if (n == null) return 'null';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

async function main(): Promise<void> {
  const { onlyMissing, orgId, dryRun } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    console.log('═══════════════════════════════════════════');
    console.log('  DRY RUN — no writes will be issued');
    console.log('═══════════════════════════════════════════');
  }
  console.log('[backfill-deal-cache] starting');
  if (onlyMissing) console.log('[backfill-deal-cache] --only-missing: skipping deals with cachedAt set');
  if (orgId) console.log(`[backfill-deal-cache] --org=${orgId}: scoped to one org`);

  let query = supabase
    .from('Deal')
    .select('id, organizationId, name, cachedAt');

  if (orgId) query = query.eq('organizationId', orgId);
  if (onlyMissing) query = query.is('cachedAt', null);

  const { data: deals, error } = await query;
  if (error) {
    console.error('[backfill-deal-cache] failed to list deals', error);
    process.exit(1);
  }

  const list = (deals ?? []) as DealRow[];
  console.log(`[backfill-deal-cache] found ${list.length} deal(s) to process`);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();
  // Log a heartbeat every N deals so long prod runs don't look frozen.
  const PROGRESS_EVERY = 25;

  for (let i = 0; i < list.length; i++) {
    const deal = list[i]!;
    try {
      if (dryRun) {
        // Reuse the writeback module's compute path (fetch + build) but
        // skip writeDealCache. Keeps dry-run output byte-identical to
        // what a real run would persist.
        const row = await fetchLatestIncomeStatement(deal.id);
        const record = buildCacheRecord(row, nowIso);
        if (record.cachedRevenue == null && record.cachedEbitda == null) {
          console.log(
            `[backfill-deal-cache] DRY RUN deal ${deal.id} (${deal.name ?? '?'}): no income statement — would clear cache`,
          );
          skipped++;
        } else {
          console.log(
            `[backfill-deal-cache] DRY RUN deal ${deal.id} (${deal.name ?? '?'}): would write period=${record.cachedPeriod} revenue=${fmtMoney(record.cachedRevenue)} ebitda=${fmtMoney(record.cachedEbitda)} margin=${record.cachedEbitdaMargin}% currency=${record.cachedCurrency}`,
          );
          refreshed++;
        }
      } else {
        const record = await refreshDealCache(deal.id, nowIso);
        if (record === null) {
          // refreshDealCache caught an error internally and logged it.
          failed++;
        } else if (record.cachedRevenue == null && record.cachedEbitda == null) {
          // No income statement → cache cleared. Count as "skipped" so the
          // success number reflects deals that ended up with real data.
          skipped++;
        } else {
          refreshed++;
        }
      }
    } catch (err) {
      console.error(`[backfill-deal-cache] deal ${deal.id} (${deal.name ?? '?'}) threw`, err);
      failed++;
    }

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(
        `[backfill-deal-cache] progress: ${i + 1}/${list.length} (refreshed=${refreshed} skipped=${skipped} failed=${failed})`,
      );
    }
  }

  const verb = dryRun ? 'would update' : 'refreshed';
  console.log(
    `[backfill-deal-cache] done: ${verb}=${refreshed} skipped=${skipped} failed=${failed}`,
  );
  if (dryRun) {
    console.log(
      `[backfill-deal-cache] DRY RUN complete — re-run without --dry-run to apply ${refreshed} update(s).`,
    );
  }

  // Non-zero exit when anything errored so CI-style invocations don't
  // silently pass on partial failure.
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('[backfill-deal-cache] unhandled error', err);
  process.exit(1);
});
