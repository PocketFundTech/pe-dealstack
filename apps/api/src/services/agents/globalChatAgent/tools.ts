// ─── LangChain Tools for the Global (org-scoped) Chat Agent ────────
// Tools are created per-request with orgId baked into closures so the LLM
// only passes query-specific parameters. Mirrors dealChatAgent/tools.ts but
// every tool ranges over the WHOLE org instead of a single dealId.
//
// Read tools execute inline; MUTATION tools (create_task / change_deal_stage
// / add_note) DO NOT execute — they emit proposed-action envelopes for the
// user to confirm (see ./tools/mutations.ts and ../index.ts collection).

import { makeSearchDealsTool } from './tools/searchDeals.js';
import { makeGetDealFinancialsTool } from './tools/getDealFinancials.js';
import { makeCompareDealsTool } from './tools/compareDeals.js';
import { makeSearchDocumentsTool } from './tools/searchDocuments.js';
import { makeNavigationTool } from './tools/navigation.js';
import { makeDraftEmailTool } from './tools/draftEmail.js';
import { makeCreateTaskTool, makeChangeDealStageTool, makeAddNoteTool } from './tools/mutations.js';
// webSearch is generic (not deal/org-scoped) — reuse the dealChatAgent factory.
import { makeWebSearchTool } from '../dealChatAgent/tools/webSearch.js';

/** Create all global-chat tools with orgId baked in via closures. */
export function getGlobalChatTools(orgId: string) {
  return [
    // Read / data tools
    makeSearchDealsTool(orgId),
    makeGetDealFinancialsTool(orgId),
    makeCompareDealsTool(orgId),
    makeSearchDocumentsTool(orgId),
    makeWebSearchTool(),
    // Action-emitting tools (no DB writes here)
    makeNavigationTool(orgId),
    makeDraftEmailTool(orgId),
    // Proposed-mutation tools (confirm-first; no inline writes)
    makeCreateTaskTool(orgId),
    makeChangeDealStageTool(orgId),
    makeAddNoteTool(orgId),
  ];
}
