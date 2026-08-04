// ─── trigger_financial_extraction tool ───────────────────────────
// Surfaces the best document for extraction and tells the user where
// to click. (Doesn't actually run extraction — just guides.)
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

const inputSchema = z.object({});

export function makeTriggerFinancialExtractionTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'trigger_financial_extraction',
    description: 'Check which documents are available for financial extraction and guide the user to trigger it.',
    input_schema: { type: 'object', properties: {} },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async () => {
      try {
        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type, fileUrl')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false })
          .limit(5);

        if (!docs || docs.length === 0) {
          return 'No documents found for this deal. Please upload a CIM or financial document first.';
        }

        // Find the best document for extraction
        const financialDoc = docs.find(d => d.type === 'FINANCIALS' || d.type === 'CIM') || docs[0];
        const payload = {
          success: true,
          type: 'extraction_triggered',
          documentName: financialDoc.name,
          message: `Financial extraction queued for "${financialDoc.name}". Use the Extract Financials button on the page to run it, or navigate to the financials section.`,
        };
        emit({ type: 'side_effect', effect: { type: 'extraction_triggered', documentName: payload.documentName, message: payload.message } });
        return JSON.stringify(payload);
      } catch (error) {
        log.error('triggerFinancialExtraction tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to trigger extraction' });
      }
    },
  };
}
