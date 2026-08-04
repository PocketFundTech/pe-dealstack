// ─── get_analysis_summary tool ───────────────────────────────────
// Runs the PE analysis pipeline (QoE, red flags, ratios) and returns
// a Markdown summary.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { analyzeFinancials } from '../../../analysis/index.js';

const inputSchema = z.object({});

export function makeGetAnalysisSummaryTool(dealId: string, _orgId: string) {
  return {
    type: 'custom' as const,
    name: 'get_analysis_summary',
    description: 'Run and fetch the PE analysis summary: Quality of Earnings score, red flags, key financial ratios. Use when the user asks about QoE, red flags, analysis results, or financial health.',
    input_schema: { type: 'object', properties: {} },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async () => {
      try {
        const { data: statements } = await supabase
          .from('FinancialStatement')
          .select('*')
          .eq('dealId', dealId)
          .eq('isActive', true);

        if (!statements || statements.length === 0) {
          return 'No financial statements available for analysis. Extract financials first.';
        }

        const analysis = await analyzeFinancials(dealId, statements);
        const parts: string[] = [];

        // QoE Score
        if (analysis.qoe) {
          parts.push(`**Quality of Earnings Score: ${analysis.qoe.score}/100**`);
          parts.push(analysis.qoe.summary);
          if (analysis.qoe.flags?.length) {
            parts.push(`\nQoE Flags:\n${analysis.qoe.flags.map((f: any) => `- [${f.severity}] ${f.label}: ${f.description}`).join('\n')}`);
          }
        }

        // Red Flags
        if (analysis.redFlags?.length) {
          parts.push(`\n**Red Flags (${analysis.redFlags.length}):**`);
          for (const rf of analysis.redFlags.slice(0, 8)) {
            parts.push(`- [${rf.severity}] ${rf.title}: ${rf.detail}`);
          }
        }

        // Key Ratios (grouped by category)
        if (analysis.ratios?.length) {
          parts.push(`\n**Key Ratios:**`);
          for (const group of analysis.ratios.slice(0, 5)) {
            parts.push(`\n*${group.category}:*`);
            for (const r of group.ratios.slice(0, 4)) {
              const latest = r.periods?.[0];
              const val = latest?.value != null ? latest.value.toFixed(2) : '—';
              parts.push(`- ${r.name}: ${val}${r.unit || ''} (${r.trend})`);
            }
          }
        }

        return parts.join('\n') || 'Analysis ran but produced no results.';
      } catch (error) {
        log.error('getAnalysisSummary tool error', error);
        return 'Error running analysis.';
      }
    },
  };
}
