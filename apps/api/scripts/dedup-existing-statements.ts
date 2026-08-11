/**
 * Retroactive Rule-C dedup of FinancialStatement rows.
 *
 * Production has thousands of rows where the same
 * (dealId, documentId, statementType, parsedYear, parsedMonth) is stored
 * under multiple label formats simultaneously — e.g. "Jan 2026" AND
 * "Jan-26" AND "2026-01", all isActive=true, identical line items.
 *
 * The Rule C dedup in storeNode.ts only fires on NEW extractions; this
 * script applies the SAME logic to pre-existing rows.
 *
 * SCOPE: Rule C only (same-month-different-label). Rule A
 * (annual+monthly overlap) and Rule B (zero annual + non-zero monthly)
 * are intentionally NOT applied here — they have different semantics
 * and could mass-deactivate annual summaries the user manually verified.
 *
 * Usage:
 *   npx tsx scripts/dedup-existing-statements.ts --dry-run
 *   npx tsx scripts/dedup-existing-statements.ts --org=<orgId>
 *   npx tsx scripts/dedup-existing-statements.ts --deal=<dealId>
 *   npx tsx scripts/dedup-existing-statements.ts            # all orgs, real run
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env. Bypasses RLS.
 */

import { supabase } from '../src/supabase.js';
import { refreshDealCache } from '../src/services/dealCacheWriteback.js';
import { parsePeriodToYearMonth } from '../src/services/reconciler/shared.js';

interface StatementRow {
  id: string;
  dealId: string;
  documentId: string | null;
  statementType: string;
  period: string;
  lineItems: Record<string, number | null> | null;
  extractedAt: string | null;
  isActive: boolean;
  mergeStatus: string | null;
}

interface DealRow {
  id: string;
  name: string | null;
  organizationId: string | null;
}

interface ParsedArgs {
  dryRun: boolean;
  orgId: string | null;
  dealId: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let orgId: string | null = null;
  let dealId: string | null = null;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--org=')) orgId = arg.slice('--org='.length);
    else if (arg.startsWith('--deal=')) dealId = arg.slice('--deal='.length);
  }
  return { dryRun, orgId, dealId };
}

/** Rank a monthly period label for canonical-keep selection. Lower wins.
 * Why: ISO `YYYY-MM` is unambiguous; long-form `Mon YYYY` survives any
 * downstream UI that strips two-digit-year heuristics; short-form
 * `Mon-YY` is the most likely to be re-parsed wrong by a dumb consumer.
 * Mirrors canonicalLabelRank in storeNode.ts so live + retro dedup pick
 * the same winner. */
function canonicalLabelRank(label: string): number {
  const trimmed = label.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return 0;
  if (/^[A-Za-z]+\s+\d{4}$/.test(trimmed)) return 1;
  if (/^[A-Za-z]+-\d{2}$/.test(trimmed)) return 2;
  return 3;
}

/** Compare two rows numerically across every shared finite line item.
 * Returns true when ALL shared numeric fields match exactly. Divergent
 * values mean the rows aren't really duplicates of the same source —
 * different revenue / ebitda / etc. for the same period would mean we
 * lose data by deactivating one. */
function lineItemsAgree(
  a: Record<string, number | null> | null,
  b: Record<string, number | null> | null,
): { agree: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const ali = a ?? {};
  const bli = b ?? {};
  const keys = new Set([...Object.keys(ali), ...Object.keys(bli)]);
  for (const k of keys) {
    const av = ali[k];
    const bv = bli[k];
    if (typeof av !== 'number' || !Number.isFinite(av)) continue;
    if (typeof bv !== 'number' || !Number.isFinite(bv)) continue;
    if (av !== bv) mismatches.push(`${k}=${av} vs ${bv}`);
  }
  return { agree: mismatches.length === 0, mismatches };
}

interface GroupResult {
  keep: StatementRow;
  drops: StatementRow[];
  divergent: boolean;
  divergentDetail?: string;
}

function processGroup(rows: StatementRow[]): GroupResult | null {
  if (rows.length < 2) return null;

  const sorted = [...rows].sort((x, y) => {
    const r = canonicalLabelRank(x.period) - canonicalLabelRank(y.period);
    if (r !== 0) return r;
    const xt = x.extractedAt ? Date.parse(x.extractedAt) : Number.MAX_SAFE_INTEGER;
    const yt = y.extractedAt ? Date.parse(y.extractedAt) : Number.MAX_SAFE_INTEGER;
    return xt - yt;
  });

  const keep = sorted[0]!;
  const drops = sorted.slice(1);

  const divergentDetails: string[] = [];
  for (const d of drops) {
    const cmp = lineItemsAgree(keep.lineItems, d.lineItems);
    if (!cmp.agree) {
      divergentDetails.push(`"${d.period}" (${d.id}) differs from "${keep.period}": ${cmp.mismatches.slice(0, 3).join(', ')}${cmp.mismatches.length > 3 ? ', …' : ''}`);
    }
  }

  if (divergentDetails.length > 0) {
    return { keep, drops, divergent: true, divergentDetail: divergentDetails.join(' | ') };
  }
  return { keep, drops, divergent: false };
}

interface DealAggregate {
  deal: DealRow;
  groups: Array<{
    documentId: string | null;
    statementType: string;
    year: number;
    month: number;
    result: GroupResult;
  }>;
}

async function fetchTargetDeals(args: ParsedArgs): Promise<DealRow[]> {
  let query = supabase.from('Deal').select('id, name, organizationId');
  if (args.dealId) query = query.eq('id', args.dealId);
  if (args.orgId) query = query.eq('organizationId', args.orgId);
  const { data, error } = await query;
  if (error) {
    console.error('[dedup-existing-statements] failed to list deals', error);
    process.exit(1);
  }
  return (data ?? []) as DealRow[];
}

async function fetchActiveStatements(dealId: string): Promise<StatementRow[]> {
  const { data, error } = await supabase
    .from('FinancialStatement')
    .select('id, dealId, documentId, statementType, period, lineItems, extractedAt, isActive, mergeStatus')
    .eq('dealId', dealId)
    .eq('isActive', true);
  if (error) {
    console.error(`[dedup-existing-statements] failed to fetch rows for deal ${dealId}`, error);
    return [];
  }
  return (data ?? []) as StatementRow[];
}

function aggregateDeal(deal: DealRow, rows: StatementRow[]): DealAggregate | null {
  const buckets = new Map<string, StatementRow[]>();
  for (const r of rows) {
    const parsed = parsePeriodToYearMonth(r.period);
    if (!parsed || parsed.month == null) continue; // annual rows out of scope per Rule C
    const key = `${r.documentId ?? 'null'}::${r.statementType}::${parsed.year}-${parsed.month}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const groups: DealAggregate['groups'] = [];
  for (const [key, group] of buckets) {
    if (group.length < 2) continue;
    const result = processGroup(group);
    if (!result) continue;
    const [docPart, stmtType, ymPart] = key.split('::');
    const [yStr, mStr] = (ymPart ?? '').split('-');
    groups.push({
      documentId: docPart === 'null' ? null : (docPart ?? null),
      statementType: stmtType ?? '',
      year: Number(yStr),
      month: Number(mStr),
      result,
    });
  }

  if (groups.length === 0) return null;
  return { deal, groups };
}

async function deactivateRows(ids: string[]): Promise<number> {
  let touched = 0;
  for (const id of ids) {
    const { error } = await supabase
      .from('FinancialStatement')
      .update({ isActive: false, mergeStatus: 'auto_dedup_cleanup' })
      .eq('id', id)
      .eq('isActive', true); // idempotency guard
    if (error) {
      console.error(`[dedup-existing-statements] update failed for row ${id}`, error);
      continue;
    }
    touched++;
  }
  return touched;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log('═══════════════════════════════════════════');
    console.log('  DRY RUN — no writes will be issued');
    console.log('═══════════════════════════════════════════');
  }
  console.log('[dedup-existing-statements] starting');
  if (args.orgId) console.log(`[dedup-existing-statements] --org=${args.orgId}`);
  if (args.dealId) console.log(`[dedup-existing-statements] --deal=${args.dealId}`);

  const deals = await fetchTargetDeals(args);
  console.log(`[dedup-existing-statements] scanning ${deals.length} deal(s)`);

  let totalDeactivated = 0;
  let dealsAffected = 0;
  let cacheRefreshes = 0;
  let divergentGroups = 0;
  const PROGRESS_EVERY = 25;

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i]!;
    const rows = await fetchActiveStatements(deal.id);
    const agg = aggregateDeal(deal, rows);

    if (agg) {
      let dropsThisDeal = 0;
      const keepLabels: string[] = [];
      const dropLabels: string[] = [];

      for (const g of agg.groups) {
        if (g.result.divergent) {
          divergentGroups++;
          console.warn(
            `[dedup-existing-statements] WARN deal ${deal.id} (${deal.name ?? '?'}) ${g.statementType} ${g.year}-${String(g.month).padStart(2, '0')} doc=${g.documentId ?? 'null'}: divergent line items, skipping. ${g.result.divergentDetail}`,
          );
          continue;
        }
        const drops = g.result.drops;
        dropsThisDeal += drops.length;
        keepLabels.push(`"${g.result.keep.period}"`);
        dropLabels.push(...drops.map(d => `"${d.period}"`));
      }

      if (dropsThisDeal === 0) {
        // nothing actionable (all groups divergent or none)
      } else if (args.dryRun) {
        const sample = `${dropLabels.slice(0, 3).join(' + ')}${dropLabels.length > 3 ? ` (+${dropLabels.length - 3} more)` : ''} → keep ${keepLabels.slice(0, 3).join(' + ')}${keepLabels.length > 3 ? ` (+${keepLabels.length - 3} more)` : ''}`;
        console.log(
          `[dedup-existing-statements] would deactivate ${dropsThisDeal} row(s) on deal ${deal.id} (${deal.name ?? '?'}): ${sample}`,
        );
        totalDeactivated += dropsThisDeal;
        dealsAffected++;
      } else {
        const dropIds: string[] = [];
        for (const g of agg.groups) {
          if (g.result.divergent) continue;
          for (const d of g.result.drops) dropIds.push(d.id);
        }
        const touched = await deactivateRows(dropIds);
        totalDeactivated += touched;
        if (touched > 0) {
          dealsAffected++;
          const refreshed = await refreshDealCache(deal.id);
          if (refreshed !== null) cacheRefreshes++;
          console.log(
            `[dedup-existing-statements] deactivated ${touched} rows on deal ${deal.id} (${deal.name ?? '?'}); refreshed cache`,
          );
        }
      }
    }

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(
        `[dedup-existing-statements] progress: ${i + 1}/${deals.length} (deactivated=${totalDeactivated} dealsAffected=${dealsAffected} divergentGroupsSkipped=${divergentGroups})`,
      );
    }
  }

  const verb = args.dryRun ? 'would deactivate' : 'deactivated';
  console.log('───────────────────────────────────────────');
  console.log(`[dedup-existing-statements] done`);
  console.log(`  ${verb}: ${totalDeactivated} row(s)`);
  console.log(`  deals affected: ${dealsAffected}`);
  console.log(`  cache refreshes: ${cacheRefreshes}`);
  console.log(`  divergent groups skipped (warned): ${divergentGroups}`);
  if (args.dryRun) {
    console.log(
      `[dedup-existing-statements] DRY RUN complete — re-run without --dry-run to apply ${totalDeactivated} deactivation(s).`,
    );
  }
}

main().catch((err) => {
  console.error('[dedup-existing-statements] unhandled error', err);
  process.exit(1);
});
