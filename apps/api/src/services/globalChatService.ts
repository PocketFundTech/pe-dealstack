// ─── Global (non-deal-scoped) AI Chat Service ──────────────────────
// Powers the bottom-right floating AI assistant (frontend AIAssistant.tsx)
// when the user is NOT on a per-deal view. The per-deal branch posts to
// /deals/:dealId/chat (runDealChatAgent); this service backs the global
// branch POST /api/ai/chat for the dashboard / deals / contacts / memo /
// general contexts.
//
// Dispatch:
//   - dashboard | deals → portfolio-aware answer. We assemble a bounded
//     org portfolio summary (deal counts, revenue/EBITDA/IRR, stage +
//     industry breakdown, top deals) and feed it to the chat model as
//     context. This mirrors ai-portfolio.ts's get_portfolio_summary tool
//     output WITHOUT importing/altering that route — kept here as a small
//     shared helper so the floating chat works org-wide without a dealId.
//   - contacts | memo | general → lightweight org-scoped LLM call with a
//     "PE deal platform assistant" system prompt (no extra data fetch).
//     `memo` has no memo id at the global level, so it's treated as general.
//
// Token usage is bounded: portfolio summary is capped (top 10 deals), and
// the model is constructed with an explicit maxTokens.

import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { supabase } from '../supabase.js';
import { getChatModel } from './llm.js';
import { log } from '../utils/logger.js';
import { formatFinancialValue } from '../utils/financialFormat.js';
import { getFirmContextBlock } from './firmContextService.js';

// Usage-tracking operation label (see services/llm.ts). Matches the label the
// portfolio chat route uses so global-chat traffic lands in the same bucket.
const CHAT_OPERATION = 'deal_analysis';

export type GlobalChatContext = 'dashboard' | 'deals' | 'contacts' | 'memo' | 'general';

const PORTFOLIO_CONTEXTS = new Set<GlobalChatContext>(['dashboard', 'deals']);

export interface GlobalChatResult {
  response: string;
  model: string;
}

/** A prior conversation turn, threaded into the LLM call for memory. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Conversation-memory bounds: keep the prompt cheap while preserving the
// recent thread. Cap to the last N turns and a total character budget.
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 6000;

/** Coerce an arbitrary context string from the client into a known context. */
export function normalizeContext(raw: string | undefined): GlobalChatContext {
  switch (raw) {
    case 'dashboard':
    case 'deals':
    case 'contacts':
    case 'memo':
      return raw;
    default:
      return 'general';
  }
}

/**
 * Build a bounded portfolio summary string for an org. Mirrors the data
 * shape of ai-portfolio.ts's get_portfolio_summary tool (revenue, EBITDA,
 * IRR, stage/industry breakdown, top 10 deals) but as a plain helper so the
 * global chat can include it as static context without spinning up a
 * tool-using agent.
 */
async function buildPortfolioContext(orgId: string): Promise<string> {
  // Pull the canonical cache columns (cachedRevenue/cachedEbitda are ACTUAL
  // DOLLARS, unit-applied — see apps/api/deal-cache-migration.sql). The legacy
  // revenue/ebitda columns carry NO unitScale, so quoting them as "$X M" is
  // unsafe; we only fall back to them with an explicit caveat.
  const { data: deals } = await supabase
    .from('Deal')
    .select('id, name, stage, status, industry, revenue, ebitda, dealSize, irrProjected, mom, currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, cachedPeriod, cachedCurrency, createdAt')
    .eq('organizationId', orgId)
    .order('updatedAt', { ascending: false });

  if (!deals || deals.length === 0) {
    return 'The firm currently has no deals in its pipeline.';
  }

  const active = deals.filter(d => d.status !== 'PASSED' && d.stage !== 'CLOSED_LOST');

  // Totals sum ONLY cached (actual-dollar) figures. Mixing legacy unscaled
  // columns into a single sum would corrupt the total, so legacy-only deals
  // are excluded from the totals and that exclusion is disclosed below.
  let totalRevenue = 0;
  let totalEbitda = 0;
  let revCovered = 0;
  let ebitdaCovered = 0;
  for (const d of active) {
    if (d.cachedRevenue != null) { totalRevenue += d.cachedRevenue; revCovered++; }
    if (d.cachedEbitda != null) { totalEbitda += d.cachedEbitda; ebitdaCovered++; }
  }

  const withIRR = active.filter(d => d.irrProjected);
  const avgIRR = withIRR.length > 0
    ? withIRR.reduce((s, d) => s + (d.irrProjected || 0), 0) / withIRR.length
    : 0;

  const stageCount: Record<string, number> = {};
  const industryCount: Record<string, number> = {};
  for (const d of active) {
    stageCount[d.stage] = (stageCount[d.stage] || 0) + 1;
    if (d.industry) industryCount[d.industry] = (industryCount[d.industry] || 0) + 1;
  }

  const coverageNote = (covered: number) =>
    covered < active.length ? ` (canonical figures available for ${covered}/${active.length} active deals)` : '';

  const parts: string[] = [
    `Total Deals: ${deals.length} (${active.length} active)`,
    `Total Revenue (sum of canonical figures): ${formatFinancialValue(totalRevenue, 'ACTUALS', { currency: 'USD' })}${coverageNote(revCovered)}`,
    `Total EBITDA (sum of canonical figures): ${formatFinancialValue(totalEbitda, 'ACTUALS', { currency: 'USD' })}${coverageNote(ebitdaCovered)}`,
    `Average IRR: ${avgIRR.toFixed(1)}%`,
    `By Stage: ${Object.entries(stageCount).map(([k, v]) => `${k}: ${v}`).join(', ') || 'n/a'}`,
    `By Industry: ${Object.entries(industryCount).map(([k, v]) => `${k}: ${v}`).join(', ') || 'n/a'}`,
    `Top ${Math.min(10, active.length)} Active Deals:`,
  ];
  for (const d of active.slice(0, 10)) {
    parts.push(`- ${formatDealFinancialLine(d)}`);
  }
  return parts.join('\n');
}

/**
 * Format a single deal's headline financials for a prompt line, unit-safe.
 * Uses cached actual-dollar figures when present; falls back to the legacy
 * unscaled columns ONLY with an explicit "(unverified scale)" caveat so the
 * model never silently mislabels a thousands-stored deal as millions.
 */
function formatDealFinancialLine(d: {
  name: string;
  industry?: string | null;
  stage: string;
  currency?: string | null;
  cachedRevenue?: number | null;
  cachedEbitda?: number | null;
  cachedEbitdaMargin?: number | null;
  cachedPeriod?: string | null;
  cachedCurrency?: string | null;
}): string {
  const currency = d.cachedCurrency || d.currency || 'USD';
  const segs: string[] = [`${d.name} (${d.industry || 'N/A'}): ${d.stage}`];

  if (d.cachedRevenue != null || d.cachedEbitda != null) {
    const fin: string[] = [];
    if (d.cachedRevenue != null) fin.push(`Rev ${formatFinancialValue(d.cachedRevenue, 'ACTUALS', { currency })}`);
    if (d.cachedEbitda != null) fin.push(`EBITDA ${formatFinancialValue(d.cachedEbitda, 'ACTUALS', { currency })}`);
    if (d.cachedEbitdaMargin != null) fin.push(`Margin ${d.cachedEbitdaMargin.toFixed(1)}%`);
    let line = fin.join(', ');
    if (d.cachedPeriod) line += ` [${d.cachedPeriod}]`;
    segs.push(line);
  } else {
    // No canonical figures — omit numbers rather than mislabel units.
    segs.push('financials not yet extracted (no canonical figures available)');
  }
  return segs.join(', ');
}

/**
 * Fix C (depth): if the user's message names a specific deal, fetch THAT
 * deal's cached financials + stage and return a bounded extra-context block.
 * One query, capped to a single best match. Returns '' when no deal matches.
 */
async function buildMentionedDealContext(orgId: string, message: string): Promise<string> {
  const { data: deals } = await supabase
    .from('Deal')
    .select('id, name, stage, status, industry, currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin, cachedPeriod, cachedCurrency')
    .eq('organizationId', orgId)
    .limit(500);

  if (!deals || deals.length === 0) return '';

  const lower = message.toLowerCase();
  // Match deals whose name appears in the message. Skip very short names to
  // avoid false positives (e.g. a 2-char name colliding with common words).
  const matches = deals
    .filter(d => d.name && d.name.length >= 3 && lower.includes(d.name.toLowerCase()))
    // Prefer the longest (most specific) name match.
    .sort((a, b) => b.name.length - a.name.length);

  const hit = matches[0];
  if (!hit) return '';

  const line = formatDealFinancialLine(hit);
  return `\n\nThe user mentioned a specific deal. Here is its current data:\n- ${line}${hit.status ? ` (status: ${hit.status})` : ''}`;
}

/** Resolve the org's display name for grounding the system prompt. */
async function getOrgName(orgId: string): Promise<string> {
  const { data } = await supabase
    .from('Organization')
    .select('name')
    .eq('id', orgId)
    .single();
  return data?.name || 'your firm';
}

/**
 * Convert client-supplied prior turns into LangChain messages, bounded to the
 * last MAX_HISTORY_TURNS turns and MAX_HISTORY_CHARS total characters (newest
 * first, so the most recent context survives the cap). Invalid/empty entries
 * are dropped.
 */
function buildHistoryMessages(history?: ChatTurn[]): BaseMessage[] {
  if (!Array.isArray(history) || history.length === 0) return [];

  const cleaned = history
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS);

  // Apply the char budget from the newest turn backwards.
  const kept: ChatTurn[] = [];
  let budget = MAX_HISTORY_CHARS;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const t = cleaned[i];
    const cost = t.content.length;
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(t);
  }

  return kept.map(t =>
    t.role === 'user' ? new HumanMessage(t.content) : new AIMessage(t.content),
  );
}

/**
 * Run the global (non-deal-scoped) chat. Returns the assistant text plus the
 * model name. Throws on LLM failure — the caller maps that to a 500 via the
 * codebase's classifyAIErrorObject pattern.
 */
export async function runGlobalChat(params: {
  orgId: string;
  message: string;
  context: GlobalChatContext;
  history?: ChatTurn[];
}): Promise<GlobalChatResult> {
  const { orgId, message, context, history } = params;

  const orgName = await getOrgName(orgId);
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Fix C: surface a specifically-named deal's data regardless of context.
  const mentionedDeal = await buildMentionedDealContext(orgId, message);

  // Firm-wide standing context (single AI-generated firm-context doc). Empty
  // string when none has been generated yet — guard and inject nothing.
  const firmContext = await getFirmContextBlock(orgId);
  const firmContextBlock = firmContext ? `=== FIRM CONTEXT ===\n${firmContext}\n\n` : '';

  // Portfolio-aware contexts get a bounded portfolio summary injected.
  let systemPrompt: string;
  let maxTokens: number;
  if (PORTFOLIO_CONTEXTS.has(context)) {
    const portfolio = await buildPortfolioContext(orgId);
    maxTokens = 1200;
    systemPrompt = `${firmContextBlock}You are an AI portfolio assistant for ${orgName}, a Private Equity firm. Answer the user's question using ONLY the firm's portfolio data below. Cite specific numbers (revenue, EBITDA, IRR, stage) and deal names where relevant. All monetary figures below are already in display units — quote them exactly as written, do NOT re-scale or append your own unit suffix. If the data doesn't contain the answer, say so plainly rather than guessing. Be concise.

Today's date: ${today}

Firm Portfolio Snapshot:
${portfolio}${mentionedDeal}`;
  } else {
    // contacts / memo / general → lightweight, no extra data fetch.
    maxTokens = 800;
    systemPrompt = `${firmContextBlock}You are an AI assistant inside ${orgName}'s Private Equity deal management platform. You help users navigate deals, contacts, data rooms, and investment memos. Give concise, practical answers. You do NOT have broad access to deal or contact records in this conversation — if the user asks about a specific deal's data not provided below, point them to that deal's page where a deal-scoped assistant has full context. All monetary figures provided are already in display units — quote them exactly, do NOT re-scale.

Today's date: ${today}${mentionedDeal}`;
  }

  const model = getChatModel(0.3, maxTokens, CHAT_OPERATION);

  log.info('Global AI chat', { context, query: message.substring(0, 50), historyTurns: history?.length ?? 0 });

  // Fix B: thread prior turns into the call as conversation memory (bounded).
  const priorMessages = buildHistoryMessages(history);

  const result = await model.invoke([
    new SystemMessage(systemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ]);

  const response = typeof result.content === 'string'
    ? result.content
    : Array.isArray(result.content)
      ? result.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('')
      : 'Unable to generate a response.';

  // getChatModel tags usage by operation; surface a stable model label to the
  // client. We don't have the resolved provider model name on the message, so
  // report the configured chat model identifier.
  const modelName = (result as any).response_metadata?.model_name
    || (result as any).response_metadata?.model
    || 'chat';

  return {
    response: response || 'Unable to generate a response.',
    model: modelName,
  };
}
