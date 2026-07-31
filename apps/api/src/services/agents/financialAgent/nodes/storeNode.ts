/**
 * Store Node — LangGraph node for the financial extraction agent.
 *
 * Persists validated financial statements to Supabase via the existing
 * runDeepPass() orchestrator. This reuses all the conflict detection,
 * merge status, and partial unique index logic already built.
 *
 * Does NOT duplicate any DB logic — delegates entirely to runDeepPass().
 */

import { runDeepPass } from '../../../financialExtractionOrchestrator.js';
import { recordExtractionLearning } from '../../../agentMemory.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import type { FinancialAgentStateType } from '../state.js';
import type { AgentStep } from '../state.js';
import type { ClassifiedStatement } from '../../../financialClassifier.js';
import { CLAUDE_NATIVE_PDF_MARKER } from '../../../extraction/claudeEngine.js';
import {
  computeCompositeConfidence,
  getConfidenceTier,
  scoreSourceMatch,
  scoreMathValidation,
  scoreCrossModel,
} from '../../../compositeConfidence.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * Marker prefix set by the Claude engine's native-PDF path (claudeEngine.ts)
 * when there's no real text layer to check sourceQuotes against — native
 * PDF input replaces pdf-parse entirely for that path, so scoreSourceMatch's
 * substring check has nothing real to compare against.
 */
export { CLAUDE_NATIVE_PDF_MARKER } from '../../../extraction/claudeEngine.js';

/** A bare page marker (no quote captured) carries the same evidentiary
 * weight as "no source" — the model didn't cite anything checkable. */
function isBarePageMarker(sourceValue: string): boolean {
  const trimmed = sourceValue.trim();
  // An empty/whitespace-only quote carries the same evidentiary weight as a
  // bare page marker — no real citation was captured, matching legacy
  // scoreSourceMatch's treatment of a falsy quote (compositeConfidence.ts).
  return trimmed === '' || /^p(\d+|\?)$/.test(trimmed);
}

/**
 * Score a single _source value when there's no real text layer to check it
 * against. The structured extraction schema REQUIRES sourcePage/sourceQuote
 * per line item (extractionSchema.ts), so a well-formed quote is a real —
 * if unverified — provenance signal: better than no citation at all, but
 * not confirmable the way a text-layer substring match is. Deliberately
 * scored below scoreSourceMatch's 100 (confirmed) and 80 (partial) tiers.
 */
function scoreClaudeNativePdfSource(sourceValue: string): number {
  return isBarePageMarker(sourceValue) ? 20 : 75;
}

/**
 * Average source-match confidence across every _source field in the
 * extracted statements. Exported as a pure function for testing (mirrors
 * the `reconcileResults` "exported for testing" convention in
 * crossVerifyNode.ts).
 *
 * When rawText carries CLAUDE_NATIVE_PDF_MARKER, scoreSourceMatch's
 * text-substring check is skipped in favor of scoreClaudeNativePdfSource —
 * there's no real document text to check citations against. Claude-Excel
 * extractions (rawText = real converted Excel text) still use
 * scoreSourceMatch normally, as do all legacy (gpt4o/azure/vision) sources.
 */
export function computeSourceMatchAvg(
  statements: ClassifiedStatement[],
  rawText: string,
): number {
  if (!rawText || statements.length === 0) return 20; // default if no source quotes

  const usesClaudeNativePdf = rawText.startsWith(CLAUDE_NATIVE_PDF_MARKER);
  const scores: number[] = [];
  for (const stmt of statements) {
    for (const period of stmt.periods) {
      for (const [key, val] of Object.entries(period.lineItems || {})) {
        if (key.endsWith('_source') && typeof val === 'string') {
          scores.push(usesClaudeNativePdf ? scoreClaudeNativePdfSource(val) : scoreSourceMatch(val, rawText));
        }
      }
    }
  }
  if (scores.length === 0) return 20;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/**
 * LangGraph Store Node
 *
 * Reads: dealId, documentId, statements, classification, rawText, extractionSource
 * Writes: statementIds, periodsStored, hasConflicts, status, steps
 */
export async function storeNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { dealId, documentId, statements, classification, rawText, extractionSource, crossVerifyResult } = state;

  if (!statements || statements.length === 0) {
    steps.push(step('store', 'No statements to store'));
    return {
      statementIds: [],
      periodsStored: 0,
      hasConflicts: false,
      status: 'completed',
      steps: [...steps, step('store', 'Agent completed — no financial data extracted')],
    };
  }

  const stmtTypes = statements.map(s => s.statementType).join(', ');
  const totalPeriods = statements.reduce((sum, s) => sum + s.periods.length, 0);
  steps.push(step('store', `Storing ${stmtTypes} (${totalPeriods} periods) to database`));

  try {
    // Build a ClassificationResult from the current (possibly corrected) statements
    const classificationToStore = {
      statements,
      overallConfidence: state.overallConfidence,
      warnings: state.warnings,
    };

    // Compute composite confidence
    const mathScore = scoreMathValidation(
      state.validationResult?.errorCount ?? 0,
      state.validationResult?.warningCount ?? 0,
    );

    const crossModelScore = crossVerifyResult
      ? scoreCrossModel(crossVerifyResult.agreedCount, crossVerifyResult.flaggedValues.length)
      : null;

    // Average source match across all periods
    const sourceMatchAvg = computeSourceMatchAvg(statements, rawText);

    const compositeScore = computeCompositeConfidence({
      llmConfidence: state.overallConfidence,
      sourceMatch: sourceMatchAvg,
      mathValidation: mathScore,
      crossModelAgreement: crossModelScore,
    });

    const tier = getConfidenceTier(compositeScore);
    steps.push(step('store', `Composite confidence: ${compositeScore}% (tier: ${tier})`,
      `LLM: ${state.overallConfidence}%, Source: ${sourceMatchAvg}%, Math: ${mathScore}%, CrossModel: ${crossModelScore ?? 'N/A'}%`));

    // Add warnings for cross-verify flagged values
    if (crossVerifyResult && crossVerifyResult.flaggedValues.length > 0) {
      const flagWarnings = crossVerifyResult.flaggedValues.map(f =>
        `Cross-verification disagreement on ${f.field}: primary=${f.gpt4o_value}, verified=${f.claude_value}${f.issue ? ` (${f.issue})` : ''}`
      );
      classificationToStore.warnings = [
        ...(classificationToStore.warnings || []),
        ...flagWarnings,
      ];
      steps.push(step('store',
        `${crossVerifyResult.flaggedValues.length} values flagged by cross-verification`,
        flagWarnings.join('; '),
      ));
    }

    // Confidence-gated storage
    if (tier === 'very_low') {
      steps.push(step('store', 'Confidence too low (<60%) — NOT storing. User must review manually.'));
      return {
        status: 'completed',
        overallConfidence: compositeScore,
        warnings: [...(state.warnings || []), `Extraction confidence too low (${compositeScore}%). Manual review required.`],
        steps,
      };
    }

    const result = await runDeepPass({
      text: rawText,
      dealId,
      documentId: documentId ?? undefined,
      classification: classificationToStore,
      extractionSource,
    });

    if (!result) {
      steps.push(step('store', 'runDeepPass returned null — storage failed'));
      return {
        status: 'failed',
        error: 'Failed to store financial statements',
        steps,
      };
    }

    steps.push(step(
      'store',
      `Stored ${result.periodsStored} periods (${result.statementsStored} statement types)`,
      result.hasConflicts ? 'Conflicts detected — flagged for user review' : undefined,
    ));

    if (result.hasConflicts) {
      steps.push(step('store', 'Multi-document conflicts found — existing data flagged as needs_review'));
    }

    // Final completion step with summary
    const validationSummary = state.validationResult
      ? `Validation: ${state.validationResult.errorCount} errors, ${state.validationResult.warningCount} warnings`
      : 'Validation: not run';
    const retrySummary = state.retryCount > 0
      ? `Self-corrections: ${state.retryCount}`
      : 'Self-corrections: none needed';

    steps.push(step('store', `Done. ${validationSummary}. ${retrySummary}. Confidence: ${state.overallConfidence}%`));

    // Fire-and-forget: record extraction learning for agent memory
    if (state.organizationId) {
      const docPattern = state.fileName.replace(/\.[^.]+$/, '').replace(/[0-9_-]+/g, '').trim() || 'general';
      recordExtractionLearning(
        state.organizationId,
        docPattern,
        state.fileType,
        extractionSource,
        state.overallConfidence,
      ).catch(() => {});
    }

    return {
      statementIds: result.statementIds,
      periodsStored: result.periodsStored,
      hasConflicts: result.hasConflicts,
      status: 'completed',
      steps,
    };
  } catch (err) {
    log.error('Store node: error persisting statements', err);
    captureAgentError(err, { agent: 'financialAgent', node: 'store' });
    return {
      status: 'failed',
      error: `Storage failed: ${err instanceof Error ? err.message : String(err)}`,
      steps: [...steps, step('store', 'Storage failed', String(err))],
    };
  }
}
