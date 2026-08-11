/**
 * Financial Cross-Verify
 *
 * Drop-in replacement for `classifyFinancials` that runs both the GPT
 * extractor and the Claude Sonnet 4.6 extractor in parallel on the same
 * input, then reconciles disagreements via a third Sonnet 4.6 call that
 * sees the source text + both candidate extractions and picks the right
 * answer per disputed field (with a citation requirement).
 *
 * Behaviour:
 *   - ANTHROPIC_API_KEY unset → falls back to GPT-only (existing behaviour
 *     before this module landed). Zero behaviour change for installations
 *     that don't opt in.
 *   - Both extractions succeed and agree on every field within tolerance
 *     → skip the reconciliation call (cost optimization). Return the
 *     higher-confidence side, with a `crossVerify` warning recording the
 *     agreement.
 *   - Both succeed but disagree → run Sonnet 4.6 reconciler. The
 *     reconciler returns a unified ClassificationResult; we replace the
 *     disputed fields with its choices and stamp `crossVerify` warnings
 *     describing what changed.
 *   - One side fails → return the other (graceful degradation, no
 *     reconciliation needed). Logged so the cost asymmetry is visible.
 *
 * Cost: ~2× a single classification when extractions agree, ~3× when they
 * disagree (the third call is the reconciler). System-prompt caching on
 * the Claude path drops most of the input cost from the 2nd-pass extractor
 * once a doc is in cache.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage, type AIMessageChunk } from '@langchain/core/messages';
import { log } from '../utils/logger.js';
import {
  classifyFinancials,
  normalizeClassificationResult,
  applyExplicitUnitOverride,
  applySmallDollarActualsOverride,
  applySourceTextDollarOverride,
  detectExplicitUnitInText,
  hasExplicitSmallDollarAmounts,
  type ClassificationResult,
  type ClassifiedStatement,
  type ClassifyOptions,
  type FinancialPeriod,
  type StatementType,
} from './financialClassifier.js';
import {
  classifyFinancialsWithClaude,
  isClaudeClassifierEnabled,
} from './claudeFinancialClassifier.js';
import { MAX_TEXT_LENGTH } from './agents/financialAgent/config.js';

// ─── Config ──────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6';
const RECONCILE_MAX_OUTPUT = 32_000;
const RECONCILE_TIMEOUT_MS = 180_000;

/**
 * Tolerance for "values agree" in line-item comparisons. Two LLMs reading
 * the same source can round to different decimal places (12.34 vs 12.345)
 * without disagreeing semantically. We treat values within 0.5% as equal.
 */
const VALUE_AGREEMENT_TOLERANCE = 0.005;

let cachedClient: ChatAnthropic | null = null;

function getClient(): ChatAnthropic | null {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  cachedClient = new ChatAnthropic({
    model: SONNET_MODEL,
    maxTokens: RECONCILE_MAX_OUTPUT,
    // Adaptive extended thinking — preserved exactly. The reconciler runs
    // a deliberative compare-and-pick task over two extractions; adaptive
    // thinking lets Sonnet allocate tokens to it as needed.
    thinking: { type: 'adaptive' },
    // Output effort — preserved exactly. "high" trades latency for
    // thoroughness on the reconciliation pass.
    outputConfig: { effort: 'high' },
    // Stream + aggregate on invoke(); ChatAnthropic concats the chunks
    // internally so invoke() returns an AIMessage equivalent to
    // stream.finalMessage() from the bare SDK.
    streaming: true,
    clientOptions: { timeout: RECONCILE_TIMEOUT_MS },
  });
  return cachedClient;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Run both extractors in parallel and return a single reconciled result.
 *
 * Same shape and null-on-failure semantics as `classifyFinancials`, so
 * callers (extractNode, the chunked PDF path) can swap one function for
 * the other without changing the surrounding logic.
 */
export async function classifyFinancialsCrossVerified(
  text: string,
  options?: ClassifyOptions,
): Promise<ClassificationResult | null> {
  // Opt-out path: no Anthropic key → behave exactly like the legacy
  // single-extractor pipeline. Keeps installations without an Anthropic
  // key on the same code path they were on before this module landed.
  if (!isClaudeClassifierEnabled()) {
    return classifyFinancials(text, options);
  }

  // Parallel extraction. allSettled so a failure on either side doesn't
  // abort the other.
  const [gptResult, claudeResult] = await Promise.allSettled([
    classifyFinancials(text, options),
    classifyFinancialsWithClaude(text, options),
  ]);

  const gpt = gptResult.status === 'fulfilled' ? gptResult.value : null;
  const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;

  if (gptResult.status === 'rejected') {
    log.warn('Cross-verify: GPT extraction threw', { reason: String(gptResult.reason) });
  }
  if (claudeResult.status === 'rejected') {
    log.warn('Cross-verify: Claude extraction threw', { reason: String(claudeResult.reason) });
  }

  // Fall-throughs when one or both fail.
  if (!gpt && !claude) return null;
  if (!gpt) {
    log.info('Cross-verify: only Claude succeeded, skipping reconciliation');
    return tagCrossVerifyOnlyOne(claude!, 'claude');
  }
  if (!claude) {
    log.info('Cross-verify: only GPT succeeded, skipping reconciliation');
    return tagCrossVerifyOnlyOne(gpt, 'gpt');
  }

  // Both succeeded — find disagreements.
  const diffs = computeDiffs(gpt, claude);

  if (diffs.length === 0) {
    log.debug('Cross-verify: extractions agree — skipping reconciler call');
    return mergeAgreeing(gpt, claude);
  }

  log.info('Cross-verify: disagreements found — running Sonnet 4.6 reconciler', {
    diffCount: diffs.length,
    sample: diffs.slice(0, 3),
  });

  // Disagreements → reconcile via Sonnet 4.6. If reconciliation fails
  // (network, parse error), fall back to the higher-confidence merge so
  // we still ship something rather than nothing.
  const reconciled = await reconcileWithSonnet(text, gpt, claude, diffs);
  if (!reconciled) {
    log.warn('Cross-verify: reconciler failed, falling back to higher-confidence merge');
    return mergeAgreeing(gpt, claude, diffs);
  }
  return reconciled;
}

// ─── Diff Computation ────────────────────────────────────────

/**
 * Lightweight per-field diff. Compares the two ClassificationResults at
 * (statementType, period, lineItemKey) granularity. Returns an array of
 * paths where they disagree, used to:
 *   1. Decide whether to fire the reconciler (any diff → reconcile).
 *   2. Bound the reconciler prompt — only re-examine disputed fields,
 *      keep agreed values as-is.
 */
export interface FieldDiff {
  statementType: StatementType;
  period: string;
  /** "lineItem:revenue" or "unitScale" or "currency" or "missing-period" */
  field: string;
  gptValue: unknown;
  claudeValue: unknown;
}

export function computeDiffs(a: ClassificationResult, b: ClassificationResult): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  const aByType = new Map(a.statements.map((s) => [s.statementType, s] as const));
  const bByType = new Map(b.statements.map((s) => [s.statementType, s] as const));
  const allTypes = new Set<StatementType>([...aByType.keys(), ...bByType.keys()]);

  for (const stmtType of allTypes) {
    const aStmt = aByType.get(stmtType);
    const bStmt = bByType.get(stmtType);

    if (!aStmt || !bStmt) {
      // One side has the statement, the other doesn't. Always a diff.
      diffs.push({
        statementType: stmtType,
        period: '*',
        field: 'missing-statement',
        gptValue: aStmt ? 'present' : 'missing',
        claudeValue: bStmt ? 'present' : 'missing',
      });
      continue;
    }

    if (aStmt.unitScale !== bStmt.unitScale) {
      diffs.push({
        statementType: stmtType,
        period: '*',
        field: 'unitScale',
        gptValue: aStmt.unitScale,
        claudeValue: bStmt.unitScale,
      });
    }
    if (aStmt.currency !== bStmt.currency) {
      diffs.push({
        statementType: stmtType,
        period: '*',
        field: 'currency',
        gptValue: aStmt.currency,
        claudeValue: bStmt.currency,
      });
    }

    const aPeriods = new Map(aStmt.periods.map((p) => [p.period, p] as const));
    const bPeriods = new Map(bStmt.periods.map((p) => [p.period, p] as const));
    const allPeriods = new Set<string>([...aPeriods.keys(), ...bPeriods.keys()]);

    for (const period of allPeriods) {
      const aP = aPeriods.get(period);
      const bP = bPeriods.get(period);

      if (!aP || !bP) {
        diffs.push({
          statementType: stmtType,
          period,
          field: 'missing-period',
          gptValue: aP ? 'present' : 'missing',
          claudeValue: bP ? 'present' : 'missing',
        });
        continue;
      }

      diffs.push(...diffLineItems(stmtType, period, aP, bP));
    }
  }

  return diffs;
}

function diffLineItems(
  statementType: StatementType,
  period: string,
  a: FinancialPeriod,
  b: FinancialPeriod,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const allKeys = new Set<string>([
    ...Object.keys(a.lineItems),
    ...Object.keys(b.lineItems),
  ]);

  for (const key of allKeys) {
    if (key.endsWith('_source')) continue; // citation strings — different
    // wording is fine, not a value disagreement.

    const aVal = a.lineItems[key];
    const bVal = b.lineItems[key];

    // Both missing or null → agree.
    if (aVal == null && bVal == null) continue;
    // One missing, one present → disagree (might be omission vs extraction
    // miss; the reconciler will look at the source).
    if (aVal == null || bVal == null) {
      out.push({
        statementType,
        period,
        field: `lineItem:${key}`,
        gptValue: aVal ?? null,
        claudeValue: bVal ?? null,
      });
      continue;
    }

    // Both numeric — apply tolerance.
    const aNum = typeof aVal === 'number' ? aVal : Number(aVal);
    const bNum = typeof bVal === 'number' ? bVal : Number(bVal);
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) {
      // Non-numeric somehow snuck in — flag it.
      out.push({
        statementType,
        period,
        field: `lineItem:${key}`,
        gptValue: aVal,
        claudeValue: bVal,
      });
      continue;
    }
    if (valuesAgree(aNum, bNum)) continue;
    out.push({
      statementType,
      period,
      field: `lineItem:${key}`,
      gptValue: aNum,
      claudeValue: bNum,
    });
  }

  return out;
}

/**
 * Two numeric values "agree" when their relative difference is within
 * VALUE_AGREEMENT_TOLERANCE. Both zero counts as agreement; one zero +
 * one non-zero counts as disagreement (avoids div-by-zero false positives
 * since the relative-diff formula is undefined there).
 */
function valuesAgree(a: number, b: number): boolean {
  if (a === b) return true;
  if (a === 0 || b === 0) return false;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / denom <= VALUE_AGREEMENT_TOLERANCE;
}

// ─── Reconciler (Sonnet 4.6 critic) ──────────────────────────

async function reconcileWithSonnet(
  sourceText: string,
  gpt: ClassificationResult,
  claude: ClassificationResult,
  diffs: FieldDiff[],
): Promise<ClassificationResult | null> {
  const client = getClient();
  if (!client) return null;

  const truncatedSource = sourceText.slice(0, MAX_TEXT_LENGTH);
  const explicitUnit = detectExplicitUnitInText(truncatedSource);
  const hasSmallDollars = hasExplicitSmallDollarAmounts(truncatedSource);

  const systemPrompt = buildReconcilePrompt();
  const userMessage = formatReconcileUserMessage(truncatedSource, gpt, claude, diffs);

  try {
    // System message content is an array of TextBlockParams with
    // cache_control: ephemeral — ChatAnthropic forwards the first
    // SystemMessage's `content` straight through as the `system` field
    // on the underlying API call, preserving the cache_control marker.
    const systemMessage = new SystemMessage({
      content: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    const humanMessage = new HumanMessage(userMessage);

    // streaming: true on the constructor causes invoke() to internally
    // stream and concat all chunks into a single AIMessageChunk —
    // equivalent to the bare-SDK `stream.finalMessage()` pattern.
    const message: AIMessageChunk = await client.invoke([systemMessage, humanMessage]);

    // ChatAnthropic returns either a string (single text block) or an
    // array of content blocks. Handle both, since we always want all
    // text concatenated for JSON parsing.
    let textContent = '';
    if (typeof message.content === 'string') {
      textContent = message.content;
    } else {
      for (const block of message.content) {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
          textContent += (block as { text: string }).text;
        }
      }
    }
    if (!textContent) {
      log.error('Cross-verify reconciler: empty response');
      return null;
    }

    const cleaned = textContent
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    let raw: unknown;
    try {
      raw = JSON.parse(cleaned);
    } catch (err) {
      log.error('Cross-verify reconciler: JSON parse failed', {
        error: String(err),
        sample: cleaned.slice(0, 200),
      });
      return null;
    }

    const result = normalizeClassificationResult(raw);
    // Apply the same deterministic guards we apply to the per-extractor
    // results — the reconciler is itself an LLM and can mis-tag units.
    applyExplicitUnitOverride(result, explicitUnit);
    applySmallDollarActualsOverride(result, hasSmallDollars, explicitUnit);
    applySourceTextDollarOverride(result);

    // Decorate warnings so the UI / debug bundle can see this came from
    // the reconciliation pass rather than a single extractor.
    result.warnings = [
      ...result.warnings,
      `cross-verify: reconciled ${diffs.length} disagreement${diffs.length === 1 ? '' : 's'} via Sonnet 4.6`,
    ];

    log.info('Cross-verify reconciler completed', {
      statementsFound: result.statements.length,
      overallConfidence: result.overallConfidence,
      // ChatAnthropic exposes Anthropic's cache token counts via
      // usage_metadata.input_token_details (see
      // @langchain/anthropic utils/message_outputs.js buildUsageMetadata).
      cacheReadTokens: message.usage_metadata?.input_token_details?.cache_read,
      cacheWriteTokens: message.usage_metadata?.input_token_details?.cache_creation,
    });

    return result;
  } catch (err) {
    // LangChain's wrapAnthropicClientError preserves the original
    // Anthropic.APIError instance (see utils/errors.js), so the
    // instanceof check still distinguishes API errors from
    // network/parse failures.
    if (err instanceof Anthropic.APIError) {
      log.error('Cross-verify reconciler: API error', { status: err.status, message: err.message });
    } else {
      log.error('Cross-verify reconciler: unexpected error', err);
    }
    return null;
  }
}

function buildReconcilePrompt(): string {
  // Frozen — kept identical across reconcile calls so the system-prompt
  // cache hits across docs / chunks. Any byte change here invalidates
  // the cache for every subsequent reconcile call.
  return `You are a senior private equity analyst reconciling two parallel financial extractions of the SAME document. Two LLMs (GPT and Claude) have already independently extracted statements from the source. They disagree on some fields. Your job: produce a SINGLE consolidated extraction by re-reading the source for every disputed field and choosing the value the source actually supports.

PROCEDURE:
1. For every field where GPT and Claude AGREE within rounding (≤ 0.5% relative difference), use that agreed value verbatim. Do NOT re-derive — agreement is strong evidence both are right.
2. For every field where they DISAGREE, locate the value in the source. If the source supports one side, use that side. If the source supports neither, use null and add a warning. If the source supports both at different periods, you may have a period-labeling disagreement — investigate.
3. For unitScale disagreements: the source's explicit declaration ("$M", "$000s", "in millions") wins. No declaration → ACTUALS (the source's literal numbers, not promoted to a larger scale).
4. For period coverage disagreements (one side has 36 monthly periods, the other has 4 annuals): prefer the more-granular extraction IF the source is monthly. Annual aggregates that don't match the sum of constituent months are wrong; emit the months.
5. For derived fields (gross_profit, ebitda, ebitda_margin_pct): when the inputs (revenue, cogs, total_opex) are agreed, the derived field MUST be consistent with them within 1%. If GPT and Claude give different derived values but identical inputs, the derived value should be (re)computed from the inputs.
6. For source_quote citations: use the more specific quote, or merge both into a single quote if they cite different parts of the same passage.

OUTPUT FORMAT:
Return JSON only — same shape as the inputs. No markdown fences, no preamble.
{
  "statements": [
    { "statementType": "...", "unitScale": "...", "currency": "...", "periods": [
        { "period": "...", "periodType": "HISTORICAL|PROJECTED|LTM", "confidence": 90,
          "lineItems": { "revenue": ..., "ebitda": ..., ... } }
      ] }
  ],
  "overallConfidence": 85,
  "warnings": [ "any field where you fell back to null", "any structural disagreement you couldn't resolve" ]
}

NEVER fabricate values. If the source doesn't support a number and the two extractors disagree, set the field to null and add a warning describing the conflict.`;
}

function formatReconcileUserMessage(
  source: string,
  gpt: ClassificationResult,
  claude: ClassificationResult,
  diffs: FieldDiff[],
): string {
  // Bound the diff list — sending all 200 line-item disagreements blows
  // up the prompt without much marginal value. The reconciler also has
  // both full extractions to compare directly, so the diff is a hint.
  const sample = diffs.slice(0, 50);
  const remaining = Math.max(0, diffs.length - sample.length);
  const diffSummary = sample
    .map((d) => `- [${d.statementType} / ${d.period} / ${d.field}] GPT=${formatVal(d.gptValue)} CLAUDE=${formatVal(d.claudeValue)}`)
    .join('\n');
  const remainingNote = remaining > 0
    ? `\n(...and ${remaining} more disagreements not listed; both full extractions are below — examine them too.)`
    : '';

  return `SOURCE DOCUMENT:
\`\`\`
${source}
\`\`\`

EXTRACTION A (from GPT):
\`\`\`json
${JSON.stringify(gpt, null, 2)}
\`\`\`

EXTRACTION B (from Claude):
\`\`\`json
${JSON.stringify(claude, null, 2)}
\`\`\`

DISAGREEMENTS DETECTED (${diffs.length} total):
${diffSummary}${remainingNote}

Re-read the source for each disagreement and emit a SINGLE consolidated extraction. Return JSON only.`;
}

function formatVal(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'missing';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return JSON.stringify(v);
}

// ─── Merge Helpers ───────────────────────────────────────────

/**
 * Both extractions agreed on every field (or near enough). Pick one as
 * the spine and stamp a warning so the UI can show the verification
 * happened. Per-statement: prefer the side with higher overallConfidence.
 */
function mergeAgreeing(
  gpt: ClassificationResult,
  claude: ClassificationResult,
  diffs?: FieldDiff[],
): ClassificationResult {
  // When confidences match within 1, GPT wins (deterministic tie-break).
  const winner = gpt.overallConfidence >= claude.overallConfidence ? gpt : claude;
  const note = diffs && diffs.length > 0
    ? `cross-verify: ${diffs.length} disagreement${diffs.length === 1 ? '' : 's'} fell back to higher-confidence side after reconciler error`
    : 'cross-verify: GPT and Claude agreed';
  return {
    ...winner,
    warnings: [...winner.warnings, note],
  };
}

function tagCrossVerifyOnlyOne(
  result: ClassificationResult,
  side: 'gpt' | 'claude',
): ClassificationResult {
  return {
    ...result,
    warnings: [
      ...result.warnings,
      `cross-verify: ${side === 'gpt' ? 'Claude extraction failed; using GPT only' : 'GPT extraction failed; using Claude only'}`,
    ],
  };
}

/** Re-export the helper so tests / debug tools can examine an extraction
 *  pair without re-running the full pipeline. */
export type { ClassificationResult, ClassifyOptions } from './financialClassifier.js';
export type { ClassifiedStatement };
