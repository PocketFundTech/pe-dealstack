/**
 * Cross-Verify Node — LangGraph node for multi-model ensemble verification.
 *
 * After GPT-4o extracts financial values, this node sends the same values
 * to Claude Haiku to independently verify them against the source text.
 * Disagreements between models flag values for human review.
 *
 * Uses claude-haiku-4-5-20251001 for cost efficiency (~$0.001-0.002 per run).
 * Gracefully degrades if ANTHROPIC_API_KEY is not set.
 */

import { anthropic, isClaudeEnabled } from '../../../../services/anthropic.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import type { FinancialAgentStateType, AgentStep } from '../state.js';
import type { ClassifiedStatement } from '../../../financialClassifier.js';
import { VERIFY_SAMPLE_SIZE } from '../config.js';
import { recordUsageEvent } from '../../../usage/trackedLLM.js';
import { enforceUserGate } from '../../../usage/enforcement.js';

// ─── Interfaces ──────────────────────────────────────────────

/** Claude's verification result for a single financial field */
export interface ClaudeVerification {
  field: string;
  primary_value: number | null;
  verified: boolean;
  your_value: number | null;
  issue: string | null;
  confidence: number;
}

/** Reconciled comparison between GPT-4o and Claude */
export interface ReconcileResult {
  agreedCount: number;
  flaggedValues: Array<{
    field: string;
    gpt4o_value: number | null;
    claude_value: number | null;
    issue: string | null;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * The list of top financial fields to cross-verify.
 * Covers key income statement, balance sheet, and cash flow metrics.
 */
const TOP_FIELDS = [
  'revenue',
  'ebitda',
  'net_income',
  'gross_profit',
  'total_assets',
  'total_liabilities',
  'total_equity',
  'operating_cf',
  'capex',
  'fcf',
  'ebitda_margin_pct',
  'gross_margin_pct',
  'long_term_debt',
  'cash',
  'interest_expense',
] as const;

/**
 * Collect top financial values from the latest period across all statements.
 * Returns a flat key-value map of field → value (millions).
 */
function collectTopValues(statements: ClassifiedStatement[]): Record<string, number | null> {
  const values: Record<string, number | null> = {};

  for (const stmt of statements) {
    if (!stmt.periods || stmt.periods.length === 0) continue;

    // Use the most recent period (last in array)
    const latestPeriod = stmt.periods[stmt.periods.length - 1];
    const lineItems = latestPeriod.lineItems;

    for (const field of TOP_FIELDS) {
      if (field in lineItems && !(field in values)) {
        values[field] = lineItems[field] ?? null;
      }
    }
  }

  return values;
}

/**
 * Build the user prompt for Claude to verify extracted values.
 */
function buildVerifyPrompt(
  extractedValues: Record<string, number | null>,
  sourceTextSample: string,
): string {
  const valueLines = Object.entries(extractedValues)
    .map(([k, v]) => `  ${k}: ${v === null ? 'null' : v}`)
    .join('\n');

  return `EXTRACTED VALUES (in millions USD unless otherwise stated):
${valueLines}

---

SOURCE TEXT (first 15K chars):
${sourceTextSample}

---

For each extracted value above, verify it against the source text.
Return ONLY a JSON array — no markdown, no explanation:
[
  {
    "field": "revenue",
    "primary_value": 125.3,
    "verified": true,
    "your_value": 125.3,
    "issue": null,
    "confidence": 95
  },
  ...
]

Rules:
- If you can confirm the value from the source, set verified=true and your_value to the same number
- If you find a discrepancy, set verified=false, your_value to what YOU see in the source, and issue to a short description
- If the field is null and you cannot find it either, set verified=true, your_value=null, issue=null
- If the field is null but you CAN find the value, set verified=false, your_value to what you found, issue="Value exists in source but was not extracted"
- confidence: 90-100 = clearly stated, 70-89 = implied, 50-69 = uncertain`;
}

// ─── Reconcile (pure function, exported for testing) ─────────

/**
 * Compare GPT-4o extracted values against Claude's verifications.
 *
 * - If both agree within 1% → increment agreedCount
 * - If they disagree or Claude says verified=false → push to flaggedValues
 *
 * @param gpt4oValues  - flat map of field → value from GPT-4o extraction
 * @param claudeResults - array of ClaudeVerification from Claude Haiku
 */
export function reconcileResults(
  gpt4oValues: Record<string, number | null>,
  claudeResults: ClaudeVerification[],
): ReconcileResult {
  const result: ReconcileResult = {
    agreedCount: 0,
    flaggedValues: [],
  };

  for (const cv of claudeResults) {
    const gptVal = gpt4oValues[cv.field] ?? null;
    const claudeVal = cv.your_value ?? null;

    if (!cv.verified) {
      // Claude explicitly flagged this as wrong
      result.flaggedValues.push({
        field: cv.field,
        gpt4o_value: gptVal,
        claude_value: claudeVal,
        issue: cv.issue,
      });
      continue;
    }

    // Both null → agree
    if (gptVal === null && claudeVal === null) {
      result.agreedCount++;
      continue;
    }

    // One null, one non-null → disagree
    if (gptVal === null || claudeVal === null) {
      result.flaggedValues.push({
        field: cv.field,
        gpt4o_value: gptVal,
        claude_value: claudeVal,
        issue: 'One model found a value, the other did not',
      });
      continue;
    }

    // Both non-null — check within 1% tolerance
    const larger = Math.max(Math.abs(gptVal), Math.abs(claudeVal));
    const diff = Math.abs(gptVal - claudeVal);
    const withinTolerance = larger === 0 ? diff === 0 : diff / larger <= 0.01;

    if (withinTolerance) {
      result.agreedCount++;
    } else {
      result.flaggedValues.push({
        field: cv.field,
        gpt4o_value: gptVal,
        claude_value: claudeVal,
        issue: `Values differ: GPT-4o=${gptVal}, Claude=${claudeVal}`,
      });
    }
  }

  return result;
}

// ─── Node Function ───────────────────────────────────────────

/**
 * LangGraph Cross-Verify Node
 *
 * Reads:  statements, rawText
 * Writes: crossVerifyResult (added to state schema in Task 12), steps
 *
 * Graceful degradation: if Claude is not configured or API fails,
 * logs the issue and returns empty steps without blocking the pipeline.
 */
export async function crossVerifyNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { statements, rawText } = state;

  // Skip if Claude not configured
  if (!isClaudeEnabled() || !anthropic) {
    steps.push(step('crossVerify', 'Skipping cross-verification — ANTHROPIC_API_KEY not configured'));
    return { steps };
  }

  // Skip if no statements to verify
  if (!statements || statements.length === 0) {
    steps.push(step('crossVerify', 'Skipping cross-verification — no statements extracted'));
    return { steps };
  }

  // Skip if no source text to verify against
  if (!rawText) {
    steps.push(step('crossVerify', 'Skipping cross-verification — no source text available'));
    return { steps };
  }

  const extractedValues = collectTopValues(statements);
  const fieldCount = Object.keys(extractedValues).length;

  steps.push(step('crossVerify', `Sending ${fieldCount} financial value(s) to Claude Haiku for cross-verification`));

  try {
    const sourceTextSample = rawText.slice(0, VERIFY_SAMPLE_SIZE);
    const userPrompt = buildVerifyPrompt(extractedValues, sourceTextSample);

    await enforceUserGate('financial_extraction', 'claude-haiku-4-5-20251001', 'anthropic');
    const start = Date.now();
    let message;
    try {
      message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system:
          'You are a financial data verification assistant. You verify extracted financial values against source documents. Respond ONLY with a valid JSON array — no markdown, no code fences, no explanation.',
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (err) {
      await recordUsageEvent({
        operation: 'financial_extraction',
        model: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        promptTokens: 0,
        completionTokens: 0,
        status: 'error',
        durationMs: Date.now() - start,
        metadata: { errorMessage: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    const claudeUsage = (message as any)?.usage;
    await recordUsageEvent({
      operation: 'financial_extraction',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      promptTokens: claudeUsage?.input_tokens ?? 0,
      completionTokens: claudeUsage?.output_tokens ?? 0,
      status: 'success',
      durationMs: Date.now() - start,
    });

    const content = message.content[0];
    if (!content || content.type !== 'text') {
      steps.push(step('crossVerify', 'Cross-verification skipped — unexpected response format from Claude'));
      return { steps };
    }

    let claudeResults: ClaudeVerification[];
    try {
      claudeResults = JSON.parse(content.text) as ClaudeVerification[];
    } catch (err) {
      steps.push(step('crossVerify', 'Cross-verification skipped — could not parse Claude response as JSON'));
      log.warn('crossVerifyNode: JSON parse failure', { raw: content.text.slice(0, 200), error: err instanceof Error ? err.message : String(err) });
      return { steps };
    }

    if (!Array.isArray(claudeResults)) {
      steps.push(step('crossVerify', 'Cross-verification skipped — Claude response was not an array'));
      return { steps };
    }

    const reconciled = reconcileResults(extractedValues, claudeResults);

    const summary = `Cross-verification complete: ${reconciled.agreedCount} agreed, ${reconciled.flaggedValues.length} flagged`;
    steps.push(step('crossVerify', summary));

    if (reconciled.flaggedValues.length > 0) {
      const flagList = reconciled.flaggedValues
        .map(f => `${f.field} (GPT-4o: ${f.gpt4o_value}, Claude: ${f.claude_value})`)
        .join(', ');
      steps.push(step('crossVerify', `Flagged values: ${flagList}`));
      log.warn('crossVerifyNode: model disagreements detected', { flagged: reconciled.flaggedValues });
    }

    return {
      steps,
      crossVerifyResult: reconciled,
    };

  } catch (error) {
    // Best-effort — don't block the pipeline
    log.warn('crossVerifyNode: Claude API call failed, continuing without cross-verification', error as object);
    captureAgentError(error, { agent: 'financialAgent', node: 'crossVerify' }, 'warning');
    steps.push(step('crossVerify', 'Cross-verification encountered an error — continuing without it'));
    return { steps };
  }
}
