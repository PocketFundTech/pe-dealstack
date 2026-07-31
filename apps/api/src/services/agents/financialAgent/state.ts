/**
 * Financial Agent — LangGraph State Schema
 *
 * This is the single state object that flows through every node in the
 * financial extraction agent graph. Each node reads what it needs and
 * writes its outputs back to state.
 *
 * Aligns with existing types:
 *   - ClassificationResult / ClassifiedStatement (financialClassifier.ts)
 *   - StatementsValidationResult / StatementCheck (financialValidator.ts)
 *   - OrchestrationInput (financialExtractionOrchestrator.ts)
 */

import { Annotation } from '@langchain/langgraph';
import type { ClassificationResult, ClassifiedStatement } from '../../financialClassifier.js';
import type { ReconcileResult } from './nodes/crossVerifyNode.js';

// ─── Supporting Types ────────────────────────────────────────────────

export type FileType = 'pdf' | 'excel' | 'image';
export type ExtractionSource = 'gpt4o' | 'azure' | 'vision' | 'manual' | 'claude';
export type AgentStatus = 'pending' | 'extracting' | 'validating' | 'self_correcting' | 'storing' | 'completed' | 'failed';

/** Matches the existing StatementCheck from financialValidator.ts */
export interface ValidationCheck {
  check: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
  period?: string;
}

export interface ValidationResult {
  checks: ValidationCheck[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  overallPassed: boolean;
}

/** A single step in the agent's execution log — powers the Agent Log tab in UI */
export interface AgentStep {
  timestamp: string;
  node: string;
  message: string;
  detail?: string;
}

/** Tracks a failed validation that needs self-correction */
export interface FailedCheck {
  statementType: string;
  period?: string;
  check: string;
  message: string;
}

// ─── LangGraph State Annotation ──────────────────────────────────────

export const FinancialAgentState = Annotation.Root({
  // ── Input (set once at graph entry) ──
  dealId: Annotation<string>,
  documentId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  fileName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  fileType: Annotation<FileType>({
    reducer: (_prev, next) => next,
    default: () => 'pdf',
  }),
  fileBuffer: Annotation<Buffer | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  organizationId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Extraction layer output ──
  rawText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  extractionSource: Annotation<ExtractionSource>({
    reducer: (_prev, next) => next,
    default: () => 'gpt4o',
  }),
  classification: Annotation<ClassificationResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Individual statement results — mutable across retries */
  statements: Annotation<ClassifiedStatement[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  // ── Confidence ──
  overallConfidence: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  // ── Validation ──
  validationResult: Annotation<ValidationResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Self-correction loop ──
  retryCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  maxRetries: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 3,
  }),
  /** Skip the verify node to reduce execution time (for serverless timeouts) */
  skipVerify: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /** Bypass the extraction cache and re-run extraction even on cache hit */
  forceExtraction: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /** True when the extracted state was served from the FinancialExtractionCache */
  fromCache: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  failedChecks: Annotation<FailedCheck[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Cross-verification result from Claude */
  crossVerifyResult: Annotation<ReconcileResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Storage output ──
  statementIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  periodsStored: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  hasConflicts: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  // ── Agent metadata ──
  status: Annotation<AgentStatus>({
    reducer: (_prev, next) => next,
    default: () => 'pending',
  }),
  warnings: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Agent execution log (append-only) ──
  steps: Annotation<AgentStep[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

/** Inferred type for use in node functions */
export type FinancialAgentStateType = typeof FinancialAgentState.State;
