// ─── LangChain Tools for Deal Chat Agent ───────────────────────────
// Tools are created per-request with dealId/orgId baked into closures
// so the LLM only needs to pass query-specific parameters.
//
// This file is a barrel — each tool is defined in its own module under
// ./tools/<name>.ts. The order of the array returned by getDealChatTools
// is load-bearing (the agent prompt references tools by name).

import { makeSearchDocumentsTool } from './tools/searchDocuments.js';
import { makeGetDealFinancialsTool } from './tools/getDealFinancials.js';
import { makeCompareDealsTool } from './tools/compareDeals.js';
import { makeGetDealActivityTool } from './tools/getDealActivity.js';
import { makeUpdateDealFieldTool } from './tools/updateDealField.js';
import { makeChangeDealStageTool } from './tools/changeDealStage.js';
import { makeAddNoteTool } from './tools/addNote.js';
import { makeTriggerFinancialExtractionTool } from './tools/triggerFinancialExtraction.js';
import { makeGenerateMeetingPrepTool } from './tools/generateMeetingPrep.js';
import { makeDraftEmailTool } from './tools/draftEmail.js';
import { makeGetAnalysisSummaryTool } from './tools/getAnalysisSummary.js';
import { makeListDocumentsTool } from './tools/listDocuments.js';
import { makeSuggestActionTool, makeScrollToSectionTool } from './tools/navigation.js';
import type { ToolEmit } from './types.js';

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
