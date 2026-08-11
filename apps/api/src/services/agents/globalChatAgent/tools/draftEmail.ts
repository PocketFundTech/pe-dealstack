// ─── draft_email tool (ORG-SCOPED) ────────────────────────────────
// Org-scoped adaptation of dealChatAgent/tools/draftEmail. No fixed deal —
// the email is drafted at the org level (dealId optional). Returns the
// drafted subject/body inline AND emits a PROPOSED ACTION envelope:
//   { type: "draftEmail", label, needsConfirm: false, payload: { to?, subject, body } }
// so the frontend can open a compose window pre-filled with the draft.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { log } from '../../../../utils/logger.js';
import { generateEmailDraft } from '../../emailDrafter/index.js';

export function makeDraftEmailTool(orgId: string) {
  return tool(
    async ({ recipient, purpose, tone, to }) => {
      try {
        const result = await generateEmailDraft({
          organizationId: orgId,
          dealId: null,
          purpose,
          context: recipient,
          tone: tone || 'formal',
        });

        if (result.status === 'failed') {
          return `Email draft failed: ${result.error || 'Unknown error'}`;
        }

        const action = {
          type: 'draftEmail',
          label: 'Open draft in composer',
          needsConfirm: false,
          payload: {
            ...(to ? { to } : {}),
            subject: result.subject,
            body: result.draft,
          },
        };

        const human: string[] = [`**Subject:** ${result.subject}\n`, result.draft];
        if (result.suggestions.length) human.push(`\n**Suggestions:** ${result.suggestions.join('; ')}`);
        if (!result.isCompliant && result.complianceIssues.length) {
          human.push(`\n**Compliance Notes:** ${result.complianceIssues.join('; ')}`);
        }

        // Emit BOTH the readable draft and the machine action envelope. The
        // agent runner parses the trailing JSON envelope; the LLM echoes the
        // human-readable part in its answer.
        return `${human.join('\n')}\n\n${JSON.stringify({ action })}`;
      } catch (error) {
        log.error('draftEmail(org) tool error', error);
        return 'Failed to draft email. Please try again.';
      }
    },
    {
      name: 'draft_email',
      description: 'Draft a professional email at the firm level (not tied to a specific deal). Returns subject + body and proposes opening it in the composer. Use for general outreach, LP updates, broker intros, etc.',
      schema: z.object({
        purpose: z.string().describe('Purpose of the email (e.g. "intro to a new broker", "quarterly LP update", "request a meeting").'),
        recipient: z.string().describe('Who the email is for / context about the audience (e.g. "a broker we just met", "our LPs").'),
        to: z.string().optional().describe('Recipient email address, if the user gave one.'),
        tone: z.enum(['formal', 'casual', 'direct']).default('formal').describe('Email tone.'),
      }),
    }
  );
}
