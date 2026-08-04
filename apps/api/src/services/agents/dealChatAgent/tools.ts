// ─── LangChain Tools for Deal Chat Agent ───────────────────────────
// Tools are created per-request with dealId/orgId baked into closures
// so the LLM only needs to pass query-specific parameters.
//
// This file is a barrel — each tool is defined in its own module under
// ./tools/<name>.ts. The order of the array returned by getDealChatTools
// is load-bearing (the agent prompt references tools by name).

import { makeSearchDocumentsTool, inputSchema as searchDocumentsSchema } from './tools/searchDocuments.js';
import { makeGetDealFinancialsTool, inputSchema as getDealFinancialsSchema } from './tools/getDealFinancials.js';
import { makeCompareDealsTool, inputSchema as compareDealsSchema } from './tools/compareDeals.js';
import { makeGetDealActivityTool, inputSchema as getDealActivitySchema } from './tools/getDealActivity.js';
import { makeUpdateDealFieldTool, inputSchema as updateDealFieldSchema } from './tools/updateDealField.js';
import { makeChangeDealStageTool, inputSchema as changeDealStageSchema } from './tools/changeDealStage.js';
import { makeAddNoteTool, inputSchema as addNoteSchema } from './tools/addNote.js';
import { makeTriggerFinancialExtractionTool, inputSchema as triggerFinancialExtractionSchema } from './tools/triggerFinancialExtraction.js';
import { makeGenerateMeetingPrepTool, inputSchema as generateMeetingPrepSchema } from './tools/generateMeetingPrep.js';
import { makeDraftEmailTool, inputSchema as draftEmailSchema } from './tools/draftEmail.js';
import { makeGetAnalysisSummaryTool, inputSchema as getAnalysisSummarySchema } from './tools/getAnalysisSummary.js';
import { makeListDocumentsTool, inputSchema as listDocumentsSchema } from './tools/listDocuments.js';
import {
  makeSuggestActionTool,
  makeScrollToSectionTool,
  suggestActionInputSchema,
  scrollToSectionInputSchema,
} from './tools/navigation.js';
import { toLangChainTool } from './langchainAdapter.js';
import type { ToolEmit } from './types.js';

const noopEmit: ToolEmit = () => {};

/** Create all deal chat tools with dealId/orgId baked in via closures. */
export function getDealChatTools(dealId: string, orgId: string, emit: ToolEmit) {
  return [
    makeSearchDocumentsTool(dealId, orgId),
    makeGetDealFinancialsTool(dealId, orgId),
    makeCompareDealsTool(dealId, orgId),
    makeGetDealActivityTool(dealId, orgId),
    makeUpdateDealFieldTool(dealId, orgId, emit),
    makeChangeDealStageTool(dealId, orgId, emit),
    makeAddNoteTool(dealId, orgId, emit),
    makeTriggerFinancialExtractionTool(dealId, orgId, emit),
    makeGenerateMeetingPrepTool(dealId, orgId),
    makeDraftEmailTool(dealId, orgId),
    makeGetAnalysisSummaryTool(dealId, orgId),
    makeListDocumentsTool(dealId, orgId),
    makeScrollToSectionTool(dealId, orgId, emit),
    makeSuggestActionTool(dealId, orgId, emit),
  ];
}

/**
 * Legacy-path variant: same business logic as getDealChatTools, wrapped
 * as real LangChain StructuredTool instances for LangGraph's
 * createReactAgent(), which the Anthropic-Tool-Runner-shaped objects
 * above are not compatible with. Tools that emit side effects/updates
 * (add_note, change_deal_stage, update_deal_field,
 * trigger_financial_extraction, scroll_to_section, suggest_action) are
 * wired to a no-op emit — the legacy agent recovers those from a
 * post-hoc scan of tool_result JSON instead (see runDealChatAgent).
 */
export function getDealChatToolsLegacy(dealId: string, orgId: string) {
  return [
    toLangChainTool(makeSearchDocumentsTool(dealId, orgId), searchDocumentsSchema),
    toLangChainTool(makeGetDealFinancialsTool(dealId, orgId), getDealFinancialsSchema),
    toLangChainTool(makeCompareDealsTool(dealId, orgId), compareDealsSchema),
    toLangChainTool(makeGetDealActivityTool(dealId, orgId), getDealActivitySchema),
    toLangChainTool(makeUpdateDealFieldTool(dealId, orgId, noopEmit), updateDealFieldSchema),
    toLangChainTool(makeChangeDealStageTool(dealId, orgId, noopEmit), changeDealStageSchema),
    toLangChainTool(makeAddNoteTool(dealId, orgId, noopEmit), addNoteSchema),
    toLangChainTool(makeTriggerFinancialExtractionTool(dealId, orgId, noopEmit), triggerFinancialExtractionSchema),
    toLangChainTool(makeGenerateMeetingPrepTool(dealId, orgId), generateMeetingPrepSchema),
    toLangChainTool(makeDraftEmailTool(dealId, orgId), draftEmailSchema),
    toLangChainTool(makeGetAnalysisSummaryTool(dealId, orgId), getAnalysisSummarySchema),
    toLangChainTool(makeListDocumentsTool(dealId, orgId), listDocumentsSchema),
    toLangChainTool(makeScrollToSectionTool(dealId, orgId, noopEmit), scrollToSectionInputSchema),
    toLangChainTool(makeSuggestActionTool(dealId, orgId, noopEmit), suggestActionInputSchema),
  ];
}
