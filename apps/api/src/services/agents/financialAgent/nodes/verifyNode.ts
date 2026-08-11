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
import { getTodayIso } from '../../../../utils/dates.js';
import type { FinancialAgentStateType } from '../state.js';
import { VERIFY_SAMPLE_SIZE } from '../config.js';
import type { AgentStep } from '../state.js';
import type { ClassifiedStatement } from '../../../financialClassifier.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/** Known clean unit-scale multipliers — anything that doesn't snap to one of these falls back to per-cell mode. */
const KNOWN_SCALE_MULTIPLIERS = [0.001, 0.01, 0.1, 1, 10, 100, 1000, 1_000_000] as const;

/** Tolerance for snapping a raw ratio (correctValue / extractedValue) onto a known scale. */
const SCALE_SNAP_TOLERANCE = 0.05; // 5%

/**
 * Fields that should NEVER be uniformly scaled by a unit multiplier:
 * - Margin / ratio / percentage fields (already unitless)
 * - Headcount-style count fields
 * - Source / citation strings (handled separately by being non-numeric)
 *
 * These regex patterns match the field name (case-insensitive).
 */
const NON_SCALABLE_FIELD_PATTERNS: RegExp[] = [
  /_pct$/i,
  /_percent$/i,
  /_percentage$/i,
  /_ratio$/i,
  /_margin$/i,
  /^margin_/i,
  /headcount/i,
  /employee_count/i,
  /^count$/i,
  /_count$/i,
  /_source$/i,
];

/** True if this field is a numeric line item that can be uniformly rescaled. */
function isScalableNumericField(field: string, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  for (const re of NON_SCALABLE_FIELD_PATTERNS) {
    if (re.test(field)) return false;
  }
  return true;
}

/**
 * Snap a raw ratio onto the closest known scale multiplier within tolerance.
 * Returns null if it doesn't fit any known scale cleanly.
 */
function snapToKnownScale(rawRatio: number): number | null {
  if (!Number.isFinite(rawRatio) || rawRatio === 0) return null;
  for (const scale of KNOWN_SCALE_MULTIPLIERS) {
    // Relative distance check works for both >1 and <1 multipliers
    const relDelta = Math.abs(rawRatio - scale) / scale;
    if (relDelta <= SCALE_SNAP_TOLERANCE) return scale;
  }
  return null;
}

/**
 * Inspect the corrections for a single statement. If they consistently point
 * to a uniform unit-scale rescale (e.g. ×1000 because source was thousands but
 * extraction assumed millions), return that multiplier.
 *
 * Strategy:
 *   1. For each correction with both extracted+correct values non-zero, compute
 *      ratio = correctValue / extractedValue.
 *   2. Snap each ratio onto the nearest known scale ([0.001, 0.01, 0.1, 1, 10,
 *      100, 1000, 1_000_000]); drop the ones that don't snap.
 *   3. Take the MODE (most common) of the snapped values, not the mean —
 *      sign-error / row-swap corrections shouldn't sway the result.
 *   4. Require the dominant scale to (a) cover at least half of the snappable
 *      corrections and (b) not be 1 (no-op).
 *
 * Returns null when no clean multiplier emerges → fall back to per-cell mode.
 */
function inferUniformMultiplier(
  corrections: Array<{
    statementType: string;
    period: string;
    field: string;
    extractedValue: number | null;
    correctValue: number | null;
    reason: string;
  }>,
  statementType: string,
): number | null {
  const snapped: number[] = [];

  for (const c of corrections) {
    const extracted = c.extractedValue;
    const correct = c.correctValue;
    if (typeof extracted !== 'number' || typeof correct !== 'number') continue;
    if (!Number.isFinite(extracted) || !Number.isFinite(correct)) continue;
    if (extracted === 0) continue; // Can't compute ratio against zero
    // Skip non-scalable fields when inferring (margins, percentages, etc.)
    if (!isScalableNumericField(c.field, extracted)) continue;
    // Skip sign flips (e.g. -100 → 100 yields ratio -1) — unrelated to scale.
    const ratio = correct / extracted;
    if (ratio < 0) continue;

    const snap = snapToKnownScale(ratio);
    if (snap !== null) snapped.push(snap);
  }

  if (snapped.length === 0) return null;

  // Mode: count occurrences and pick the dominant scale.
  const counts = new Map<number, number>();
  for (const s of snapped) counts.set(s, (counts.get(s) ?? 0) + 1);

  let bestScale: number | null = null;
  let bestCount = 0;
  for (const [scale, count] of counts) {
    if (count > bestCount) {
      bestScale = scale;
      bestCount = count;
    }
  }

  if (bestScale === null) return null;
  if (bestScale === 1) return null; // No rescale needed

  // Require dominant multiplier to cover at least half of the snappable
  // corrections — otherwise it's not a true unit-scale issue, just a few
  // coincidentally-clean fixes mixed with other error types.
  if (bestCount * 2 < snapped.length) {
    log.info('Verify: ambiguous multiplier candidates, falling back to per-cell mode', {
      statementType,
      bestScale,
      bestCount,
      total: snapped.length,
    });
    return null;
  }

  return bestScale;
}

// Built per call so today's date reflects the real wall clock — never cached.
function buildVerifySystemPrompt(today: string): string {
  return `You are a financial data QA analyst. Today's date is ${today}. Use this for any relative period inference (FY, LTM, "current quarter", "last N days"). You will receive:
1. EXTRACTED VALUES — structured financial data that was extracted from a document. Each statement is labelled with its declared unitScale (MILLIONS, THOUSANDS, ACTUALS, or BILLIONS) and currency.
2. SOURCE TEXT — a sample of the original document text

Your job: verify each value against the source AT THE STATED unitScale for that statement. Do NOT assume MILLIONS by default. Values are stored at the source's scale on purpose — preserving raw scale is correct behaviour.

INTERPRETING VALUES BY unitScale:
- unitScale "MILLIONS": value 53.7 means $53.7M
- unitScale "THOUSANDS": value 53700 means $53,700K = $53.7M
- unitScale "ACTUALS": value 6700 means $6,700 (six thousand seven hundred dollars). This is correct for small businesses / startups — do NOT flag it as a unit error just because the absolute number is small.
- unitScale "BILLIONS": value 1.5 means $1.5B

CHECK FOR:
- UNIT SCALE ERRORS: Only flag a unit-scale issue if the extracted value DOES NOT MATCH the source when interpreted at the stated unitScale. Example: statement says unitScale "MILLIONS" and value is 53.7, but source clearly shows "$53,700K" — that's an error. Example: statement says unitScale "ACTUALS" and value is 6700, source shows "$6,700" — that's correct, do NOT flag.
- TRANSPOSED/WRONG DIGITS: Revenue extracted as 125 but source clearly shows 152
- WRONG ROW MAPPING: A value from one line item assigned to a different field
- SIGN ERRORS: Positive value should be negative (e.g., expenses, losses)
- MISSING VALUES: Key values visible in source but null in extraction

For each issue found, return a correction. correctValue MUST be expressed at the SAME unitScale as the statement (do not silently rescale).

DO NOT FLAG these (they are correct):
- Statement unitScale ACTUALS, extracted 6700, source shows "$6,700" → correct, leave alone.
- Statement unitScale MILLIONS, extracted 53.7, source shows "$53.7 million" → correct, leave alone.
- Statement unitScale THOUSANDS, extracted 53700, source shows "$53,700 (in thousands)" → correct, leave alone.

DO FLAG these (real unit-scale errors):
- Statement unitScale MILLIONS, extracted 53.7, source shows "$53,700" with a "(in thousands)" header → mismatch by 1000×.
- Statement unitScale MILLIONS, extracted 0.0067, source shows "$6,700" with no unit header (actuals) → should be unitScale ACTUALS with value 6700.

RESPOND WITH ONLY JSON:
{
  "verified": true/false,
  "corrections": [
    {
      "statementType": "INCOME_STATEMENT",
      "period": "2023",
      "field": "revenue",
      "extractedValue": 0.0537,
      "correctValue": 53700,
      "reason": "Statement unitScale is THOUSANDS but value 0.0537 reads as $0.05 thousand. Source shows $53,700K → correct value at THOUSANDS scale is 53700."
    }
  ],
  "unitScaleIssue": null or "Statement declares unitScale MILLIONS but source clearly shows THOUSANDS — every value mismatched by 1000×",
  "confidence": 85
}

If everything looks correct, return: { "verified": true, "corrections": [], "unitScaleIssue": null, "confidence": 95 }`;
}

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

  if (state.extractionSource === 'claude') {
    return { steps: [step('verify', 'Skipped — structured-output engine carries in-schema provenance')] };
  }

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
        { role: 'system', content: buildVerifySystemPrompt(getTodayIso()) },
        {
          role: 'user',
          content: `EXTRACTED VALUES (each statement header shows its declared unitScale — verify values AT THAT scale, do NOT assume MILLIONS):\n${extractionSummary}\n\n---\n\nSOURCE TEXT:\n${sourceTextSample}`,
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

      // When the verifier flags a unit-scale issue, corrections it emits are
      // often a SUBSET of fields that need rescaling. Applying them cell-by-cell
      // leaves neighbouring periods at mixed scales (off by 1000×) and produces
      // nonsense growth charts downstream. So: if a clean uniform multiplier
      // emerges from the corrections for a given statement, apply it to ALL
      // numeric line items on every period of that statement atomically.
      // For corrections that DON'T fit a clean multiplier (sign errors, row
      // swaps, missing-value backfills), fall back to per-cell application.
      const unitScaleSignal = result.unitScaleIssue !== null && result.unitScaleIssue !== undefined;

      let correctionCount = 0;
      let uniformAdjustments = 0;
      const updatedStatements = statements.map(stmt => {
        const stmtCorrections = result.corrections.filter(
          c => normalizeStmtType(c.statementType) === stmt.statementType
        );

        if (stmtCorrections.length === 0) return stmt;

        // Try to infer a uniform multiplier ONLY when the verifier explicitly
        // flagged a unit-scale issue. Other correction types (sign flips, row
        // swaps) should never trigger atomic rescaling.
        const uniformMultiplier = unitScaleSignal
          ? inferUniformMultiplier(stmtCorrections, stmt.statementType)
          : null;

        // Track which (period, field) pairs are covered by an explicit
        // correction — those are already at the right value, so the uniform
        // multiplier should skip them.
        const explicitlyCorrected = new Set<string>();
        const correctionKey = (period: string, field: string) => `${period}::${field}`;

        const updatedPeriods = stmt.periods.map(p => {
          const periodCorrections = stmtCorrections.filter(c => c.period === p.period);
          const updatedLineItems = { ...p.lineItems };

          // Apply explicit per-cell corrections first (these are authoritative
          // for the fields they cover, regardless of the uniform multiplier).
          for (const corr of periodCorrections) {
            const field = corr.field;
            if (field in updatedLineItems && corr.correctValue !== undefined) {
              const oldVal = updatedLineItems[field];
              updatedLineItems[field] = corr.correctValue;
              explicitlyCorrected.add(correctionKey(p.period, field));
              correctionCount++;
              steps.push(step('verify',
                `Corrected ${stmt.statementType} ${p.period} ${field}: ${oldVal} → ${corr.correctValue}`,
                corr.reason
              ));
            }
          }

          return { ...p, lineItems: updatedLineItems };
        });

        // After explicit corrections, apply the uniform multiplier across
        // every numeric line item on every period — skipping the cells
        // already corrected (those are already at the right value) and
        // skipping margin / count / non-numeric fields.
        if (uniformMultiplier !== null) {
          log.info(
            `Verify: applying uniform multiplier ×${uniformMultiplier} to all fields of ${stmt.statementType} based on ${stmtCorrections.length} detected corrections`,
            {
              statementType: stmt.statementType,
              multiplier: uniformMultiplier,
              correctionsCount: stmtCorrections.length,
              unitScaleIssue: result.unitScaleIssue,
            },
          );
          steps.push(step(
            'verify',
            `Applying uniform ×${uniformMultiplier} to ${stmt.statementType} (unit-scale fix)`,
            result.unitScaleIssue ?? undefined,
          ));

          const rescaledPeriods = updatedPeriods.map(p => {
            const rescaledItems = { ...p.lineItems };
            for (const [field, value] of Object.entries(rescaledItems)) {
              if (explicitlyCorrected.has(correctionKey(p.period, field))) continue;
              if (!isScalableNumericField(field, value)) continue;
              const before = value as number;
              const after = before * uniformMultiplier;
              rescaledItems[field] = after;
              uniformAdjustments++;
            }
            return { ...p, lineItems: rescaledItems };
          });

          return { ...stmt, periods: rescaledPeriods };
        }

        return { ...stmt, periods: updatedPeriods };
      });

      if (correctionCount > 0 || uniformAdjustments > 0) {
        log.info('Verify node: applied corrections', {
          explicitCorrections: correctionCount,
          uniformAdjustments,
        });
        steps.push(step(
          'verify',
          `Applied ${correctionCount} explicit correction(s)${uniformAdjustments > 0 ? ` + ${uniformAdjustments} uniform-scale adjustment(s)` : ''} — proceeding to validation`,
        ));

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
