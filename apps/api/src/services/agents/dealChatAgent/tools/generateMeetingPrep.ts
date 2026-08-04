// ─── generate_meeting_prep tool ──────────────────────────────────
// Calls the meetingPrep agent and renders the brief as Markdown.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { log } from '../../../../utils/logger.js';
import { generateMeetingPrep } from '../../meetingPrep/index.js';

const inputSchema = z.object({
  attendees: z.string().optional().describe('Who the meeting is with (e.g., "CEO of target company")'),
  topics: z.string().optional().describe('Key topics to cover'),
});

export function makeGenerateMeetingPrepTool(dealId: string, orgId: string) {
  return {
    type: 'custom' as const,
    name: 'generate_meeting_prep',
    description: 'Generate a meeting preparation brief for this deal. Includes talking points, questions, risks, and suggested agenda.',
    input_schema: {
      type: 'object',
      properties: {
        attendees: { type: 'string', description: 'Who the meeting is with (e.g., "CEO of target company")' },
        topics: { type: 'string', description: 'Key topics to cover' },
      },
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ attendees, topics }: z.infer<typeof inputSchema>) => {
      try {
        const brief = await generateMeetingPrep({
          dealId,
          organizationId: orgId,
          meetingTopic: [attendees, topics].filter(Boolean).join('. '),
        });

        const parts = [
          `## ${brief.headline}\n`,
          `**Deal Summary:** ${brief.dealSummary}\n`,
        ];
        if (brief.contactProfile) parts.push(`**Contact:** ${brief.contactProfile}\n`);
        if (brief.keyTalkingPoints.length) parts.push(`**Talking Points:**\n${brief.keyTalkingPoints.map(p => `- ${p}`).join('\n')}\n`);
        if (brief.questionsToAsk.length) parts.push(`**Questions to Ask:**\n${brief.questionsToAsk.map(q => `- ${q}`).join('\n')}\n`);
        if (brief.risksToAddress.length) parts.push(`**Risks to Address:**\n${brief.risksToAddress.map(r => `- ${r}`).join('\n')}\n`);
        if (brief.suggestedAgenda.length) parts.push(`**Suggested Agenda:**\n${brief.suggestedAgenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);

        return parts.join('\n');
      } catch (error) {
        log.error('generateMeetingPrep tool error', error);
        return 'Failed to generate meeting prep. Please try again.';
      }
    },
  };
}
