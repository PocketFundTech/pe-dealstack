// ─── get_deal_financials tool (ORG-SCOPED) ────────────────────────
// Org-scoped analogue of dealChatAgent's get_deal_financials. Because the
// global agent has no fixed dealId, this tool first RESOLVES a deal by name
// within the org, then reads that deal's extracted FinancialStatement rows
// + deal-level cached metrics and formats them as Markdown.
//
// Resolution is fuzzy (case-insensitive substring, longest match wins) and
// returns a disambiguation list when multiple deals match — never silently
// picks the wrong company.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { correctMistaggedUnitScale, formatDealHeadline, formatFinancialValue, type UnitScale } from '../../../../utils/financialFormat.js';
import { periodOrdinal } from '@ai-crm/shared';

// Chronological period sort (mirrors dealChatAgent/tools/getDealFinancials).
const SYNTHETIC_PERIODS: Record<string, number> = {
  ltm: 999900, current: 999901, 'current month': 999902, ttm: 999903, total: 999999,
};
function periodSortKey(period: string | null | undefined): number {
  if (!period) return -1;
  const lower = period.toLowerCase().trim();
  if (lower in SYNTHETIC_PERIODS) return SYNTHETIC_PERIODS[lower];
  // YYYY-MM
  const ym = lower.match(/^(\d{4})-(\d{1,2})$/);
  if (ym) return parseInt(ym[1], 10) * 100 + parseInt(ym[2], 10);
  // Everything else — FY/YTD/LTM/Q/H/month labels, including date-range
  // suffixes like "FY2023 (Jan - Dec 2023)" — via the shared period parser.
  return periodOrdinal(period) ?? 0;
}

export function makeGetDealFinancialsTool(orgId: string) {
  return tool(
    async ({ dealName }) => {
      try {
        // Resolve the deal by name within the org.
        const { data: candidates, error: dealErr } = await supabase
          .from('Deal')
          .select('id, name, stage, status, industry, revenue, ebitda, dealSize, currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, cachedPeriod, cachedCurrency, irrProjected, mom')
          .eq('organizationId', orgId)
          .ilike('name', `%${dealName}%`)
          .limit(10);

        if (dealErr) {
          log.error('getDealFinancials(org) tool: resolve failed', { orgId, error: dealErr });
          return `Error resolving deal: ${dealErr.message}. Treat as a transient backend failure.`;
        }
        if (!candidates || candidates.length === 0) {
          return `No deal matching "${dealName}" found in the organization. Use search_deals to list available deals.`;
        }
        // Prefer the longest (most specific) name match.
        candidates.sort((a, b) => (a.name?.length ?? 0) - (b.name?.length ?? 0));
        const exact = candidates.find(d => d.name?.toLowerCase() === dealName.toLowerCase());
        const deal = exact ?? candidates[0];
        let ambiguityNote = '';
        if (candidates.length > 1 && !exact) {
          const others = candidates.filter(d => d.id !== deal.id).map(d => d.name).join(', ');
          // Still proceed with the best match but disclose alternatives.
          log.debug('getDealFinancials(org): multiple matches', { dealName, picked: deal.name });
          ambiguityNote = `\n\n_Note: "${dealName}" also matched: ${others}. Showing data for **${deal.name}** — ask again with a more specific name to switch._`;
        }

        const { data: statements, error } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, lineItems, unitScale, currency, extractionConfidence, isActive')
          .eq('dealId', deal.id);

        if (error) {
          log.error('getDealFinancials(org) tool: statements select failed', { dealId: deal.id, error });
          return `Error fetching financial statements for ${deal.name}: ${error.message}. Do NOT tell the user "no financials" based on this.`;
        }

        const summary: string[] = [`**${deal.name}** (${deal.industry || 'N/A'} · ${deal.stage})`];

        if (statements && statements.length > 0) {
          const active = statements.filter(s => s.isActive).length;
          summary.push(`Found ${statements.length} financial statements (${active} active, ${statements.length - active} pending review).`);
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
                ? (s.lineItems as Record<string, number | null>) : {};
              const entries = Object.entries(items).filter(([, v]) => v !== null && v !== undefined);
              const revenue = entries.find(([k]) => k.toLowerCase().includes('revenue') || k.toLowerCase().includes('net sales'));
              const ebitda = entries.find(([k]) => k.toLowerCase().includes('ebitda'));
              const statusNote = s.isActive ? '' : ' (pending)';
              const rawScale = (s.unitScale ?? 'ACTUALS') as UnitScale;
              const rowScale = correctMistaggedUnitScale(rawScale, s.lineItems as Record<string, unknown> | null);
              const rowCurrency = s.currency ?? 'USD';
              const parts: string[] = [];
              if (revenue) parts.push(`rev ${formatFinancialValue(revenue[1] as number, rowScale, { currency: rowCurrency })}`);
              if (ebitda) parts.push(`ebitda ${formatFinancialValue(ebitda[1] as number, rowScale, { currency: rowCurrency })}`);
              const dataPart = parts.length > 0 ? parts.join(', ') : `${entries.length} line items`;
              summary.push(`  - ${s.period}: ${dataPart} [${rowScale} ${rowCurrency}, ${s.extractionConfidence ?? '—'}%${statusNote}]`);
            }
          }
        } else {
          summary.push('No extracted financial statements yet — showing deal-level metrics only.');
        }

        summary.push('\n**Deal-Level Metrics (canonical):**');
        const headline = formatDealHeadline(deal);
        if (headline.revenue) summary.push(`  Revenue: ${headline.revenue}${headline.cachedPeriod ? ` (${headline.cachedPeriod})` : ''}`);
        if (headline.ebitda) summary.push(`  EBITDA: ${headline.ebitda}${headline.cachedPeriod ? ` (${headline.cachedPeriod})` : ''}`);
        if (headline.dealSize) summary.push(`  Deal Size: ${headline.dealSize}`);
        if (headline.ebitdaMargin) summary.push(`  EBITDA Margin: ${headline.ebitdaMargin}`);
        if (deal.irrProjected) summary.push(`  Projected IRR: ${deal.irrProjected}%`);
        if (deal.mom) summary.push(`  MoM: ${deal.mom}x`);

        return summary.join('\n') + ambiguityNote;
      } catch (error) {
        log.error('getDealFinancials(org) tool error', error);
        return 'Error fetching financial data.';
      }
    },
    {
      name: 'get_deal_financials',
      description: 'Resolve a deal BY NAME within the firm and fetch its extracted financial statements + canonical deal-level metrics (revenue, EBITDA, IRR, MoM). Use when the user asks about a specific named company\'s financials. Pass the company/deal name the user mentioned.',
      schema: z.object({
        dealName: z.string().describe('The name (or partial name) of the deal/company to look up, e.g. "Neen AI", "Buffer".'),
      }),
    }
  );
}
