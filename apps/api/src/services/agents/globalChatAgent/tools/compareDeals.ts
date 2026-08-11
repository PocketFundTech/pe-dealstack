// ─── compare_deals tool (ORG-SCOPED) ──────────────────────────────
// Org-scoped adaptation of dealChatAgent/tools/compareDeals. The global
// agent has no "current deal", so the user names the deal(s) to compare.
// Modes:
//   - two names  → side-by-side of dealA vs dealB
//   - one name   → that deal vs portfolio averages + same-industry peers
//   - no names   → portfolio averages + stage/industry breakdown
// All figures use CANONICAL cached actual-dollar columns.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { formatFinancialValue } from '../../../../utils/financialFormat.js';

type DealRow = {
  id: string; name: string; industry: string | null; stage: string; status: string | null;
  currency: string | null; cachedCurrency: string | null;
  cachedRevenue: number | null; cachedEbitda: number | null; cachedEbitdaMargin: number | null;
  irrProjected: number | null; mom: number | null;
};

const SELECT = 'id, name, industry, stage, status, currency, cachedCurrency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, irrProjected, mom';

function metricLine(d: DealRow): string {
  const currency = d.cachedCurrency || d.currency || 'USD';
  const fin: string[] = [];
  fin.push(`Rev ${d.cachedRevenue != null ? formatFinancialValue(d.cachedRevenue, 'ACTUALS', { currency }) : 'N/A'}`);
  fin.push(`EBITDA ${d.cachedEbitda != null ? formatFinancialValue(d.cachedEbitda, 'ACTUALS', { currency }) : 'N/A'}`);
  if (d.cachedEbitdaMargin != null) fin.push(`Margin ${d.cachedEbitdaMargin.toFixed(1)}%`);
  fin.push(`IRR ${d.irrProjected != null ? d.irrProjected + '%' : 'N/A'}`);
  fin.push(`MoM ${d.mom != null ? d.mom + 'x' : 'N/A'}`);
  return fin.join(', ');
}

export function makeCompareDealsTool(orgId: string) {
  return tool(
    async ({ dealA, dealB }) => {
      try {
        const { data: allRaw, error } = await supabase
          .from('Deal')
          .select(SELECT)
          .eq('organizationId', orgId)
          .order('updatedAt', { ascending: false })
          .limit(500);
        if (error) {
          log.error('compareDeals(org) tool: select failed', { orgId, error });
          return `Error fetching deals: ${error.message}.`;
        }
        const all = (allRaw || []) as DealRow[];
        if (all.length === 0) return 'No deals in the portfolio to compare.';
        const active = all.filter(d => d.status !== 'PASSED' && d.stage !== 'CLOSED_LOST');

        const resolve = (name: string): DealRow | null => {
          const lower = name.toLowerCase();
          const matches = all.filter(d => d.name && d.name.toLowerCase().includes(lower))
            .sort((a, b) => b.name.length - a.name.length);
          return matches.find(d => d.name.toLowerCase() === lower) ?? matches[0] ?? null;
        };

        const parts: string[] = [];

        if (dealA && dealB) {
          const a = resolve(dealA);
          const b = resolve(dealB);
          if (!a) return `Could not find a deal matching "${dealA}".`;
          if (!b) return `Could not find a deal matching "${dealB}".`;
          parts.push(`**Comparison: ${a.name} vs ${b.name}**\n`);
          parts.push(`**${a.name}** (${a.industry || 'N/A'} · ${a.stage})`);
          parts.push(`  ${metricLine(a)}\n`);
          parts.push(`**${b.name}** (${b.industry || 'N/A'} · ${b.stage})`);
          parts.push(`  ${metricLine(b)}`);
          return parts.join('\n');
        }

        // Portfolio averages over canonical figures.
        const withRev = active.filter(d => d.cachedRevenue != null);
        const withEb = active.filter(d => d.cachedEbitda != null);
        const avgRev = withRev.length ? withRev.reduce((s, d) => s + (d.cachedRevenue || 0), 0) / withRev.length : 0;
        const avgEb = withEb.length ? withEb.reduce((s, d) => s + (d.cachedEbitda || 0), 0) / withEb.length : 0;

        if (dealA) {
          const a = resolve(dealA);
          if (!a) return `Could not find a deal matching "${dealA}".`;
          parts.push(`**${a.name}** (${a.industry || 'N/A'} · ${a.stage})`);
          parts.push(`  ${metricLine(a)}\n`);
          parts.push(`**Portfolio Averages (${active.length} active deals):**`);
          parts.push(`  Avg Revenue: ${formatFinancialValue(avgRev, 'ACTUALS', { currency: 'USD' })} (across ${withRev.length} deals)`);
          parts.push(`  Avg EBITDA: ${formatFinancialValue(avgEb, 'ACTUALS', { currency: 'USD' })} (across ${withEb.length} deals)`);
          const peers = active.filter(d => d.industry && d.industry === a.industry && d.id !== a.id);
          if (peers.length) {
            parts.push(`\n**Same Industry (${a.industry}, ${peers.length} peers):**`);
            for (const p of peers.slice(0, 5)) parts.push(`  - ${p.name}: ${metricLine(p)}`);
          }
          if (a.cachedRevenue != null && withRev.length >= 3) {
            const rank = withRev.filter(d => (d.cachedRevenue || 0) < a.cachedRevenue!).length;
            const pct = Math.round((rank / withRev.length) * 100);
            parts.push(`\nRevenue Percentile: ${pct}th of the portfolio`);
          }
          return parts.join('\n');
        }

        // No names — portfolio snapshot.
        parts.push(`**Portfolio Snapshot (${active.length} active deals):**`);
        parts.push(`  Avg Revenue: ${formatFinancialValue(avgRev, 'ACTUALS', { currency: 'USD' })} (across ${withRev.length} deals)`);
        parts.push(`  Avg EBITDA: ${formatFinancialValue(avgEb, 'ACTUALS', { currency: 'USD' })} (across ${withEb.length} deals)`);
        const stageCount: Record<string, number> = {};
        for (const d of active) stageCount[d.stage] = (stageCount[d.stage] || 0) + 1;
        parts.push(`  By Stage: ${Object.entries(stageCount).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
        return parts.join('\n');
      } catch (error) {
        log.error('compareDeals(org) tool error', error);
        return 'Error comparing deals.';
      }
    },
    {
      name: 'compare_deals',
      description: 'Compare deals across the firm. Pass two deal names (dealA, dealB) for a side-by-side; pass one name (dealA) to compare it against portfolio averages and same-industry peers; pass neither for a portfolio snapshot. Uses canonical actual-dollar financials.',
      schema: z.object({
        dealA: z.string().optional().describe('First deal name to compare (or the single deal to benchmark against the portfolio).'),
        dealB: z.string().optional().describe('Second deal name for a head-to-head comparison.'),
      }),
    }
  );
}
