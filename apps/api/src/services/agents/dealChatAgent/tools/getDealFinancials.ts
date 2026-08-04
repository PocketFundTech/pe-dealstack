// ─── get_deal_financials tool ─────────────────────────────────────
// Reads extracted FinancialStatement rows + deal-level metrics and
// formats them as Markdown for the chat agent.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

const inputSchema = z.object({});

export function makeGetDealFinancialsTool(dealId: string, _orgId: string) {
  return {
    type: 'custom' as const,
    name: 'get_deal_financials',
    description: 'Fetch extracted financial statements and deal-level metrics (revenue, EBITDA, IRR, MoM). Use when user asks about financials, numbers, revenue trends, or analysis.',
    input_schema: { type: 'object', properties: {} },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async () => {
      try {
        // Fetch ALL statements (active + inactive/needs_review) so chat sees what the user sees
        const { data: statements } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, extractedData, confidence, extractionSource, isActive')
          .eq('dealId', dealId)
          .order('period', { ascending: false });

        if (!statements || statements.length === 0) {
          return 'No financial statements extracted for this deal yet.';
        }

        const activeStatements = statements.filter(s => s.isActive);
        const inactiveStatements = statements.filter(s => !s.isActive);

        const summary: string[] = [`Found ${statements.length} financial statements (${activeStatements.length} active, ${inactiveStatements.length} pending review):`];

        // Group by type
        const byType: Record<string, typeof statements> = {};
        for (const s of statements) {
          byType[s.statementType] = byType[s.statementType] || [];
          byType[s.statementType].push(s);
        }

        for (const [type, stmts] of Object.entries(byType)) {
          summary.push(`\n**${type}** (${stmts.length} periods):`);
          for (const s of stmts.slice(0, 5)) {
            const data = s.extractedData as any;
            const items = Array.isArray(data) ? data : [];
            const revenue = items.find((i: any) => i.label?.toLowerCase().includes('revenue'));
            const ebitda = items.find((i: any) => i.label?.toLowerCase().includes('ebitda'));
            const lineCount = items.length;
            const statusNote = s.isActive ? '' : ' (pending merge review)';

            summary.push(`  - ${s.period}: ${lineCount} line items, confidence ${s.confidence}%, source: ${s.extractionSource}${statusNote}`);
            if (revenue) summary.push(`    Revenue: $${revenue.value}M`);
            if (ebitda) summary.push(`    EBITDA: $${ebitda.value}M`);
          }
        }

        // Also fetch deal-level financial metrics
        const { data: deal } = await supabase
          .from('Deal')
          .select('revenue, ebitda, dealSize, irrProjected, mom')
          .eq('id', dealId)
          .single();

        if (deal) {
          summary.push('\n**Deal-Level Metrics:**');
          if (deal.revenue) summary.push(`  Revenue: $${deal.revenue}M`);
          if (deal.ebitda) summary.push(`  EBITDA: $${deal.ebitda}M`);
          if (deal.dealSize) summary.push(`  Deal Size: $${deal.dealSize}M`);
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
