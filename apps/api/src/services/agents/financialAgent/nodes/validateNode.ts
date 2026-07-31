/**
 * Validate Node — LangGraph node for the financial extraction agent.
 *
 * Runs the existing 3-statement validation suite on extracted statements:
 *   - Income statement math (Revenue - COGS = GP, EBITDA < Revenue, etc.)
 *   - Balance sheet balances (Assets = Liabilities + Equity)
 *   - Cash flow math (FCF = Operating CF - CapEx)
 *   - YoY growth sanity (flags >100% or <-50% swings)
 *   - Confidence threshold check (flags periods below 70%)
 *
 * Also checks for low-confidence periods that may benefit from re-extraction.
 *
 * Wraps existing validateStatements() — no validation logic duplicated.
 */

import { validateStatements } from '../../../financialValidator.js';
import type { FinancialAgentStateType } from '../state.js';
import type { AgentStep, FailedCheck, ValidationResult } from '../state.js';
import { CONFIDENCE_THRESHOLD } from '../config.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * LangGraph Validate Node
 *
 * Reads: statements, overallConfidence
 * Writes: validationResult, failedChecks, status, steps
 */
export async function validateNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { statements, overallConfidence, retryCount, maxRetries, extractionSource } = state;

  // No statements to validate — pass through
  if (!statements || statements.length === 0) {
    steps.push(step('validate', 'No statements to validate — skipping'));
    return {
      validationResult: {
        checks: [],
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        overallPassed: true,
      },
      failedChecks: [],
      status: 'storing',
      steps,
    };
  }

  const stmtTypes = statements.map(s => s.statementType).join(', ');
  const totalPeriods = statements.reduce((sum, s) => sum + s.periods.length, 0);
  steps.push(step('validate', `Validating ${stmtTypes} (${totalPeriods} periods)`));

  // ── Run existing 3-statement validation ──
  const result = validateStatements(statements);

  const validationResult: ValidationResult = {
    checks: result.checks.map(c => ({
      check: c.check,
      passed: c.passed,
      severity: c.severity,
      message: c.message,
      period: c.period,
    })),
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    infoCount: result.infoCount,
    overallPassed: result.overallPassed,
  };

  // Log summary
  const failedErrors = result.checks.filter(c => !c.passed && c.severity === 'error');
  const failedWarnings = result.checks.filter(c => !c.passed && c.severity === 'warning');

  if (failedErrors.length > 0) {
    steps.push(step('validate', `Found ${failedErrors.length} error(s)`, failedErrors.map(c => c.message).join('; ')));
  }
  if (failedWarnings.length > 0) {
    steps.push(step('validate', `Found ${failedWarnings.length} warning(s)`, failedWarnings.map(c => c.message).join('; ')));
  }
  if (failedErrors.length === 0 && failedWarnings.length === 0) {
    steps.push(step('validate', 'All math checks passed'));
  }

  // ── Check for low-confidence periods ──
  const lowConfidencePeriods: { statementType: string; period: string; confidence: number }[] = [];
  for (const stmt of statements) {
    for (const p of stmt.periods) {
      if (p.confidence < CONFIDENCE_THRESHOLD) {
        lowConfidencePeriods.push({
          statementType: stmt.statementType,
          period: p.period,
          confidence: p.confidence,
        });
      }
    }
  }

  if (lowConfidencePeriods.length > 0) {
    const summary = lowConfidencePeriods.map(p => `${p.statementType} ${p.period} (${p.confidence}%)`).join(', ');
    steps.push(step('validate', `Low confidence periods: ${summary}`));
  }

  // ── Build failedChecks list for self-correction ──
  const failedChecks: FailedCheck[] = [];

  // Add math errors that need re-extraction
  for (const check of failedErrors) {
    failedChecks.push({
      statementType: inferStatementType(check.check),
      period: check.period,
      check: check.check,
      message: check.message,
    });
  }

  // Add low-confidence periods
  for (const lcp of lowConfidencePeriods) {
    failedChecks.push({
      statementType: lcp.statementType,
      period: lcp.period,
      check: 'low_confidence',
      message: `Confidence ${lcp.confidence}% is below threshold (${CONFIDENCE_THRESHOLD}%)`,
    });
  }

  // ── Decide next status ──
  const hasActionableFailures = failedChecks.length > 0;
  // The claude engine already ran its own single repair pass inside extract
  // (spec 2026-07-11) — never claim a self-correction attempt for it. This
  // mirrors graph.ts's routeAfterValidate guard (which independently forces
  // claude-sourced state to 'store'); doing it here too keeps state.status
  // and the user-visible Agent Log accurate rather than relying solely on
  // the router to silently discard a misleading 'self_correcting' status.
  const canSelfCorrect = extractionSource !== 'claude' && retryCount < maxRetries;

  let nextStatus: FinancialAgentStateType['status'];
  if (hasActionableFailures && canSelfCorrect) {
    nextStatus = 'self_correcting';
    steps.push(step('validate', `${failedChecks.length} issue(s) found — routing to self-correction (attempt ${retryCount + 1}/${maxRetries})`));
  } else if (hasActionableFailures && extractionSource === 'claude') {
    nextStatus = 'storing';
    steps.push(step('validate', `${failedChecks.length} issue(s) remain — claude engine's repair pass already ran; storing with flags for human review`));
  } else if (hasActionableFailures) {
    nextStatus = 'storing';
    steps.push(step('validate', `${failedChecks.length} issue(s) remain after ${maxRetries} retries — storing with flags for human review`));
  } else {
    nextStatus = 'storing';
    steps.push(step('validate', 'Validation passed — proceeding to store'));
  }

  return {
    validationResult,
    failedChecks,
    status: nextStatus,
    steps,
  };
}

/** Infer which statement type a check key belongs to */
function inferStatementType(check: string): string {
  if (check.startsWith('bs_')) return 'BALANCE_SHEET';
  if (check.startsWith('cf_')) return 'CASH_FLOW';
  if (check.startsWith('is_') || check.startsWith('yoy_')) return 'INCOME_STATEMENT';
  return 'UNKNOWN';
}
