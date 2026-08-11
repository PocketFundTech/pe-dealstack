/**
 * Retroactive unit-scale correction for already-persisted FinancialStatement
 * rows whose unitScale was mis-tagged by an earlier extraction.
 *
 * Applies the same `applySourceTextDollarOverride` logic the live classifier
 * now runs on every new extraction (financialClassifier.ts). When the row's
 * `_source` citations literally cite "$N,NNN" amounts that match the parsed
 * numeric value within 1%, the unit MUST be ACTUALS — regardless of what the
 * LLM tagged at extraction time.
 *
 * Usage:
 *   npx tsx scripts/fix-unit-scale-mistags.ts --dry-run
 *   npx tsx scripts/fix-unit-scale-mistags.ts --deal=<dealId>
 *   npx tsx scripts/fix-unit-scale-mistags.ts            # all deals, real run
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env. Bypasses RLS.
 */

import { supabase } from '../src/supabase.js';
import {
  applySourceTextDollarOverride,
  type ClassificationResult,
  type ClassifiedStatement,
  type FinancialPeriod,
  type StatementType,
  type UnitScale,
} from '../src/services/financialClassifier.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const dealArg = argv.find(a => a.startsWith('--deal='))?.split('=')[1];

async function main(): Promise<void> {
  let q = supabase
    .from('FinancialStatement')
    .select('id, dealId, statementType, period, periodType, lineItems, unitScale, currency')
    .in('unitScale', ['MILLIONS', 'THOUSANDS', 'BILLIONS'])
    .eq('isActive', true);
  if (dealArg) q = q.eq('dealId', dealArg);
  const { data, error } = await q;
  if (error) throw error;
  if (!data || data.length === 0) {
    console.log('No candidate rows found.');
    return;
  }
  console.log(`Examining ${data.length} non-ACTUALS rows…`);

  let updates = 0;
  for (const row of data) {
    const period: FinancialPeriod = {
      period: row.period,
      periodType: (row.periodType ?? 'HISTORICAL') as FinancialPeriod['periodType'],
      lineItems: row.lineItems ?? {},
      confidence: 90,
    };
    const stmt: ClassifiedStatement = {
      statementType: row.statementType as StatementType,
      unitScale: row.unitScale as UnitScale,
      currency: row.currency || 'USD',
      periods: [period],
    };
    const result: ClassificationResult = { statements: [stmt], overallConfidence: 90, warnings: [] };
    applySourceTextDollarOverride(result);
    if (result.statements[0].unitScale === 'ACTUALS') {
      console.log(`[${dryRun ? 'DRY' : 'FIX'}] ${row.dealId} ${row.statementType} "${row.period}": ${row.unitScale} → ACTUALS`);
      if (!dryRun) {
        const { error: updErr } = await supabase
          .from('FinancialStatement')
          .update({ unitScale: 'ACTUALS' })
          .eq('id', row.id);
        if (updErr) console.error(`  ! update failed: ${updErr.message}`);
        else updates++;
      } else {
        updates++;
      }
    }
  }
  console.log(`${dryRun ? 'Would update' : 'Updated'} ${updates} row(s).`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
