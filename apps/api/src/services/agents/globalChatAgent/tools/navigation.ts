// ─── navigate tool (ORG-SCOPED) ───────────────────────────────────
// Org-scoped navigation. The per-deal agent's suggest_action is keyed to a
// known dealId; the global agent navigates the firm-wide app (dashboard,
// deals list, contacts, tasks, data room) and — when it knows a deal id
// from a prior tool call — a specific deal/memo/data-room page.
//
// Emits a PROPOSED ACTION envelope of shape:
//   { type: "navigate", label, needsConfirm: false, payload: { href } }
// which the agent runner collects and returns to the frontend to execute.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// Canonical web-next routes (App Router clean paths — never hash routes).
const STATIC_ROUTES: Record<string, string> = {
  dashboard: '/dashboard',
  deals: '/deals',
  contacts: '/contacts',
  tasks: '/tasks',
  pipeline: '/deals',
};

export function makeNavigationTool(_orgId: string) {
  return tool(
    async ({ destination, dealId, label }) => {
      let href: string;
      switch (destination) {
        case 'deal_page':
          href = dealId ? `/deals/${dealId}` : '/deals';
          break;
        case 'data_room':
          href = dealId ? `/data-room/${dealId}` : '/deals';
          break;
        case 'memo_builder':
          href = dealId ? `/memo-builder?dealId=${dealId}&fromChat=1` : '/deals';
          break;
        default:
          href = STATIC_ROUTES[destination] || '/dashboard';
      }
      return JSON.stringify({
        action: {
          type: 'navigate',
          label: label || 'Open',
          needsConfirm: false,
          payload: { href },
        },
      });
    },
    {
      name: 'navigate',
      description: 'Propose navigating the user to a page in the app. Use for "take me to...", "open...", "show the dashboard/deals/contacts/tasks". For a specific deal page / data room / memo builder, pass the dealId (resolve it first via search_deals if you only have a name).',
      schema: z.object({
        destination: z.enum([
          'dashboard', 'deals', 'contacts', 'tasks', 'pipeline',
          'deal_page', 'data_room', 'memo_builder',
        ]).describe('Where to navigate.'),
        dealId: z.string().optional().describe('Deal UUID — required for deal_page / data_room / memo_builder.'),
        label: z.string().optional().describe('Button label the UI shows (e.g. "Open Dashboard").'),
      }),
    }
  );
}
