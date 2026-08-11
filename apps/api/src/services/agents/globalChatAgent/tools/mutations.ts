// ─── Proposed-mutation tools (ORG-SCOPED, CONFIRM-FIRST) ───────────
// Unlike the per-deal agent (which mutates inline), the global agent NEVER
// writes. Each of these tools returns a PROPOSED ACTION envelope describing
// the EXACT existing API call the frontend should make once the user
// confirms. Shape:
//   { type, label, needsConfirm: true, payload: { endpoint, method, body } }
//
// Endpoints (all under /api, the app's mount prefix):
//   createTask  → POST  /api/tasks                       (routes/tasks.ts)
//   changeStage → PATCH /api/deals/:id                   (routes/deals-mutate.ts)
//   addNote     → POST  /api/deals/:dealId/activities    (routes/activities.ts)
//
// These tools resolve a deal NAME → id (org-scoped) so the endpoint URL is
// concrete. If the name can't be resolved they return an error string and
// emit no action.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

const STAGES = [
  'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED',
  'LOI_NEGOTIATION', 'CLOSING', 'CLOSED_WON', 'CLOSED_LOST', 'PASSED',
] as const;

/** Resolve a deal name → { id, name } within the org. Longest/exact wins. */
async function resolveDeal(orgId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from('Deal')
    .select('id, name')
    .eq('organizationId', orgId)
    .ilike('name', `%${name}%`)
    .limit(10);
  if (!data || data.length === 0) return null;
  const exact = data.find(d => d.name?.toLowerCase() === name.toLowerCase());
  if (exact) return { id: exact.id, name: exact.name };
  data.sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0));
  return { id: data[0].id, name: data[0].name };
}

// ─── create_task ──────────────────────────────────────────────────
export function makeCreateTaskTool(orgId: string) {
  return tool(
    async ({ title, description, priority, dueDate, dealName }) => {
      let dealId: string | undefined;
      if (dealName) {
        const deal = await resolveDeal(orgId, dealName);
        if (!deal) return `Could not find a deal matching "${dealName}" to attach the task to. Omit dealName for an unattached task, or use search_deals to find the right name.`;
        dealId = deal.id;
      }
      const body: Record<string, unknown> = { title };
      if (description) body.description = description;
      if (priority) body.priority = priority;
      if (dueDate) body.dueDate = dueDate;
      if (dealId) body.dealId = dealId;

      const action = {
        type: 'createTask',
        label: `Create task: ${title}`,
        needsConfirm: true,
        payload: { endpoint: '/tasks', method: 'post', body },
      };
      return JSON.stringify({
        proposed: true,
        message: `Proposed task "${title}"${dealName ? ` on ${dealName}` : ''}. Awaiting user confirmation — not yet created.`,
        action,
      });
    },
    {
      name: 'create_task',
      description: 'PROPOSE creating a task (does NOT create it — the user must confirm). Use when the user asks to add a to-do, follow-up, or reminder. Optionally attach it to a deal by name.',
      schema: z.object({
        title: z.string().describe('Task title.'),
        description: z.string().optional().describe('Task details.'),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().describe('Priority (default MEDIUM).'),
        dueDate: z.string().optional().describe('Due date as YYYY-MM-DD.'),
        dealName: z.string().optional().describe('Name of a deal to attach the task to.'),
      }),
    }
  );
}

// ─── change_deal_stage ────────────────────────────────────────────
export function makeChangeDealStageTool(orgId: string) {
  return tool(
    async ({ dealName, stage }) => {
      const deal = await resolveDeal(orgId, dealName);
      if (!deal) return `Could not find a deal matching "${dealName}". Use search_deals to find the right name.`;
      const action = {
        type: 'changeStage',
        label: `Move ${deal.name} → ${stage}`,
        needsConfirm: true,
        payload: { endpoint: `/deals/${deal.id}`, method: 'patch', body: { stage } },
      };
      return JSON.stringify({
        proposed: true,
        message: `Proposed moving "${deal.name}" to ${stage}. Awaiting user confirmation — stage not yet changed.`,
        action,
      });
    },
    {
      name: 'change_deal_stage',
      description: 'PROPOSE changing a deal\'s pipeline stage (does NOT change it — the user must confirm). Stages: INITIAL_REVIEW → DUE_DILIGENCE → IOI_SUBMITTED → LOI_NEGOTIATION → CLOSING → CLOSED_WON. Terminal: CLOSED_LOST, PASSED.',
      schema: z.object({
        dealName: z.string().describe('Name of the deal to move.'),
        stage: z.enum(STAGES).describe('Target stage.'),
      }),
    }
  );
}

// ─── add_note ─────────────────────────────────────────────────────
export function makeAddNoteTool(orgId: string) {
  return tool(
    async ({ dealName, content, type }) => {
      const deal = await resolveDeal(orgId, dealName);
      if (!deal) return `Could not find a deal matching "${dealName}". Use search_deals to find the right name.`;
      const activityType = type || 'NOTE_ADDED';
      const title = activityType === 'CALL_LOGGED' ? 'Call Logged'
        : activityType === 'EMAIL_SENT' ? 'Email Logged'
        : activityType === 'MEETING_SCHEDULED' ? 'Meeting Scheduled'
        : 'Note Added';
      const action = {
        type: 'addNote',
        label: `Add note to ${deal.name}`,
        needsConfirm: true,
        payload: {
          endpoint: `/deals/${deal.id}/activities`,
          method: 'post',
          body: { type: activityType, title, description: content },
        },
      };
      return JSON.stringify({
        proposed: true,
        message: `Proposed ${title.toLowerCase()} on "${deal.name}". Awaiting user confirmation — not yet saved.`,
        action,
      });
    },
    {
      name: 'add_note',
      description: 'PROPOSE adding a note / call log / email log / meeting note to a deal\'s activity feed (does NOT save it — the user must confirm). Requires the deal name.',
      schema: z.object({
        dealName: z.string().describe('Name of the deal to add the note to.'),
        content: z.string().describe('The note content.'),
        type: z.enum(['NOTE_ADDED', 'CALL_LOGGED', 'EMAIL_SENT', 'MEETING_SCHEDULED']).default('NOTE_ADDED').describe('Activity type.'),
      }),
    }
  );
}
