// ─── add_note tool ───────────────────────────────────────────────
// Append a note / call log / email log / meeting note to the deal
// activity feed.
//
// Built as a plain BetaRunnableTool object (input_schema hand-written)
// rather than via the SDK's betaZodTool() helper — that helper calls
// z.toJSONSchema(), a Zod v4-only API this repo's installed Zod 3.x
// doesn't expose on the bare `zod` import. Zod's own .parse() (used
// below for runtime validation/defaults) is unaffected — only the
// schema-to-JSON-Schema conversion is broken, so it's replaced here
// with a hand-written schema, same as extractionSchema.ts already
// does for Phase 1.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

const inputSchema = z.object({
  content: z.string().describe('The note content'),
  type: z.enum(['NOTE_ADDED', 'CALL_LOGGED', 'EMAIL_SENT', 'MEETING_SCHEDULED']).default('NOTE_ADDED').describe('Type of activity'),
});

export function makeAddNoteTool(dealId: string, _orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'add_note',
    description: 'Add a note, call log, email log, or meeting note to the deal activity feed.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note content' },
        type: {
          type: 'string',
          enum: ['NOTE_ADDED', 'CALL_LOGGED', 'EMAIL_SENT', 'MEETING_SCHEDULED'],
          description: 'Type of activity',
        },
      },
      required: ['content'],
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ content, type }: z.infer<typeof inputSchema>) => {
      try {
        await supabase.from('Activity').insert({
          dealId,
          type: type || 'NOTE_ADDED',
          title: type === 'CALL_LOGGED' ? 'Call Logged' : type === 'EMAIL_SENT' ? 'Email Logged' : type === 'MEETING_SCHEDULED' ? 'Meeting Scheduled' : 'Note Added',
          description: content,
        });
        emit({ type: 'side_effect', effect: { type: 'note_added' } });
        return JSON.stringify({ success: true, type: 'note_added' });
      } catch (error) {
        log.error('addNote tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to add note' });
      }
    },
  };
}
