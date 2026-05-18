/**
 * Verify Node — LangGraph node for two-pass extraction verification.
 *
 * After the initial extraction, this node sends the extracted values BACK
 * to GPT-4.1-mini (MODEL_FAST) along with a sample of the original source text and asks:
 *   "Do these numbers match what's in the source document?"
 *
 * This catches:
 *   - Unit scale errors (thousands vs millions vs actuals)
 *   - Transposed digits (12.5 vs 125)
 *   - Wrong row mapping (COGS value put in Revenue field)
 *   - Missing values that exist in source but weren't extracted
 *
 * Uses GPT-4.1-mini (MODEL_FAST) for cost efficiency — this is a verification check,
 * not a full extraction. Typically costs ~$0.003 per run.
 */

import { openai, isAIEnabled, trackedChatCompletion } from '../../../../openai.js';
import { MODEL_FAST } from '../../../../utils/aiModels.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import type { FinancialAgentStateType } from '../state.js';
import { VERIFY_SAMPLE_SIZE } from '../config.js';
import type { AgentStep } from '../state.js';
import type { ClassifiedStatement } from '../../../financialClassifier.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

const VERIFY_SYSTEM_PROMPT = `You are a financial data QA analyst. You will receive:
1. EXTRACTED VALUES — structured financial data that was extracted from a document
2. SOURCE TEXT — a sample of the original document text

Your job: compare the extracted values against the source text and find errors.

CHECK FOR:
- UNIT SCALE ERRORS: If the source says "$53,700" (thousands) but extracted value is 53.7 (millions), that's wrong — it should be 53.7 if in thousands or 0.0537 if in actuals
- TRANSPOSED/WRONG DIGITS: Revenue extracted as 125 but source clearly shows 152
- WRONG ROW MAPPING: A value from one line item assigned to a different field
- SIGN ERRORS: Positive value should be negative (e.g., expenses, losses)
- MISSING VALUES: Key values visible in source but null in extraction

For each issue found, return a correction.

RESPOND WITH ONLY JSON:
{
  "verified": true/false,
  "corrections": [
    {
      "statementType": "INCOME_STATEMENT",
      "period": "2023",
      "field": "revenue",
      "extractedValue": 53.7,
      "correctValue": 53700,
      "reason": "Unit scale error: source shows $53,700K (thousands), not millions"
    }
  ],
  "unitScaleIssue": null or "Source appears to be in THOUSANDS but extraction assumed MILLIONS",
  "confidence": 85
}

If everything looks correct, return: { "verified": true, "corrections": [], "unitScaleIssue": null, "confidence": 95 }`;

/**
 * Build a concise summary of extracted values for verification.
 * Keeps it short to use GPT-4.1-mini efficiently.
 */
function buildExtractionSummary(statements: ClassifiedStatement[]): string {
  const parts: string[] = [];

  for (const stmt of statements) {
    parts.push(`\n--- ${stmt.statementType} (${stmt.unitScale}, ${stmt.currency}) ---`);
    for (const p of stmt.periods) {
      const items = Object.entries(p.lineItems)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      parts.push(`Period: ${p.period} (${p.periodType}, confidence: ${p.confidence}%)\n${items}`);
    }
  }

  return parts.join('\n');
}

/**
 * LangGraph Verify Node
 *
 * Reads: statements, rawText
 * Writes: statements (corrected), overallConfidence (adjusted), steps
 */
export async function verifyNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { statements, rawText } = state;

  // Skip if flag is set (serverless timeout optimization)
  if (state.skipVerify) {
    steps.push(step('verify', 'Skipping verification (fast mode)'));
    return { steps };
  }

  // Skip if no statements or no source text to verify against
  if (!statements || statements.length === 0 || !rawText) {
    steps.push(step('verify', 'Skipping verification — no statements or source text'));
    return { steps };
  }

  // Skip if AI not available
  if (!isAIEnabled() || !openai) {
    steps.push(step('verify', 'Skipping verification — AI not configured'));
    return { steps };
  }

  const totalPeriods = statements.reduce((sum, s) => sum + s.periods.length, 0);
  steps.push(step('verify', `Verifying ${statements.length} statement(s), ${totalPeriods} period(s) against source`));

  try {
    const extractionSummary = buildExtractionSummary(statements);

    // Use a relevant sample of source text (first 15K chars — enough for verification)
    const sourceTextSample = rawText.slice(0, VERIFY_SAMPLE_SIZE);

    const response = await trackedChatCompletion('financial_extraction', {
      model: MODEL_FAST, // cheap + fast for verification
      messages: [
        { role: 'system', content: VERIFY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `EXTRACTED VALUES:\n${extractionSummary}\n\n---\n\nSOURCE TEXT:\n${sourceTextSample}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 4000,
    }, { timeout: 30000 });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      steps.push(step('verify', 'Verification skipped — no response from verifier'));
      return { steps };
    }

    const result = JSON.parse(content) as {
      verified: boolean;
      corrections: Array<{
        statementType: string;
        period: string;
        field: string;
        extractedValue: number | null;
        correctValue: number | null;
        reason: string;
      }>;
      unitScaleIssue: string | null;
      confidence: number;
    };

    // Log unit scale warning if detected
    if (result.unitScaleIssue) {
      steps.push(step('verify', `Unit scale issue detected: ${result.unitScaleIssue}`));
      log.warn('Verify node: unit scale issue', { issue: result.unitScaleIssue });
    }

    // Apply corrections
    if (result.corrections && result.corrections.length > 0) {
      steps.push(step('verify', `Found ${result.corrections.length} correction(s) — applying fixes`));

      let correctionCount = 0;
      const updatedStatements = statements.map(stmt => {
        const stmtCorrections = result.corrections.filter(
          c => normalizeStmtType(c.statementType) === stmt.statementType
        );

        if (stmtCorrections.length === 0) return stmt;

        const updatedPeriods = stmt.periods.map(p => {
          const periodCorrections = stmtCorrections.filter(c => c.period === p.period);
          if (periodCorrections.length === 0) return p;

          const updatedLineItems = { ...p.lineItems };
          for (const corr of periodCorrections) {
            const field = corr.field;
            if (field in updatedLineItems && corr.correctValue !== undefined) {
              const oldVal = updatedLineItems[field];
              updatedLineItems[field] = corr.correctValue;
              correctionCount++;
              steps.push(step('verify',
                `Corrected ${stmt.statementType} ${p.period} ${field}: ${oldVal} → ${corr.correctValue}`,
                corr.reason
              ));
            }
          }

          return { ...p, lineItems: updatedLineItems };
        });

        return { ...stmt, periods: updatedPeriods };
      });

      if (correctionCount > 0) {
        log.info('Verify node: applied corrections', { count: correctionCount });
        steps.push(step('verify', `Applied ${correctionCount} correction(s) — proceeding to validation`));

        return {
          statements: updatedStatements,
          steps,
        };
      }
    }

    // All good
    steps.push(step('verify', `Verification passed (confidence: ${result.confidence}%) — no corrections needed`));
    return { steps };

  } catch (error) {
    // Verification is best-effort — don't block the pipeline on failure
    log.warn('Verify node: verification failed, continuing without corrections', error as object);
    captureAgentError(error, { agent: 'financialAgent', node: 'verify' }, 'warning');
    steps.push(step('verify', 'Verification encountered an error — continuing without corrections'));
    return { steps };
  }
}

/** Normalize statement type strings from GPT response */
function normalizeStmtType(raw: string): string {
  const upper = String(raw || '').toUpperCase().replace(/\s+/g, '_');
  if (upper.includes('INCOME') || upper.includes('P_AND_L') || upper.includes('PNL')) return 'INCOME_STATEMENT';
  if (upper.includes('BALANCE')) return 'BALANCE_SHEET';
  if (upper.includes('CASH')) return 'CASH_FLOW';
  return upper;
}
