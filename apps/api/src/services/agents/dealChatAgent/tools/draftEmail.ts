// ─── draft_email tool ────────────────────────────────────────────
// Calls the emailDrafter agent and surfaces the result + compliance.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { log } from '../../../../utils/logger.js';
import { generateEmailDraft } from '../../emailDrafter/index.js';

const inputSchema = z.object({
  recipient: z.string().describe('Who the email is for (e.g., "management team", "broker", "legal counsel")'),
  purpose: z.string().describe('Purpose of the email (e.g., "request additional financials", "schedule site visit", "follow up on LOI")'),
  tone: z.enum(['formal', 'casual', 'direct']).default('formal').describe('Email tone'),
});

export function makeDraftEmailTool(dealId: string, orgId: string) {
  return {
    type: 'custom' as const,
    name: 'draft_email',
    description: 'Draft a professional email related to this deal. Returns subject line, body, and compliance check.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Who the email is for (e.g., "management team", "broker", "legal counsel")' },
        purpose: { type: 'string', description: 'Purpose of the email (e.g., "request additional financials", "schedule site visit", "follow up on LOI")' },
        tone: { type: 'string', enum: ['formal', 'casual', 'direct'], description: 'Email tone' },
      },
      required: ['recipient', 'purpose'],
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ recipient, purpose, tone }: z.infer<typeof inputSchema>) => {
      try {
        const result = await generateEmailDraft({
          organizationId: orgId,
          dealId,
          purpose,
          context: recipient,
          tone: tone || 'formal',
        });

        if (result.status === 'failed') {
          return `Email draft failed: ${result.error || 'Unknown error'}`;
        }

        const parts = [
          `**Subject:** ${result.subject}\n`,
          result.draft,
        ];
        if (result.suggestions.length) {
          parts.push(`\n**Suggestions:** ${result.suggestions.join('; ')}`);
        }
        if (!result.isCompliant && result.complianceIssues.length) {
          parts.push(`\n**Compliance Notes:** ${result.complianceIssues.join('; ')}`);
        }

        return parts.join('\n');
      } catch (error) {
        log.error('draftEmail tool error', error);
        return 'Failed to draft email. Please try again.';
      }
    },
  };
}
