// ─── search_deals tool (ORG-SCOPED) ───────────────────────────────
// List/filter the organization's deals by stage / sector / financials.
// This is the org-scoped analogue of the per-deal agent's data tools —
// instead of one dealId it ranges over every deal in the org. Financial
// figures come from the CANONICAL cachedRevenue / cachedEbitda columns
// (actual dollars, unit-applied — see deal-cache-migration.sql), NOT the
// legacy unscaled revenue/ebitda columns.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { formatFinancialValue } from '../../../../utils/financialFormat.js';

const STAGES = [
  'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED',
  'LOI_NEGOTIATION', 'CLOSING', 'CLOSED_WON', 'CLOSED_LOST', 'PASSED',
] as const;

export function makeSearchDealsTool(orgId: string) {
  return tool(
    async ({ stage, sector, minRevenue, minEbitda, includeInactive, limit }) => {
      try {
        const cap = Math.min(limit ?? 25, 50);
        let query = supabase
          .from('Deal')
          .select('id, name, stage, status, industry, currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, cachedPeriod, cachedCurrency, irrProjected, mom, dealSize')
          .eq('organizationId', orgId)
          .order('updatedAt', { ascending: false })
          .limit(500); // pre-filter pool; JS-side financial filters applied below

        if (stage) query = query.eq('stage', stage);

        const { data: deals, error } = await query;
        if (error) {
          log.error('searchDeals tool: supabase select failed', { orgId, error });
          return `Error fetching deals: ${error.message}. Treat as a transient backend failure.`;
        }
        if (!deals || deals.length === 0) {
          return 'No deals found in the organization' + (stage ? ` at stage ${stage}.` : '.');
        }

        let filtered = deals;
        if (!includeInactive) {
          filtered = filtered.filter(d => d.status !== 'PASSED' && d.stage !== 'CLOSED_LOST');
        }
        if (sector) {
          const s = sector.toLowerCase();
          filtered = filtered.filter(d => (d.industry || '').toLowerCase().includes(s));
        }
        // Financial filters operate on CANONICAL actual-dollar figures. The
        // model is told to pass actual dollars (e.g. 5000000 for $5M).
        if (typeof minRevenue === 'number') {
          filtered = filtered.filter(d => d.cachedRevenue != null && d.cachedRevenue >= minRevenue);
        }
        if (typeof minEbitda === 'number') {
          filtered = filtered.filter(d => d.cachedEbitda != null && d.cachedEbitda >= minEbitda);
        }

        if (filtered.length === 0) {
          return 'No deals matched the given filters.';
        }

        const shown = filtered.slice(0, cap);
        const lines: string[] = [
          `Found ${filtered.length} matching deal(s)${filtered.length > cap ? ` (showing first ${cap})` : ''}:`,
          '',
        ];
        for (const d of shown) {
          const currency = d.cachedCurrency || d.currency || 'USD';
          const segs: string[] = [`**${d.name}** — ${d.industry || 'N/A'} · ${d.stage}`];
          const fin: string[] = [];
          if (d.cachedRevenue != null) fin.push(`Rev ${formatFinancialValue(d.cachedRevenue, 'ACTUALS', { currency })}`);
          if (d.cachedEbitda != null) fin.push(`EBITDA ${formatFinancialValue(d.cachedEbitda, 'ACTUALS', { currency })}`);
          if (d.cachedEbitdaMargin != null) fin.push(`Margin ${d.cachedEbitdaMargin.toFixed(1)}%`);
          if (d.irrProjected != null) fin.push(`IRR ${d.irrProjected}%`);
          if (d.mom != null) fin.push(`MoM ${d.mom}x`);
          if (fin.length > 0) {
            segs.push(`  ${fin.join(', ')}${d.cachedPeriod ? ` [${d.cachedPeriod}]` : ''}`);
          } else {
            segs.push('  (no canonical financials extracted yet)');
          }
          lines.push(segs.join('\n'));
        }
        return lines.join('\n');
      } catch (error) {
        log.error('searchDeals tool error', error);
        return 'Error searching deals.';
      }
    },
    {
      name: 'search_deals',
      description: 'List and filter the firm\'s deals across the whole organization by pipeline stage, sector/industry, and minimum financials. Use when the user asks "which deals...", "show me deals in...", "deals over $X revenue", pipeline overviews, or to find a deal by attribute. Financial figures are canonical actual dollars.',
      schema: z.object({
        stage: z.enum(STAGES).optional().describe('Filter to a single pipeline stage'),
        sector: z.string().optional().describe('Industry / sector substring to match (e.g. "software", "healthcare")'),
        minRevenue: z.number().optional().describe('Minimum annual revenue in ACTUAL DOLLARS (e.g. 5000000 for $5M)'),
        minEbitda: z.number().optional().describe('Minimum EBITDA in ACTUAL DOLLARS (e.g. 1000000 for $1M)'),
        includeInactive: z.boolean().optional().describe('Include PASSED / CLOSED_LOST deals (default false)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max deals to return (default 25)'),
      }),
    }
  );
}
