// ─── Memo Agent — Main Entry Point ───────────────────────────────────────────
// Re-exports from sibling modules and provides the ReAct chat agent.

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { getChatModel, isLLMAvailable } from '../../llm.js';
import { getMemoAgentTools } from './tools.js';
import { MEMO_CHAT_SYSTEM_PROMPT } from './prompts.js';
import { MODEL_REASONING } from '../../../utils/aiModels.js';
import { SHARED_GUARDRAILS } from '../guardrails.js';
import { log } from '../../../utils/logger.js';
import { classifyAIError } from '../../../utils/aiErrors.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { runWithAgentBounds } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// Chat ReAct agent — tool calls + a final reply. 60s gives the user a
// reasonable interactive ceiling; recursionLimit 10 caps tool-call loops.
const MEMO_CHAT_TIMEOUT_MS = 60_000;
const MEMO_CHAT_RECURSION_LIMIT = 10;

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { buildMemoContext, formatContextForLLM } from './context.js';
export { generateAllSections, generateSection, generateAllSectionsStreaming } from './pipeline.js';
export {
  COMPREHENSIVE_IC_SECTIONS,
  STANDARD_IC_SECTIONS,
  SEARCH_FUND_SECTIONS,
  SCREENING_NOTE_SECTIONS,
} from './prompts.js';
export type { GeneratedSection, MemoGenerationStreamEvent } from './pipeline.js';
export type { MemoContext } from './context.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MemoChatInput {
  memoId: string;
  dealId: string;
  orgId: string;
  message: string;
  activeSectionId?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface MemoChatResponse {
  message: string;
  model: string;
  action?: 'applied' | 'confirm' | 'info';
  sectionId?: string;
  preview?: string;
  tableData?: any;
  chartConfig?: any;
  insertPosition?: 'append' | 'prepend' | 'replace';
  type?: 'table' | 'chart' | 'new_section';
  sectionType?: string;
  title?: string;
}

// ─── runMemoChatAgent ─────────────────────────────────────────────────────────

/**
 * Run the memo chat ReAct agent.
 * The agent can read/edit memo sections, fetch deal financials, and search documents.
 */
export async function runMemoChatAgent(input: MemoChatInput): Promise<MemoChatResponse> {
  if (!isLLMAvailable()) {
    return {
      message: 'AI service unavailable. Please configure an API key.',
      model: 'fallback',
    };
  }

  try {
    const model = getChatModel(0.7, 2000, 'memo_generation');
    const tools = getMemoAgentTools(input.memoId, input.dealId, input.orgId);

    const agent = createReactAgent({ llm: model, tools });

    // ── Build messages ───────────────────────────────────────────────────────

    const messages: (SystemMessage | HumanMessage | AIMessage)[] = [
      new SystemMessage(MEMO_CHAT_SYSTEM_PROMPT + '\n' + SHARED_GUARDRAILS),
    ];

    if (input.activeSectionId) {
      messages.push(
        new SystemMessage(
          `The user's currently active/selected section ID is: ${input.activeSectionId}. ` +
          `When the user refers to "this section", "the current section", or "here", they mean this section.`,
        ),
      );
    }

    // Add last 8 history messages
    if (input.history) {
      for (const msg of input.history.slice(-8)) {
        if (msg.role === 'user') {
          messages.push(new HumanMessage(msg.content));
        } else {
          messages.push(new AIMessage(msg.content));
        }
      }
    }

    messages.push(new HumanMessage(input.message));

    log.debug('Running memo chat ReAct agent', {
      memoId: input.memoId,
      dealId: input.dealId,
      activeSectionId: input.activeSectionId,
      messageCount: messages.length,
    });

    // ── Invoke (bounded) ─────────────────────────────────────────────────────

    const result: any = await runWithAgentBounds(
      (config) => agent.invoke({ messages }, config),
      {
        timeoutMs: MEMO_CHAT_TIMEOUT_MS,
        recursionLimit: MEMO_CHAT_RECURSION_LIMIT,
        envVar: 'MEMO_CHAT_AGENT_TIMEOUT_MS',
        label: 'Memo chat agent',
      },
    );

    // ── Extract final AI response ─────────────────────────────────────────────

    const aiMessages = result.messages.filter(
      (m: any) => m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage',
    );
    const lastAI = aiMessages[aiMessages.length - 1];
    const message =
      typeof lastAI?.content === 'string'
        ? lastAI.content
        : 'I was unable to generate a response. Please try again.';

    // ── Extract tool call results ─────────────────────────────────────────────

    const toolMessages = result.messages.filter(
      (m: any) => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage',
    );

    let action: MemoChatResponse['action'] | undefined;
    let sectionId: string | undefined;
    let preview: string | undefined;
    let tableData: any;
    let chartConfig: any;
    let insertPosition: MemoChatResponse['insertPosition'] | undefined;
    let type: MemoChatResponse['type'] | undefined;
    let sectionType: string | undefined;
    let title: string | undefined;

    for (const tm of toolMessages) {
      try {
        const content = typeof tm.content === 'string' ? tm.content : '';
        if (!content.startsWith('{')) continue;
        const parsed = JSON.parse(content);

        // Look for action signals from tools (applied / confirm)
        if (parsed.action === 'applied' || parsed.action === 'confirm') {
          // Prefer the most recent tool result with an action
          action = parsed.action as MemoChatResponse['action'];
          if (parsed.sectionId) sectionId = parsed.sectionId;
          if (parsed.preview) preview = parsed.preview;
          if (parsed.tableData !== undefined) tableData = parsed.tableData;
          if (parsed.chartConfig !== undefined) chartConfig = parsed.chartConfig;
          if (parsed.insertPosition) insertPosition = parsed.insertPosition as MemoChatResponse['insertPosition'];
          if (parsed.type) type = parsed.type as MemoChatResponse['type'];
          if (parsed.sectionType) sectionType = parsed.sectionType;
          if (parsed.title) title = parsed.title;
        }
      } catch (err) {
        // Not JSON tool output — skip. Log at debug to avoid noise on every non-JSON tool.
        log.debug('memoAgent: tool message JSON parse skipped', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    log.debug('Memo chat agent completed', {
      memoId: input.memoId,
      responseLength: message.length,
      toolCalls: toolMessages.length,
      action,
      sectionId,
    });

    return {
      message,
      model: `${MODEL_REASONING} (ReAct agent)`,
      ...(action !== undefined && { action }),
      ...(sectionId !== undefined && { sectionId }),
      ...(preview !== undefined && { preview }),
      ...(tableData !== undefined && { tableData }),
      ...(chartConfig !== undefined && { chartConfig }),
      ...(insertPosition !== undefined && { insertPosition }),
      ...(type !== undefined && { type }),
      ...(sectionType !== undefined && { sectionType }),
      ...(title !== undefined && { title }),
    };
  } catch (error: any) {
    log.error('Memo chat agent error', {
      memoId: input.memoId,
      message: error.message,
      stack: error.stack?.slice(0, 500),
    });
    captureAgentError(error, { agent: 'memoAgent', node: 'chat' });

    return {
      message: classifyAIError(error.message),
      model: 'error',
    };
  }
}
