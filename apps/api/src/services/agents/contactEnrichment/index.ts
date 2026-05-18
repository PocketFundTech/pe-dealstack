// ─── Contact Enrichment Agent (LangGraph StateGraph) ────────────────
// REAL enrichment: searches CRM documents, analyzes email domain,
// finds linked deals, and synthesizes with LLM.
// No fake data — only what can be found in your own data + email analysis.
//
// Public API:
//   - runContactEnrichment(input): EnrichmentResult
//   - EnrichmentInput / EnrichmentResult types
//
// Internals are split into:
//   - state.ts     — LangGraph state schema + types
//   - helpers.ts   — pure email/domain/scrape/LinkedIn helpers
//   - prompts.ts   — LLM prompt + structured-output schema
//   - nodes.ts     — gather / research / validate / save / review nodes

import { StateGraph, END, START } from '@langchain/langgraph';
import { isLLMAvailable } from '../../llm.js';
import { log } from '../../../utils/logger.js';
import { EnrichmentState } from './state.js';
import {
  gatherNode,
  researchNode,
  validateNode,
  saveNode,
  reviewNode,
  routeAfterValidation,
} from './nodes.js';
import { runWithAgentBounds } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// 5-node enrichment DAG with one conditional branch. 30s covers the
// typical CRM search + LLM synthesis; recursionLimit 10 caps loops.
const ENRICHMENT_TIMEOUT_MS = 30_000;
const ENRICHMENT_RECURSION_LIMIT = 10;

export type { EnrichmentInput, EnrichmentResult } from './state.js';
import type { EnrichmentInput, EnrichmentResult } from './state.js';

// ─── Graph Wiring ──────────────────────────────────────────────────

const graph = new StateGraph(EnrichmentState)
  .addNode('gather', gatherNode)
  .addNode('research', researchNode)
  .addNode('validate', validateNode)
  .addNode('save', saveNode)
  .addNode('review', reviewNode)
  .addEdge(START, 'gather')
  .addEdge('gather', 'research')
  .addEdge('research', 'validate')
  .addConditionalEdges('validate', routeAfterValidation, { save: 'save', review: 'review' })
  .addEdge('save', END)
  .addEdge('review', END);

const compiledGraph = graph.compile();

// ─── Public API ────────────────────────────────────────────────────

export async function runContactEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  if (!isLLMAvailable()) {
    return {
      status: 'failed',
      enrichedData: {},
      confidence: 0,
      needsReview: false,
      sources: [],
      steps: [{ timestamp: new Date().toISOString(), node: 'agent', message: 'No LLM provider configured' }],
      error: 'No LLM provider configured',
    };
  }

  log.info('Running contact enrichment agent', { contactId: input.contactId, name: `${input.firstName} ${input.lastName}` });

  const result: any = await runWithAgentBounds(
    (config) =>
      compiledGraph.invoke(
        {
          contactId: input.contactId,
          organizationId: input.organizationId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email || null,
          company: input.company || null,
          title: input.title || null,
          crmContext: '',
          emailAnalysis: {},
          linkedDeals: [],
          documentMentions: [],
          enrichedData: {},
          confidence: 0,
          sources: [],
          status: 'pending',
          error: null,
          needsReview: false,
          steps: [],
        },
        config,
      ),
    {
      timeoutMs: ENRICHMENT_TIMEOUT_MS,
      recursionLimit: ENRICHMENT_RECURSION_LIMIT,
      envVar: 'CONTACT_ENRICHMENT_TIMEOUT_MS',
      label: 'Contact enrichment agent',
    },
  );

  return {
    status: result.status as any,
    enrichedData: result.enrichedData,
    confidence: result.confidence,
    needsReview: result.needsReview,
    sources: result.sources,
    steps: result.steps,
    error: result.error,
  };
}
