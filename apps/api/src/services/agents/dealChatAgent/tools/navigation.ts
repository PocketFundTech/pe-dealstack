// ─── Navigation tools (suggest_action, scroll_to_section) ────────
// Pure-output tools: emit JSON describing where the UI should navigate
// or scroll. Grouped together because they share no DB / agent calls.
//
// Plain BetaRunnableTool objects — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import type { ToolEmit } from '../types.js';

export const suggestActionInputSchema = z.object({
  actionType: z.enum(['create_memo', 'open_data_room', 'upload_document', 'view_financials', 'change_stage']),
  label: z.string().describe('Button label text'),
  description: z.string().optional().describe('Brief explanation of what happens'),
});

export function makeSuggestActionTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'suggest_action',
    description: 'Suggest navigation to another page: create memo, open data room, upload document, view financials, change deal stage.',
    input_schema: {
      type: 'object',
      properties: {
        actionType: {
          type: 'string',
          enum: ['create_memo', 'open_data_room', 'upload_document', 'view_financials', 'change_stage'],
        },
        label: { type: 'string', description: 'Button label text' },
        description: { type: 'string', description: 'Brief explanation of what happens' },
      },
      required: ['actionType', 'label'],
    },
    parse: (input: unknown) => suggestActionInputSchema.parse(input),
    run: async ({ actionType, label, description }: z.infer<typeof suggestActionInputSchema>) => {
      // Routes are web-next paths (not legacy /vdr or /deal.html). Tabs on the
      // deal page are state, not URL — there's no `#financials` route, so we
      // just send users to the deal page and rely on the user to click the
      // right tab. (A future improvement: real route segments per tab.)
      const urlMap: Record<string, string> = {
        create_memo: `/memo-builder?dealId=${dealId}&fromChat=1`,
        open_data_room: `/data-room/${dealId}`,
        upload_document: `/data-room/${dealId}`,
        view_financials: `/deals/${dealId}`,
        change_stage: `/deals/${dealId}`,
      };
      const payload = {
        type: actionType,
        label,
        description,
        url: urlMap[actionType] || `/deals/${dealId}`,
      };
      emit({ type: 'action', action: payload });
      return JSON.stringify(payload);
    },
  };
}

export const scrollToSectionInputSchema = z.object({
  section: z.enum(['financials', 'analysis', 'activity', 'documents', 'risks']).describe('Section to scroll to'),
});

export function makeScrollToSectionTool(_dealId: string, _orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'scroll_to_section',
    description: 'Scroll the deal page to a specific section. Use when the user asks to see or navigate to financials, analysis, documents, activity, or risks.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['financials', 'analysis', 'activity', 'documents', 'risks'],
          description: 'Section to scroll to',
        },
      },
      required: ['section'],
    },
    parse: (input: unknown) => scrollToSectionInputSchema.parse(input),
    run: async ({ section }: z.infer<typeof scrollToSectionInputSchema>) => {
      emit({ type: 'side_effect', effect: { type: 'scroll_to', section } });
      return JSON.stringify({ type: 'scroll_to', section });
    },
  };
}
