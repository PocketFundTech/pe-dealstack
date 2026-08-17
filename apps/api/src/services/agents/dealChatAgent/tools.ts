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
import { makeWebSearchTool, inputSchema as webSearchSchema } from './tools/webSearch.js';
import { makeGenerateChartTool, inputSchema as generateChartSchema } from './tools/generateChart.js';
import { makeGetRecentEmailsForDealTool, inputSchema as getRecentEmailsForDealSchema } from './tools/getRecentEmailsForDeal.js';
import { makeGetUpcomingMeetingsForDealTool, inputSchema as getUpcomingMeetingsForDealSchema } from './tools/getUpcomingMeetingsForDeal.js';
import { toLangChainTool } from './langchainAdapter.js';
import type { ToolEmit } from './types.js';

const noopEmit: ToolEmit = () => {};

/**
 * Streaming-path barrel: BetaRunnableTool-shaped tools for the Anthropic
 * Tool Runner (DEAL_CHAT_ENGINE=streaming).
 *
 * RESOLVED (2026-08-14): the four tools called out in the 2026-08-11 merge
 * note (web_search, generate_chart, and the two /follow-ups Gmail/Calendar
 * live readers) are now ported to BetaRunnableTool shape and included below
 * — parity with getDealChatToolsLegacy is restored. `userId` is threaded
 * through (optional, same graceful-degradation contract as the legacy
 * path) so the two live readers work here too; see the call site in
 * dealChatAgent/index.ts's runDealChatAgentStreaming.
 */
export function getDealChatTools(dealId: string, orgId: string, emit: ToolEmit, userId?: string) {
  return [
    makeSearchDocumentsTool(dealId, orgId),
    makeGetDealFinancialsTool(dealId, orgId),
    makeCompareDealsTool(dealId, orgId),
    makeGetDealActivityTool(dealId, orgId),
    makeWebSearchTool(),
    makeGenerateChartTool(),
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
    // /follow-ups live readers — appended last to mirror the legacy
    // barrel's ordering exactly (order is load-bearing, see file header).
    makeGetRecentEmailsForDealTool(dealId, orgId, userId),
    makeGetUpcomingMeetingsForDealTool(dealId, orgId, userId),
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
 *
 * `userId` is OPTIONAL for backward compat — tools that need it (Gmail /
 * Calendar live readers for /follow-ups) degrade gracefully with a
 * "user context not available" message when it's absent.
 */
export function getDealChatToolsLegacy(dealId: string, orgId: string, userId?: string) {
  return [
    toLangChainTool(makeSearchDocumentsTool(dealId, orgId), searchDocumentsSchema),
    toLangChainTool(makeGetDealFinancialsTool(dealId, orgId), getDealFinancialsSchema),
    toLangChainTool(makeCompareDealsTool(dealId, orgId), compareDealsSchema),
    toLangChainTool(makeGetDealActivityTool(dealId, orgId), getDealActivitySchema),
    toLangChainTool(makeWebSearchTool(), webSearchSchema),
    toLangChainTool(makeGenerateChartTool(), generateChartSchema),
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
    // /follow-ups live readers — order matters per the comment in this file;
    // these go at the end so existing prompt references stay stable.
    toLangChainTool(makeGetRecentEmailsForDealTool(dealId, orgId, userId), getRecentEmailsForDealSchema),
    toLangChainTool(makeGetUpcomingMeetingsForDealTool(dealId, orgId, userId), getUpcomingMeetingsForDealSchema),
  ];
}
