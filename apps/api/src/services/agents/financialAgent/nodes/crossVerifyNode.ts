/**
 * Cross-Verify Node — LangGraph node for multi-model ensemble verification.
 *
 * After GPT-4o extracts financial values, this node sends the same values
 * to Claude Haiku to independently verify them against the source text.
 * Disagreements between models flag values for human review.
 *
 * Uses claude-haiku-4-5-20251001 for cost efficiency (~$0.001-0.002 per run).
 * Gracefully degrades if neither ANTHROPIC_API_KEY nor ANTHROPIC_OAUTH_TOKEN
 * is set.
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { isClaudeEnabled, getChatAnthropicAuthFields } from '../../../../services/anthropic.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import { getTodayIso } from '../../../../utils/dates.js';
import type { FinancialAgentStateType, AgentStep } from '../state.js';
import type { ClassifiedStatement } from '../../../financialClassifier.js';
import { VERIFY_SAMPLE_SIZE } from '../config.js';
import { recordUsageEvent } from '../../../usage/trackedLLM.js';
import { enforceUserGate } from '../../../usage/enforcement.js';
import { withCircuitBreaker } from '../../../aiCircuitBreaker.js';

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

/** Per-field metadata captured alongside the value, so the verifier knows what scale to interpret each value at. */
interface FieldMeta {
  unitScale: string;
  currency: string;
}

/**
 * Collect top financial values from the latest period across all statements.
 * Returns the value map plus a parallel metadata map (unitScale/currency per field)
 * so the verifier prompt can tell Claude what scale each value is at.
 *
 * Each field is taken from the FIRST statement that defines it (statements are
 * usually ordered IS → BS → CF, so revenue/ebitda come from IS, total_assets
 * from BS, etc.) — meaning the metadata reflects the actual statement that
 * produced that value.
 */
function collectTopValues(statements: ClassifiedStatement[]): {
  values: Record<string, number | null>;
  meta: Record<string, FieldMeta>;
} {
  const values: Record<string, number | null> = {};
  const meta: Record<string, FieldMeta> = {};

  for (const stmt of statements) {
    if (!stmt.periods || stmt.periods.length === 0) continue;

    // Use the most recent period (last in array)
    const latestPeriod = stmt.periods[stmt.periods.length - 1];
    const lineItems = latestPeriod.lineItems;

    for (const field of TOP_FIELDS) {
      if (field in lineItems && !(field in values)) {
        values[field] = lineItems[field] ?? null;
        meta[field] = { unitScale: stmt.unitScale, currency: stmt.currency };
      }
    }
  }

  return { values, meta };
}

/**
 * Build the user prompt for Claude to verify extracted values.
 *
 * Each value is annotated with its source statement's unitScale + currency so
 * Claude verifies AT THE STATED SCALE rather than assuming MILLIONS. A startup
 * with revenue stored as 6700 at unitScale ACTUALS is correct — the verifier
 * must not flag it as "should be 0.0067 millions".
 */
function buildVerifyPrompt(
  extractedValues: Record<string, number | null>,
  meta: Record<string, FieldMeta>,
  sourceTextSample: string,
): string {
  const valueLines = Object.entries(extractedValues)
    .map(([k, v]) => {
      const m = meta[k];
      const scaleLabel = m
        ? ` (unitScale: ${m.unitScale}, currency: ${m.currency})`
        : '';
      return `  ${k}: ${v === null ? 'null' : v}${scaleLabel}`;
    })
    .join('\n');

  return `EXTRACTED VALUES (verify against source — values are at the unitScale stated for each field, do NOT assume MILLIONS):
${valueLines}

---

SOURCE TEXT (first 15K chars):
${sourceTextSample}

---

For each extracted value above, verify it against the source text — interpreted at its stated unitScale.
- unitScale "MILLIONS": value 125.3 means $125.3M
- unitScale "THOUSANDS": value 125300 means $125,300K = $125.3M
- unitScale "ACTUALS": value 6700 means $6,700 (six thousand seven hundred dollars). Small-business / startup numbers are correct at this scale — do NOT flag them as needing conversion.
- unitScale "BILLIONS": value 1.5 means $1.5B

Return ONLY a JSON array — no markdown, no explanation. your_value MUST be expressed at the SAME unitScale as the field shown above (do not silently rescale):
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
- If you can confirm the value from the source (interpreted at the stated unitScale), set verified=true and your_value to the same number
- If you find a discrepancy, set verified=false, your_value to what YOU see in the source EXPRESSED AT THE STATED unitScale, and issue to a short description
- If the field is null and you cannot find it either, set verified=true, your_value=null, issue=null
- If the field is null but you CAN find the value, set verified=false, your_value to what you found (at the stated unitScale), issue="Value exists in source but was not extracted"
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

  if (state.extractionSource === 'claude') {
    return { steps: [step('crossVerify', 'Skipped — structured-output engine carries in-schema provenance')] };
  }

  // Skip if Claude not configured
  if (!isClaudeEnabled()) {
    steps.push(step('crossVerify', 'Skipping cross-verification — ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not configured'));
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

  const { values: extractedValues, meta: fieldMeta } = collectTopValues(statements);
  const fieldCount = Object.keys(extractedValues).length;

  steps.push(step('crossVerify', `Sending ${fieldCount} financial value(s) to Claude Haiku for cross-verification`));

  try {
    const sourceTextSample = rawText.slice(0, VERIFY_SAMPLE_SIZE);
    const userPrompt = buildVerifyPrompt(extractedValues, fieldMeta, sourceTextSample);

    await enforceUserGate('financial_extraction', 'claude-haiku-4-5-20251001', 'anthropic');
    const start = Date.now();
    const authFields = getChatAnthropicAuthFields();
    if (!authFields) {
      // Shouldn't happen — isClaudeEnabled() gated entry into this function —
      // but degrade gracefully rather than let ChatAnthropic throw.
      steps.push(step('crossVerify', 'Skipping cross-verification — Claude auth unavailable'));
      return { steps };
    }
    const claude = new ChatAnthropic({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 2000,
      ...authFields,
    });
    let response;
    try {
      // Today's date is computed fresh per call so relative-period reasoning
      // ("FY", "LTM", "current quarter") anchors to wall-clock, not the
      // model's training cutoff.
      const today = getTodayIso();
      response = await withCircuitBreaker('anthropic', () =>
        claude.invoke([
        {
          role: 'system',
          content:
            `You are a financial data verification assistant. Today's date is ${today}. Use this for any relative period inference (FY, LTM, "current quarter", "last N days"). You verify extracted financial values against source documents. Respond ONLY with a valid JSON array — no markdown, no code fences, no explanation.`,
        },
        { role: 'user', content: userPrompt },
        ]),
      );
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
    const claudeUsage = response.usage_metadata;
    await recordUsageEvent({
      operation: 'financial_extraction',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      promptTokens: claudeUsage?.input_tokens ?? 0,
      completionTokens: claudeUsage?.output_tokens ?? 0,
      status: 'success',
      durationMs: Date.now() - start,
    });

    const responseText = response.text;
    if (!responseText || typeof responseText !== 'string') {
      steps.push(step('crossVerify', 'Cross-verification skipped — unexpected response format from Claude'));
      return { steps };
    }

    // Strip markdown code fences before parsing. The system prompt asks for
    // raw JSON, but Claude Haiku occasionally wraps the array in ```json …
    // ``` anyway — JSON.parse choked on the leading backtick and the whole
    // cross-verify pass got skipped. Same defensive strip used in
    // memos-suggest.ts. Cheap and idempotent for already-clean responses.
    const cleanedText = responseText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let claudeResults: ClaudeVerification[];
    try {
      claudeResults = JSON.parse(cleanedText) as ClaudeVerification[];
    } catch (err) {
      steps.push(step('crossVerify', 'Cross-verification skipped — could not parse Claude response as JSON'));
      log.warn('crossVerifyNode: JSON parse failure', { raw: responseText.slice(0, 200), error: err instanceof Error ? err.message : String(err) });
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
