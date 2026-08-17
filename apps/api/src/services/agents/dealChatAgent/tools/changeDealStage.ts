// ─── change_deal_stage tool ──────────────────────────────────────
// Advance / move back / close the deal pipeline stage.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

const STAGES = [
  'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED',
  'LOI_NEGOTIATION', 'CLOSING', 'CLOSED_WON', 'CLOSED_LOST', 'PASSED',
] as const;

export const inputSchema = z.object({
  stage: z.enum(STAGES),
  reason: z.string().optional().describe('Optional reason for the stage change'),
});

export function makeChangeDealStageTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'change_deal_stage',
    description: 'Change the deal pipeline stage. Use when the user asks to advance, move back, or close a deal. Stages flow: INITIAL_REVIEW → DUE_DILIGENCE → IOI_SUBMITTED → LOI_NEGOTIATION → CLOSING → CLOSED_WON. Terminal stages: CLOSED_WON, CLOSED_LOST, PASSED.',
    input_schema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: [...STAGES] },
        reason: { type: 'string', description: 'Optional reason for the stage change' },
      },
      required: ['stage'],
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ stage, reason }: z.infer<typeof inputSchema>) => {
      try {
        const { data: deal } = await supabase.from('Deal').select('stage').eq('id', dealId).single();
        if (!deal) return JSON.stringify({ success: false, error: 'Deal not found' });

        const previousStage = deal.stage;
        if (previousStage === stage) {
          return JSON.stringify({ success: false, error: `Deal is already at stage: ${stage}` });
        }

        await supabase.from('Deal').update({ stage, updatedAt: new Date().toISOString() }).eq('id', dealId);
        await supabase.from('Activity').insert({
          dealId,
          type: 'STAGE_CHANGED',
          title: 'Deal Stage Changed',
          description: `${previousStage} → ${stage}${reason ? '. Reason: ' + reason : ''}`,
        });

        emit({ type: 'update', update: { field: 'stage', value: stage, previousStage } });
        return JSON.stringify({ success: true, field: 'stage', value: stage, previousStage });
      } catch (error) {
        log.error('changeDealStage tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to change deal stage' });
      }
    },
  };
}
