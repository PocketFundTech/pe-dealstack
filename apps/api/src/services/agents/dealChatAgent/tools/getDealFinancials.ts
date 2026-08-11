// ─── get_deal_financials tool ─────────────────────────────────────
// Reads extracted FinancialStatement rows + deal-level metrics and
// formats them as Markdown for the chat agent.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.
//
// Bug history: this tool previously selected `extractedData` and
// `confidence` columns that don't exist on FinancialStatement (the
// real columns are `lineItems` and `extractionConfidence`). Supabase
// returned a PostgrestError + null data for every deal, so the tool
// always reported "No financial statements extracted for this deal
// yet." even when statements existed (the DMpro report). The select
// list now matches the memoAgent equivalent in
// `services/agents/memoAgent/tools.ts` and the error from Supabase
// is surfaced into the tool's return value so future regressions
// fail loudly instead of looking like "empty extraction".

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { correctMistaggedUnitScale, formatDealHeadline, formatFinancialValue, type UnitScale } from '../../../../utils/financialFormat.js';

// Chronological sort key for period strings the extractor emits:
//   "Sep '25", "Sep 2025", "Sep-25", "May 2025", "Q1 2025", "FY2024",
//   "LTM", "Current", "Current Month", "Total", "Apr-23", "May 2023".
// Returns a sortable number (year*100 + month) for date-like labels,
// or one of the synthetic-bucket sentinels for non-date labels so the
// chronological output stays predictable. Higher numbers are more
// recent. Synthetic buckets bucket AFTER the latest concrete date so
// the agent sees them as the "latest" snapshots.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const SYNTHETIC_PERIODS: Record<string, number> = {
  ltm: 999900,
  current: 999901,
  'current month': 999902,
  ttm: 999903,
  total: 999999,
};

function periodSortKey(period: string | null | undefined): number {
  if (!period) return -1;
  const lower = period.toLowerCase().trim();
  if (lower in SYNTHETIC_PERIODS) return SYNTHETIC_PERIODS[lower];

  // FY YYYY / FYNN
  const fy = lower.match(/^fy\s*'?(\d{2,4})$/);
  if (fy) {
    const yr = parseInt(fy[1], 10);
    const fullYear = yr < 100 ? 2000 + yr : yr;
    return fullYear * 100 + 12; // year-end
  }
  // Q1 2025 / Q1-25
  const q = lower.match(/^q([1-4])[\s'-]*(\d{2,4})$/);
  if (q) {
    const fullYear = parseInt(q[2], 10) < 100 ? 2000 + parseInt(q[2], 10) : parseInt(q[2], 10);
    return fullYear * 100 + parseInt(q[1], 10) * 3;
  }
  // "Sep '25", "Sep 2025", "Sep-25", "May 2023"
  const m = lower.match(/^([a-z]{3,})[\s'-]+(\d{2,4})$/);
  if (m && m[1].slice(0, 3) in MONTHS) {
    const fullYear = parseInt(m[2], 10) < 100 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);
    return fullYear * 100 + MONTHS[m[1].slice(0, 3)];
  }
  // YYYY-MM
  const ym = lower.match(/^(\d{4})-(\d{1,2})$/);
  if (ym) return parseInt(ym[1], 10) * 100 + parseInt(ym[2], 10);
  // Bare year
  const yr = lower.match(/^(\d{4})$/);
  if (yr) return parseInt(yr[1], 10) * 100 + 12;
  return 0;
}

export const inputSchema = z.object({});

export function makeGetDealFinancialsTool(dealId: string, _orgId: string) {
  return {
    type: 'custom' as const,
    name: 'get_deal_financials',
    description: 'Fetch extracted financial statements and deal-level metrics (revenue, EBITDA, IRR, MoM). Use when user asks about financials, numbers, revenue trends, or analysis.',
    input_schema: { type: 'object', properties: {} },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async () => {
      try {
        // Fetch ALL statements (active + inactive/needs_review) so chat sees
        // what the user sees. Column names MUST match the Prisma schema:
        // `lineItems` (Record<string, number | null>), not `extractedData`;
        // `extractionConfidence` (0-100), not `confidence`.
        //
        // Pull `unitScale` + `currency` so we can render values at the right
        // magnitude (e.g. ACTUALS 6900 → "$6.9K", MILLIONS 6.9 → "$6.9M").
        // Before this fix, every value was rendered with a hardcoded "M"
        // suffix — a $6,900 deal showed as "$6,900M" in the agent's view.
        // Note: Supabase orders `period` alphabetically (it's a TEXT column),
        // which interleaves Sep/Oct/Nov years (e.g., "Apr '24" sorts before
        // "Sep '23"). We re-sort chronologically in JS via periodSortKey
        // below so the agent sees periods in real time order.
        const { data: statements, error } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, lineItems, unitScale, currency, extractionConfidence, extractionSource, isActive')
          .eq('dealId', dealId);

        if (error) {
          log.error('getDealFinancials tool: supabase select failed', { dealId, error });
          return `Error fetching financial statements: ${error.message}. Treat as a transient backend failure — do NOT tell the user "no financials were extracted" based on this response.`;
        }

        if (!statements || statements.length === 0) {
          return 'No financial statements extracted for this deal yet.';
        }

        const activeStatements = statements.filter(s => s.isActive);
        const inactiveStatements = statements.filter(s => !s.isActive);

        const summary: string[] = [
          `Found ${statements.length} financial statements (${activeStatements.length} active, ${inactiveStatements.length} pending review). Active + pending statements ALL count as extracted data — render charts from them.`,
        ];

        // Group by type, then sort each group chronologically (newest first).
        // Render ALL periods — the previous slice(0, 8) silently hid 72 of
        // 80 statements on deals like Website Speedy, so the agent saw a
        // random temporal slice and couldn't chart specific months the
        // user asked about. Per-row format is one compact line (revenue
        // + EBITDA inline), keeping the payload manageable for many-period
        // deals (80 periods × ~120 chars ≈ 10KB — well within context).
        const byType: Record<string, typeof statements> = {};
        for (const s of statements) {
          byType[s.statementType] = byType[s.statementType] || [];
          byType[s.statementType].push(s);
        }

        for (const [type, stmts] of Object.entries(byType)) {
          stmts.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
          summary.push(`\n**${type}** (${stmts.length} periods, newest first):`);
          for (const s of stmts) {
            const items = s.lineItems && typeof s.lineItems === 'object'
              ? (s.lineItems as Record<string, number | null>)
              : {};
            const entries = Object.entries(items).filter(([, v]) => v !== null && v !== undefined);
            const revenue = entries.find(([k]) =>
              k.toLowerCase().includes('revenue') || k.toLowerCase().includes('net sales')
            );
            const ebitda = entries.find(([k]) => k.toLowerCase().includes('ebitda'));
            const statusNote = s.isActive ? '' : ' (pending)';

            // Render at the row's actual unitScale + currency. ACTUALS keeps
            // raw dollars, MILLIONS expands to $X.XM, etc — drops the
            // previous always-"M" suffix that mis-tagged every non-MILLIONS
            // statement in the agent's view.
            //
            // Read-time safety net: if the stored unitScale is MILLIONS/
            // THOUSANDS/BILLIONS but the row's _source quote contains a
            // literal raw-dollar amount matching the value (the "DMpro
            // LTM/Current Month" stale-row bug), flip to ACTUALS before
            // formatting so the agent never quotes a mis-scaled number.
            const rawScale = (s.unitScale ?? 'ACTUALS') as UnitScale;
            const rowScale = correctMistaggedUnitScale(
              rawScale,
              s.lineItems as Record<string, unknown> | null,
            );
            const rowCurrency = s.currency ?? 'USD';
            const parts: string[] = [];
            if (revenue) parts.push(`rev ${formatFinancialValue(revenue[1] as number, rowScale, { currency: rowCurrency })}`);
            if (ebitda) parts.push(`ebitda ${formatFinancialValue(ebitda[1] as number, rowScale, { currency: rowCurrency })}`);
            const dataPart = parts.length > 0 ? parts.join(', ') : `${entries.length} line items`;
            summary.push(
              `  - ${s.period}: ${dataPart} [${rowScale} ${rowCurrency}, ${s.extractionConfidence ?? '—'}%${statusNote}]`
            );
          }
        }

        // Also fetch deal-level financial metrics — including the cached
        // ACTUAL-DOLLAR columns so formatDealHeadline picks the right scale.
        const { data: deal } = await supabase
          .from('Deal')
          .select('revenue, ebitda, dealSize, currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, cachedPeriod, cachedCurrency, irrProjected, mom')
          .eq('id', dealId)
          .single();

        if (deal) {
          summary.push('\n**Deal-Level Metrics:**');
          const headline = formatDealHeadline(deal);
          if (headline.revenue) summary.push(`  Revenue: ${headline.revenue}${headline.cachedPeriod ? ` (${headline.cachedPeriod})` : ''}`);
          if (headline.ebitda)  summary.push(`  EBITDA: ${headline.ebitda}${headline.cachedPeriod ? ` (${headline.cachedPeriod})` : ''}`);
          if (headline.dealSize) summary.push(`  Deal Size: ${headline.dealSize}`);
          if (headline.ebitdaMargin) summary.push(`  EBITDA Margin: ${headline.ebitdaMargin}`);
          if (deal.irrProjected) summary.push(`  Projected IRR: ${deal.irrProjected}%`);
          if (deal.mom) summary.push(`  MoM: ${deal.mom}x`);
        }

        return summary.join('\n');
      } catch (error) {
        log.error('getDealFinancials tool error', error);
        return 'Error fetching financial data.';
      }
    },
  };
}
