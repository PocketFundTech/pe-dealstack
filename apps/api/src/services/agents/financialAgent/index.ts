/**
 * Financial Agent — Public entry point.
 *
 * Usage:
 *   import { runFinancialAgent } from './services/agents/financialAgent/index.js';
 *
 *   const result = await runFinancialAgent({
 *     dealId: '...',
 *     documentId: '...',
 *     fileBuffer: Buffer.from(...),
 *     fileName: 'CIM.pdf',
 *     fileType: 'pdf',
 *   });
 *
 *   // result.status === 'completed' | 'failed'
 *   // result.steps[] — full agent execution log
 *   // result.statementIds — stored DB row IDs
 *   // result.validationResult — math check results
 */

import { getFinancialAgentGraph } from './graph.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import type { FileType, FinancialAgentStateType } from './state.js';
import type { ReconcileResult } from './nodes/crossVerifyNode.js';
import { DEFAULT_MAX_RETRIES } from './config.js';
import { runWithAgentBounds } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// Multi-pass extraction (extract → verify → cross-verify → validate →
// self-correct → store) can legitimately take 60-90s on large CIMs.
// 120s budget leaves headroom; recursionLimit 25 covers worst-case
// (3 self-correct retries × ~7 hops each).
//
// Refs: .planning/REMEDIATION_ROADMAP.md Phase 4 Task 4.3
const FINANCIAL_AGENT_TIMEOUT_MS = 120_000;
const FINANCIAL_AGENT_RECURSION_LIMIT = 25;

// ─── Input Types ─────────────────────────────────────────────

export interface FinancialAgentInput {
  dealId: string;
  documentId?: string | null;
  fileBuffer: Buffer;
  fileName: string;
  fileType: FileType;
  organizationId?: string | null;
  /** Max self-correction retries (default 3) */
  maxRetries?: number;
  /** Bypass the FinancialExtractionCache and re-run LLM extraction even on hit */
  forceExtraction?: boolean;
}

export interface FinancialAgentResult {
  status: FinancialAgentStateType['status'];
  statementIds: string[];
  periodsStored: number;
  hasConflicts: boolean;
  overallConfidence: number;
  extractionSource: string;
  validationResult: FinancialAgentStateType['validationResult'];
  retryCount: number;
  warnings: string[];
  error: string | null;
  steps: FinancialAgentStateType['steps'];
  crossVerifyResult: ReconcileResult | null;
  /** True if the extracted classification was served from the cache */
  fromCache: boolean;
}

// ─── Run Agent ───────────────────────────────────────────────

export async function runFinancialAgent(
  input: FinancialAgentInput,
): Promise<FinancialAgentResult> {
  const startTime = Date.now();

  log.info('Financial agent starting', {
    dealId: input.dealId,
    documentId: input.documentId,
    fileName: input.fileName,
    fileType: input.fileType,
    fileSizeKB: Math.round(input.fileBuffer.length / 1024),
  });

  try {
    const graph = getFinancialAgentGraph();

    const finalState: any = await runWithAgentBounds(
      (config) =>
        graph.invoke(
          {
            dealId: input.dealId,
            documentId: input.documentId ?? null,
            fileBuffer: input.fileBuffer,
            fileName: input.fileName,
            fileType: input.fileType,
            organizationId: input.organizationId ?? null,
            maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
            skipVerify: false,
            forceExtraction: input.forceExtraction ?? false,
          },
          config,
        ),
      {
        timeoutMs: FINANCIAL_AGENT_TIMEOUT_MS,
        recursionLimit: FINANCIAL_AGENT_RECURSION_LIMIT,
        envVar: 'FINANCIAL_AGENT_TIMEOUT_MS',
        label: 'Financial agent',
      },
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    log.info('Financial agent completed', {
      dealId: input.dealId,
      status: finalState.status,
      periodsStored: finalState.periodsStored,
      overallConfidence: finalState.overallConfidence,
      retryCount: finalState.retryCount,
      hasConflicts: finalState.hasConflicts,
      fromCache: finalState.fromCache ?? false,
      elapsedSeconds: elapsed,
      totalSteps: finalState.steps?.length ?? 0,
    });

    return {
      status: finalState.status,
      statementIds: finalState.statementIds ?? [],
      periodsStored: finalState.periodsStored ?? 0,
      hasConflicts: finalState.hasConflicts ?? false,
      overallConfidence: finalState.overallConfidence ?? 0,
      extractionSource: finalState.extractionSource ?? 'gpt4o',
      validationResult: finalState.validationResult ?? null,
      retryCount: finalState.retryCount ?? 0,
      warnings: finalState.warnings ?? [],
      error: finalState.error ?? null,
      steps: finalState.steps ?? [],
      crossVerifyResult: finalState.crossVerifyResult ?? null,
      fromCache: finalState.fromCache ?? false,
    };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.error('Financial agent failed', { dealId: input.dealId, elapsedSeconds: elapsed, error: err });
    captureAgentError(err, { agent: 'financialAgent', node: 'invoke' });

    return {
      status: 'failed',
      statementIds: [],
      periodsStored: 0,
      hasConflicts: false,
      overallConfidence: 0,
      extractionSource: 'gpt4o',
      validationResult: null,
      retryCount: 0,
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
      crossVerifyResult: null,
      fromCache: false,
      steps: [{
        timestamp: new Date().toISOString(),
        node: 'agent',
        message: `Agent crashed: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}

// Re-export types for convenience
export type { FileType, FinancialAgentStateType } from './state.js';
export type { AgentStep, ValidationResult } from './state.js';
