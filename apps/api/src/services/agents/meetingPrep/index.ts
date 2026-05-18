// ─── AI Meeting Prep Workflow ────────────────────────────────────────
// Parallel fetch: contact history + deal status + RAG doc summaries
// Then LLM compiles a meeting brief with talking points.

import { isLLMAvailable, invokeStructured } from '../../llm.js';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { searchDocumentChunks, buildRAGContext, isRAGEnabled } from '../../../rag.js';
import { supabase } from '../../../supabase.js';
import { z } from 'zod';
import { log } from '../../../utils/logger.js';
import { TOPIC_GUARDRAILS, CONTEXT_ANCHORING, wrapDocumentContent } from '../guardrails.js';

export interface MeetingPrepInput {
  dealId: string;
  contactId?: string;
  organizationId: string;
  meetingTopic?: string;
  meetingDate?: string;
}

export interface MeetingBrief {
  headline: string;
  dealSummary: string;
  contactProfile: string | null;
  keyTalkingPoints: string[];
  questionsToAsk: string[];
  risksToAddress: string[];
  documentHighlights: string[];
  suggestedAgenda: string[];
  generatedAt: string;
}

/**
 * Generate a meeting prep brief by fetching context in parallel
 * and compiling with LLM.
 */
export async function generateMeetingPrep(input: MeetingPrepInput): Promise<MeetingBrief> {
  if (!isLLMAvailable()) {
    throw new Error('No LLM provider configured');
  }

  log.info('Generating meeting prep', { dealId: input.dealId, contactId: input.contactId });

  // Parallel fetch: deal + contact + documents + activities + financial statements
  // Each query is wrapped to prevent one failure from crashing the whole Promise.all
  const [dealResult, contactResult, docSearchResult, activitiesResult, financialsResult] = await Promise.all([
    // 1. Deal basics (no risky joins that could fail)
    supabase
      .from('Deal')
      .select(`
        id, name, stage, status, industry, revenue, ebitda, dealSize,
        irrProjected, mom, aiThesis, description, source,
        company:Company(name, description, industry)
      `)
      .eq('id', input.dealId)
      .single(),

    // 2. Contact history (if provided) — skip risky joins
    input.contactId
      ? Promise.resolve(
          supabase
            .from('Contact')
            .select('firstName, lastName, email, title, company, notes, lastContactedAt')
            .eq('id', input.contactId)
            .single()
        ).catch(() => ({ data: null, error: null }))
      : Promise.resolve({ data: null, error: null }),

    // 3. RAG document search for meeting topic
    input.meetingTopic && isRAGEnabled()
      ? searchDocumentChunks(input.meetingTopic, input.dealId, 5, 0.4).catch(() => [])
      : Promise.resolve([]),

    // 4. Recent activities
    supabase
      .from('Activity')
      .select('type, title, description, createdAt')
      .eq('dealId', input.dealId)
      .order('createdAt', { ascending: false })
      .limit(10),

    // 5. Extracted financial statements (for detailed financial context)
    supabase
      .from('FinancialStatement')
      .select('statementType, period, extractedData, confidence, extractionSource')
      .eq('dealId', input.dealId)
      .eq('isActive', true)
      .order('period', { ascending: false })
      .limit(15),
  ]);

  const deal = dealResult.data;
  if (!deal) throw new Error('Deal not found');

  const contact = contactResult.data as any;
  const docResults = docSearchResult as any[];
  const activities = activitiesResult.data || [];
  const financialStatements = financialsResult.data || [];

  // Build context for LLM
  const contextParts: string[] = [];

  // Deal context
  contextParts.push(`DEAL: ${deal.name}`);
  contextParts.push(`Stage: ${deal.stage}, Industry: ${deal.industry || 'N/A'}`);
  if (deal.revenue) contextParts.push(`Revenue: $${deal.revenue}M`);
  if (deal.ebitda) contextParts.push(`EBITDA: $${deal.ebitda}M`);
  if (deal.dealSize) contextParts.push(`Deal Size: $${deal.dealSize}M`);
  if (deal.aiThesis) contextParts.push(`Thesis: ${deal.aiThesis}`);

  const company = deal.company as any;
  if (company?.description) contextParts.push(`Company: ${company.description}`);

  // Contact context
  if (contact) {
    contextParts.push(`\nMEETING WITH: ${contact.firstName} ${contact.lastName}`);
    if (contact.title) contextParts.push(`Title: ${contact.title}`);
    if (contact.company) contextParts.push(`Company: ${contact.company}`);
    if (contact.notes) contextParts.push(`Notes: ${contact.notes}`);
  }

  // Financial statements detail (extracted line items)
  if (financialStatements.length > 0) {
    contextParts.push(`\nFINANCIAL STATEMENTS (${financialStatements.length} periods extracted):`);
    const byType: Record<string, any[]> = {};
    for (const s of financialStatements) {
      byType[s.statementType] = byType[s.statementType] || [];
      byType[s.statementType].push(s);
    }
    for (const [type, stmts] of Object.entries(byType)) {
      contextParts.push(`\n  ${type}:`);
      for (const s of stmts.slice(0, 3)) {
        const items = Array.isArray(s.extractedData) ? s.extractedData : [];
        contextParts.push(`    Period: ${s.period} (${items.length} line items, ${s.confidence}% confidence)`);
        // Include key line items for the LLM to reference
        for (const item of items.slice(0, 15)) {
          if (item.label && item.value !== undefined) {
            contextParts.push(`      ${item.label}: $${item.value}M`);
          }
        }
      }
    }
  }

  // Document highlights — wrap as untrusted external data (Task 4.7).
  if (docResults.length > 0) {
    const { data: docs } = await supabase.from('Document').select('id, name, type').eq('dealId', input.dealId);
    contextParts.push(`\nDOCUMENT HIGHLIGHTS:`);
    contextParts.push(wrapDocumentContent(buildRAGContext(docResults, docs || []), 'rag-results'));
  }

  // Recent activities
  if (activities.length > 0) {
    contextParts.push(`\nRECENT ACTIVITY:`);
    for (const a of activities.slice(0, 5)) {
      contextParts.push(`  - ${a.type}: ${a.title}`);
    }
  }

  // Generate meeting brief with structured output
  const brief = await invokeStructured(z.object({
    headline: z.string().describe('One-line meeting headline'),
    dealSummary: z.string().describe('2-3 sentence deal summary for quick context'),
    contactProfile: z.string().nullable().describe('Brief profile of the person being met'),
    keyTalkingPoints: z.array(z.string()).describe('5-7 key talking points with specific data'),
    questionsToAsk: z.array(z.string()).describe('3-5 critical questions to ask in the meeting'),
    risksToAddress: z.array(z.string()).describe('2-3 risks or concerns to discuss'),
    documentHighlights: z.array(z.string()).describe('Key findings from uploaded documents'),
    suggestedAgenda: z.array(z.string()).describe('4-6 agenda items in order'),
  }), [
    new SystemMessage(`You are a PE deal team meeting prep assistant. Generate a comprehensive meeting brief that helps the deal team walk in prepared.
${TOPIC_GUARDRAILS}
${CONTEXT_ANCHORING}

CRITICAL REQUIREMENTS:
- Use SPECIFIC numbers and data from the financial statements (revenue figures, margins, EBITDA, growth rates). Do NOT use generic placeholder questions.
- Questions to ask must reference actual data points (e.g., "Revenue declined from $80M to $70M between 2023-2024 — what caused this?" NOT "What are your revenue trends?")
- Include a financial summary section in dealSummary with key metrics and trends from the extracted statements
- If financial statements show declining margins, negative EBITDA, or concerning trends, highlight these as specific risks
- Talking points should cite specific numbers from the context
- If limited financial data is available, acknowledge what data IS available and what's missing`),
    new HumanMessage(`Generate a meeting prep brief for this context:\n\n${contextParts.join('\n')}\n\nMeeting topic: ${input.meetingTopic || 'General deal discussion'}\nMeeting date: ${input.meetingDate || 'Today'}`),
  ], { maxTokens: 2000, temperature: 0.5, label: 'meetingPrep.brief' });

  log.info('Meeting prep generated', { dealId: input.dealId, talkingPoints: brief.keyTalkingPoints.length });

  return {
    headline: brief.headline,
    dealSummary: brief.dealSummary,
    contactProfile: brief.contactProfile,
    keyTalkingPoints: brief.keyTalkingPoints,
    questionsToAsk: brief.questionsToAsk,
    risksToAddress: brief.risksToAddress,
    documentHighlights: brief.documentHighlights,
    suggestedAgenda: brief.suggestedAgenda,
    generatedAt: new Date().toISOString(),
  };
}
