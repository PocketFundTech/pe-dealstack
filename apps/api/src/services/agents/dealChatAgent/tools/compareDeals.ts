// ─── compare_deals tool ──────────────────────────────────────────
// Compare current deal against the rest of the org's portfolio.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export const inputSchema = z.object({
  targetDealName: z.string().optional().describe('Name of a specific deal to compare against (e.g., "Neen AI", "Buffer"). Leave empty for general portfolio comparison.'),
});

export function makeCompareDealsTool(dealId: string, orgId: string) {
  return {
    type: 'custom' as const,
    name: 'compare_deals',
    description: 'Compare the current deal against other deals in the portfolio. Optionally compare with a specific deal by name. Shows metrics side-by-side, portfolio averages, and rankings.',
    input_schema: {
      type: 'object',
      properties: {
        targetDealName: {
          type: 'string',
          description: 'Name of a specific deal to compare against (e.g., "Neen AI", "Buffer"). Leave empty for general portfolio comparison.',
        },
      },
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ targetDealName }: z.infer<typeof inputSchema>) => {
      try {
        // Get current deal
        const { data: currentDeal } = await supabase
          .from('Deal')
          .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
          .eq('id', dealId)
          .single();

        if (!currentDeal) return 'Deal not found.';

        // Get all comparable deals in the org
        const { data: allOrgDeals } = await supabase
          .from('Deal')
          .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
          .eq('organizationId', orgId)
          .neq('id', dealId)
          .order('updatedAt', { ascending: false })
          .limit(20);

        if (!allOrgDeals || allOrgDeals.length === 0) return 'No other deals in the portfolio to compare against.';

        // If user asked to compare with a specific deal, find it
        let targetDeal = null;
        if (targetDealName) {
          const nameSearch = targetDealName.toLowerCase();
          targetDeal = allOrgDeals.find(d => d.name.toLowerCase().includes(nameSearch));

          if (!targetDeal) {
            // Also search by exact match in DB (might be in a different org scope or inactive)
            const { data: found } = await supabase
              .from('Deal')
              .select('id, name, industry, revenue, ebitda, dealSize, irrProjected, mom, stage')
              .eq('organizationId', orgId)
              .ilike('name', `%${targetDealName}%`)
              .limit(1);
            targetDeal = found?.[0] || null;
          }
        }

        const parts: string[] = [`**Comparison: ${currentDeal.name}**\n`];

        // Current deal metrics
        parts.push('**Current Deal:**');
        parts.push(`  Industry: ${currentDeal.industry || 'N/A'}, Revenue: $${currentDeal.revenue || 0}M, EBITDA: $${currentDeal.ebitda || 0}M`);
        parts.push(`  Deal Size: $${currentDeal.dealSize || 0}M, IRR: ${currentDeal.irrProjected || 'N/A'}%, MoM: ${currentDeal.mom || 'N/A'}x\n`);

        // Specific deal comparison if requested
        if (targetDeal) {
          parts.push(`**${targetDeal.name}:**`);
          parts.push(`  Industry: ${targetDeal.industry || 'N/A'}, Revenue: $${targetDeal.revenue || 0}M, EBITDA: $${targetDeal.ebitda || 0}M`);
          parts.push(`  Deal Size: $${targetDeal.dealSize || 0}M, IRR: ${targetDeal.irrProjected || 'N/A'}%, MoM: ${targetDeal.mom || 'N/A'}x`);
          parts.push(`  Stage: ${targetDeal.stage}\n`);
        } else if (targetDealName) {
          parts.push(`Note: Could not find a deal matching "${targetDealName}" in the portfolio.\n`);
        }

        // Portfolio averages
        const withRevenue = allOrgDeals.filter(d => d.revenue);
        const withEbitda = allOrgDeals.filter(d => d.ebitda);
        const avgRevenue = withRevenue.length > 0 ? withRevenue.reduce((s, d) => s + (d.revenue || 0), 0) / withRevenue.length : 0;
        const avgEbitda = withEbitda.length > 0 ? withEbitda.reduce((s, d) => s + (d.ebitda || 0), 0) / withEbitda.length : 0;

        parts.push(`**Portfolio Averages (${allOrgDeals.length} deals):**`);
        parts.push(`  Avg Revenue: $${avgRevenue.toFixed(1)}M, Avg EBITDA: $${avgEbitda.toFixed(1)}M`);

        const sameIndustry = allOrgDeals.filter(d => d.industry === currentDeal.industry);
        if (sameIndustry.length > 0) {
          parts.push(`\n**Same Industry (${currentDeal.industry}, ${sameIndustry.length} deals):**`);
          for (const d of sameIndustry.slice(0, 5)) {
            parts.push(`  - ${d.name}: Revenue $${d.revenue || 0}M, EBITDA $${d.ebitda || 0}M, ${d.stage}`);
          }
        }

        // Percentile rankings
        if (currentDeal.revenue && withRevenue.length >= 3) {
          const rank = withRevenue.filter(d => (d.revenue || 0) < currentDeal.revenue!).length;
          const percentile = Math.round((rank / withRevenue.length) * 100);
          parts.push(`\nRevenue Percentile: ${percentile}th (${rank + 1} of ${withRevenue.length + 1})`);
        }

        return parts.join('\n');
      } catch (error) {
        log.error('compareDeals tool error', error);
        return 'Error comparing deals.';
      }
    },
  };
}
