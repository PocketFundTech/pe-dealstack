/**
 * Financial Agent Graph — LangGraph state machine.
 *
 * Wires the 5 nodes together with conditional edges:
 *
 *   START → extract → verify → validate ──→ store → END
 *                                  │                  ↑
 *                                  └→ self_correct ───┘
 *                                     (loops back to validate, max 3 retries)
 *
 * The verify node (two-pass verification) compares extracted values against
 * the source text using GPT-4.1-mini and auto-corrects unit scale errors,
 * transposed digits, and wrong row mappings before validation runs.
 *
 * Each node reads/writes to the shared FinancialAgentState.
 * The validate node decides whether to self-correct or store
 * based on failed checks and retry count.
 */

import { StateGraph, END, START } from '@langchain/langgraph';
import { FinancialAgentState } from './state.js';
import { extractNode } from './nodes/extractNode.js';
import { verifyNode } from './nodes/verifyNode.js';
import { crossVerifyNode } from './nodes/crossVerifyNode.js';
import { validateNode } from './nodes/validateNode.js';
import { selfCorrectNode } from './nodes/selfCorrectNode.js';
import { storeNode } from './nodes/storeNode.js';
import type { FinancialAgentStateType } from './state.js';

// ─── Routing Functions ───────────────────────────────────────

/** After extract: if failed go to END, otherwise go to verify */
function routeAfterExtract(state: FinancialAgentStateType): string {
  if (state.status === 'failed') return END;
  return 'verify';
}

/** After validate: route based on status set by validate node */
export function routeAfterValidate(state: FinancialAgentStateType): string {
  // Claude engine repairs inside extract (max 1 pass, spec 2026-07-11) —
  // never route claude output into the GPT self-correct loop.
  if (state.extractionSource === 'claude') return 'store';
  if (state.status === 'self_correcting') return 'self_correct';
  return 'store'; // 'storing' or anything else → store
}

/** After self-correct: always go back to validate for re-check */
function routeAfterSelfCorrect(_state: FinancialAgentStateType): string {
  return 'validate';
}

// ─── Build Graph ─────────────────────────────────────────────

function buildFinancialAgentGraph() {
  const graph = new StateGraph(FinancialAgentState)
    // Add nodes
    .addNode('extract', extractNode)
    .addNode('verify', verifyNode)
    .addNode('cross_verify', crossVerifyNode)
    .addNode('validate', validateNode)
    .addNode('self_correct', selfCorrectNode)
    .addNode('store', storeNode)

    // Entry edge
    .addEdge(START, 'extract')

    // Extract → Verify (or END if failed)
    .addConditionalEdges('extract', routeAfterExtract, {
      verify: 'verify',
      [END]: END,
    })

    // Verify → Cross-Verify → Validate (both best-effort)
    .addEdge('verify', 'cross_verify')
    .addEdge('cross_verify', 'validate')

    // Validate → self_correct or store
    .addConditionalEdges('validate', routeAfterValidate, {
      self_correct: 'self_correct',
      store: 'store',
    })
    .addConditionalEdges('self_correct', routeAfterSelfCorrect, {
      validate: 'validate',
    })

    // Store always ends
    .addEdge('store', END);

  return graph.compile();
}

/** Singleton compiled graph — reused across requests */
let _compiledGraph: ReturnType<typeof buildFinancialAgentGraph> | null = null;

export function getFinancialAgentGraph() {
  if (!_compiledGraph) {
    _compiledGraph = buildFinancialAgentGraph();
  }
  return _compiledGraph;
}
