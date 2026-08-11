/**
 * Self-Correct Node — LangGraph node for the financial extraction agent.
 *
 * THE KILLER FEATURE: When validation fails, this node:
 *   1. Reads the failedChecks (math errors, low confidence periods)
 *   2. Builds a targeted AI prompt explaining exactly what's wrong
 *   3. Asks the model to re-extract only the failing statement/periods
 *   4. Merges corrected data back into the statements array
 *   5. Increments retryCount so the graph loops back to Validate
 *
 * If rawText is empty (vision path), falls back to Vision re-extraction.
 * Max retries controlled by state.maxRetries (default 3).
 */

import { openai, isAIEnabled, trackedChatCompletion } from '../../../../openai.js';
import { MODEL_CLASSIFICATION } from '../../../../utils/aiModels.js';
import { classifyFinancialsVision } from '../../../visionExtractor.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import {
  normalizeClassificationResult,
  applyExplicitUnitOverride,
  applySmallDollarActualsOverride,
  applySourceTextDollarOverride,
  detectExplicitUnitInText,
  hasExplicitSmallDollarAmounts,
  type ClassifiedStatement,
  type ClassificationResult,
} from '../../../financialClassifier.js';
import type { FinancialAgentStateType } from '../state.js';
import type { AgentStep, FailedCheck } from '../state.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * Build a targeted correction prompt that tells the model exactly what went wrong.
 */
function buildCorrectionPrompt(failedChecks: FailedCheck[], rawText: string): string {
  const issueDescriptions = failedChecks.map((fc, i) => {
    if (fc.check === 'low_confidence') {
      return `${i + 1}. ${fc.statementType} for period ${fc.period ?? 'unknown'}: ${fc.message}. Please re-extract this data more carefully.`;
    }
    return `${i + 1}. ${fc.statementType} for period ${fc.period ?? 'all'}: ${fc.message}. Please find the correct values.`;
  }).join('\n');

  const targetStatements = [...new Set(failedChecks.map(fc => fc.statementType))];
  const targetPeriods = [...new Set(failedChecks.map(fc => fc.period).filter(Boolean))];

  return `You are a senior financial analyst re-checking extracted financial data. The previous extraction had validation errors that need correction.

ISSUES FOUND:
${issueDescriptions}

TASK: Re-extract ONLY the following from the document text below:
- Statement types: ${targetStatements.join(', ')}
${targetPeriods.length > 0 ? `- Periods: ${targetPeriods.join(', ')}` : '- All periods for the affected statements'}

RULES:
1. Focus specifically on the issues listed above
2. Double-check your math: Revenue - COGS must equal Gross Profit, Assets must equal Liabilities + Equity, etc.
3. If a value truly cannot be determined from the text, use null — do not guess
4. Preserve the source's unit scale. Set unitScale to whatever the source uses: MILLIONS, THOUSANDS, ACTUALS, or BILLIONS. Do NOT convert values — store them at the source's scale (e.g., a startup spreadsheet showing "$6,700" in actual dollars stays as 6700 with unitScale "ACTUALS", NOT 0.0067 with "MILLIONS").
5. confidence: only use 90+ if you are certain the value is correct

INCOME STATEMENT line item keys:
revenue, cogs, gross_profit, gross_margin_pct, sga, rd, other_opex, total_opex,
ebitda, ebitda_margin_pct, da, ebit, interest_expense, ebt, tax, net_income, sde

BALANCE SHEET line item keys:
cash, accounts_receivable, inventory, other_current_assets, total_current_assets,
ppe_net, goodwill, intangibles, total_assets,
accounts_payable, short_term_debt, other_current_liabilities, total_current_liabilities,
long_term_debt, total_liabilities, total_equity

CASH FLOW line item keys:
operating_cf, capex, fcf, acquisitions, debt_repayment, dividends, net_change_cash

Return ONLY valid JSON. Set unitScale to whatever matches the source: "MILLIONS" | "THOUSANDS" | "ACTUALS" | "BILLIONS". Example below uses THOUSANDS — do NOT default to MILLIONS, mirror the source:
{
  "statements": [
    {
      "statementType": "BALANCE_SHEET",
      "unitScale": "<MILLIONS|THOUSANDS|ACTUALS|BILLIONS — match the source>",
      "currency": "USD",
      "periods": [
        {
          "period": "2023",
          "periodType": "HISTORICAL",
          "confidence": 92,
          "lineItems": { ... }
        }
      ]
    }
  ],
  "overallConfidence": 88,
  "warnings": []
}

DOCUMENT TEXT:
${rawText.slice(0, 30000)}`;
}

/**
 * Merge corrected statements back into the original statements array.
 * Only replaces periods that were re-extracted — keeps everything else intact.
 */
function mergeStatements(
  original: ClassifiedStatement[],
  corrections: ClassifiedStatement[],
): ClassifiedStatement[] {
  const merged = [...original];

  for (const correction of corrections) {
    const existingIdx = merged.findIndex(s => s.statementType === correction.statementType);

    if (existingIdx === -1) {
      // New statement type from correction — add it
      merged.push(correction);
      continue;
    }

    // Replace matching periods, keep the rest
    const existing = merged[existingIdx];
    for (const correctedPeriod of correction.periods) {
      const periodIdx = existing.periods.findIndex(p => p.period === correctedPeriod.period);
      if (periodIdx !== -1) {
        // Only replace if correction has higher confidence
        if (correctedPeriod.confidence >= existing.periods[periodIdx].confidence) {
          existing.periods[periodIdx] = correctedPeriod;
        }
      } else {
        existing.periods.push(correctedPeriod);
      }
    }
  }

  return merged;
}

/**
 * LangGraph Self-Correct Node
 *
 * Reads: failedChecks, rawText, fileBuffer, fileName, statements, retryCount
 * Writes: statements, overallConfidence, retryCount, status, steps
 */
export async function selfCorrectNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { failedChecks, rawText, fileBuffer, fileName, statements, retryCount } = state;

  if (!failedChecks || failedChecks.length === 0) {
    steps.push(step('self_correct', 'No failed checks — nothing to correct'));
    return { status: 'storing', steps };
  }

  const targetTypes = [...new Set(failedChecks.map(fc => fc.statementType))];
  const targetPeriods = [...new Set(failedChecks.map(fc => fc.period).filter(Boolean))];

  steps.push(step(
    'self_correct',
    `Attempting correction (retry ${retryCount + 1}): ${failedChecks.length} issue(s) in ${targetTypes.join(', ')}`,
    targetPeriods.length > 0 ? `Periods: ${targetPeriods.join(', ')}` : undefined,
  ));

  try {
    let correctedClassification: ClassificationResult | null = null;

    // ── Text path: targeted AI re-extraction ──
    if (rawText && rawText.trim().length >= 200 && isAIEnabled() && openai) {
      steps.push(step('self_correct', 'Re-extracting with targeted AI prompt'));

      const prompt = buildCorrectionPrompt(failedChecks, rawText);

      const response = await trackedChatCompletion('financial_extraction', {
        model: MODEL_CLASSIFICATION, // GPT-4.1 — requires response_format: json_object (incompatible with Claude)
        messages: [
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.05,
        max_tokens: 16000,
      }, { timeout: 90000 });

      const content = response.choices[0]?.message?.content;
      if (content) {
        // The targeted-correction LLM call bypasses classifyFinancials() and
        // hence its post-processing. Run the same normalize + override
        // pipeline here so unit-scale classifications coming back from the
        // correction model don't sneak past the deterministic guards.
        const rawCorrection = JSON.parse(content) as unknown;
        correctedClassification = normalizeClassificationResult(rawCorrection);
        const explicitUnit = detectExplicitUnitInText(rawText);
        const hasSmallDollars = hasExplicitSmallDollarAmounts(rawText);
        applyExplicitUnitOverride(correctedClassification, explicitUnit);
        applySmallDollarActualsOverride(correctedClassification, hasSmallDollars, explicitUnit);
        applySourceTextDollarOverride(correctedClassification);
        steps.push(step(
          'self_correct',
          `AI returned ${correctedClassification.statements?.length ?? 0} corrected statement(s)`,
        ));
      }
    }

    // ── Vision fallback: re-run full Vision extraction ──
    if (!correctedClassification && fileBuffer && fileBuffer.length > 0) {
      steps.push(step('self_correct', 'Text unavailable — re-extracting with AI Vision'));
      correctedClassification = await classifyFinancialsVision(fileBuffer, fileName || 'document.pdf');

      if (correctedClassification) {
        steps.push(step(
          'self_correct',
          `Vision returned ${correctedClassification.statements?.length ?? 0} statement(s)`,
        ));
      }
    }

    // ── No correction possible ──
    if (!correctedClassification || !correctedClassification.statements?.length) {
      steps.push(step('self_correct', 'Could not obtain corrected data — proceeding with original'));
      return {
        retryCount: retryCount + 1,
        status: 'validating',
        steps,
      };
    }

    // ── Merge corrections into original statements ──
    const mergedStatements = mergeStatements(statements, correctedClassification.statements);

    // Re-apply the deterministic unit guards across the MERGED statements.
    // mergeStatements may have copied a corrected period into a statement
    // whose unitScale (set at the original-extraction LLM stage) was wrong.
    // The source-quote dollar override is cheap, idempotent on already-
    // ACTUALS rows, and the canonical hook before storeNode — running it
    // here catches mis-tagged synthesized periods (LTM / Current Month)
    // that the initial extraction missed.
    //
    // RETRO-FIX (manual SQL for already-persisted bad rows on a deal):
    //   UPDATE "FinancialStatement"
    //   SET "unitScale" = 'ACTUALS'
    //   WHERE "dealId" = '<dealId>'
    //     AND "unitScale" IN ('MILLIONS','THOUSANDS','BILLIONS')
    //     AND ("lineItems"::jsonb -> 'revenue_source')::text ~ '\$\s*\d{1,3}(,\d{3})*(\.\d+)?'
    //     AND ABS(("lineItems"::jsonb ->> 'revenue')::numeric) < 100000;
    // (Cast/regex tweaks may be needed; the JSONB column is at lineItems.)
    const mergedClassification: ClassificationResult = {
      statements: mergedStatements,
      overallConfidence: state.overallConfidence,
      warnings: state.warnings,
    };
    applySourceTextDollarOverride(mergedClassification);

    // Recalculate overall confidence from merged data
    const allConfidences: number[] = [];
    for (const stmt of mergedStatements) {
      for (const p of stmt.periods) {
        allConfidences.push(p.confidence);
      }
    }
    const newConfidence = allConfidences.length > 0
      ? Math.round(allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length)
      : 0;

    const improvementMsg = newConfidence > state.overallConfidence
      ? `Confidence improved: ${state.overallConfidence}% → ${newConfidence}%`
      : `Confidence unchanged: ${newConfidence}%`;
    steps.push(step('self_correct', `Merged corrections into statements. ${improvementMsg}`));

    return {
      statements: mergedStatements,
      overallConfidence: newConfidence,
      retryCount: retryCount + 1,
      status: 'validating',
      warnings: [
        ...state.warnings,
        ...(correctedClassification.warnings ?? []),
      ],
      steps,
    };
  } catch (err) {
    log.error('Self-correct node: error during correction', err);
    captureAgentError(err, { agent: 'financialAgent', node: 'selfCorrect' }, 'warning');
    steps.push(step('self_correct', 'Correction attempt failed', String(err)));

    return {
      retryCount: retryCount + 1,
      status: 'validating',
      steps,
    };
  }
}
