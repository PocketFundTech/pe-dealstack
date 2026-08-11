// ─── Quantitative Reconciler — Phase 2 LLM blocks ─────────────────
//
// Two independent LLM calls used by the Phase 2 reconciler to produce:
//   1. extractionQualityFeedback — critique of the prior extraction
//      agent's stored top-line fields (revenue/ebitda/dealSize) against
//      the Phase 1 computed ground truth and Phase 2 claim validation.
//   2. recommendedNextActions — prioritized buyer diligence to-do list
//      derived from claim variances + material findings.
//
// Each function makes ONE LLM call (no nested calls). Both return
// null/[] when the LLM client is unavailable or the call/parse fails —
// callers fall back to the deterministic Phase 1 output.

import { trackedChatCompletion, isAIEnabled } from '../../openai.js';
import { MODEL_INSIGHTS } from '../../utils/aiModels.js';
import { log } from '../../utils/logger.js';
import type {
  CimClaimValidation,
  ComputedGroundTruth,
  DealRecordInput,
  ExtractionQualityFeedback,
  MaterialFinding,
  RecommendedAction,
} from './shared.js';

// ─── Module 1: extractionQualityFeedback ──────────────────────────

const EXTRACTION_QUALITY_SYSTEM_PROMPT = `You are auditing a PE deal-extraction agent's output quality. You're given:
 1. The Deal record's stored fields (revenue, ebitda, dealSize — what the extraction agent populated)
 2. The computed ground truth (what the actual financial data sums to)
 3. CIM-claim validation results (what variances were detected between narrative claims and computed truth)

Identify issues where the extraction agent produced wrong/missing/misleading values. For each: (a) state the specific issue with both the agent's value and the correct value, (b) note the root cause (what the agent did wrong methodologically), (c) suggest a prompting fix.

Return JSON:
{
  "issuesWithPriorExtraction": ["<specific issue with numbers>", ...],
  "rootCauseDiagnosis": "<one-paragraph explanation of why the agent failed>",
  "promptingFixForPEOS": "<one-paragraph proposed prompt change>"
}`;

/** Format `dealRecord.revenue` etc. — stored in millions per schema. */
function formatMillions(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'null';
  return String(value);
}

/** Slim down claimValidations to the non-VERIFIED ones the LLM should
 * comment on. Keeps the user prompt focused: a fully-verified claim is
 * not an extraction issue and only inflates token count. */
function nonVerifiedClaims(claims: CimClaimValidation[]): CimClaimValidation[] {
  return claims.filter((c) => c.verdict !== 'VERIFIED');
}

function buildExtractionQualityUserPrompt(
  dealRecord: DealRecordInput,
  groundTruth: ComputedGroundTruth,
  claimValidations: CimClaimValidation[],
): string {
  const flagged = nonVerifiedClaims(claimValidations);
  const claimsBlock = flagged.length === 0
    ? '(no flagged claims — all CIM claims either verified or no claims extracted)'
    : flagged
        .map((c) => {
          const variance =
            c.variance_pct == null ? 'n/a' : `${c.variance_pct.toFixed(1)}%`;
          const computed =
            c.computedValue == null ? 'null' : String(c.computedValue);
          return [
            `- claim: ${c.claim}`,
            `  computedValue: ${computed}`,
            `  variance_pct: ${variance}`,
            `  verdict: ${c.verdict}`,
          ].join('\n');
        })
        .join('\n');

  return [
    'DEAL RECORD STORED VALUES (in millions):',
    `- revenue: ${formatMillions(dealRecord.revenue)}`,
    `- ebitda: ${formatMillions(dealRecord.ebitda)}`,
    `- dealSize / asking price: ${formatMillions(dealRecord.dealSize)}`,
    '',
    'COMPUTED GROUND TRUTH (in actual dollars):',
    JSON.stringify(groundTruth, null, 2),
    '',
    'CIM CLAIM VALIDATION RESULTS:',
    claimsBlock,
    '',
    'Identify what the extraction agent got wrong, why, and how to fix it.',
  ].join('\n');
}

export async function generateExtractionQualityFeedback(input: {
  dealRecord: DealRecordInput;
  groundTruth: ComputedGroundTruth;
  claimValidations: CimClaimValidation[];
  dealId: string;
  orgId: string;
}): Promise<ExtractionQualityFeedback | null> {
  const { dealRecord, groundTruth, claimValidations, dealId, orgId } = input;

  if (!isAIEnabled()) {
    log.info('extractionFeedback: LLM client unavailable, skipping quality feedback');
    return null;
  }

  const userPrompt = buildExtractionQualityUserPrompt(
    dealRecord,
    groundTruth,
    claimValidations,
  );

  try {
    const response = await trackedChatCompletion(
      'reconciler_extraction_feedback',
      {
        model: MODEL_INSIGHTS,
        messages: [
          { role: 'system', content: EXTRACTION_QUALITY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2000,
      },
      undefined,
      {
        tags: ['reconciler', 'extraction_feedback'],
        traceMeta: { dealId, orgId },
      },
    );

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      log.warn('extractionFeedback: empty LLM response', { dealId });
      return null;
    }

    const parsed = JSON.parse(content) as Partial<ExtractionQualityFeedback>;
    const issues = Array.isArray(parsed.issuesWithPriorExtraction)
      ? parsed.issuesWithPriorExtraction.filter(
          (s): s is string => typeof s === 'string' && s.trim().length > 0,
        )
      : [];
    const rootCause =
      typeof parsed.rootCauseDiagnosis === 'string'
        ? parsed.rootCauseDiagnosis.trim()
        : '';
    const promptingFix =
      typeof parsed.promptingFixForPEOS === 'string'
        ? parsed.promptingFixForPEOS.trim()
        : '';

    if (issues.length === 0 && !rootCause && !promptingFix) {
      // LLM returned a valid JSON object but no usable content — treat
      // as failure so the caller can fall back rather than persist an
      // empty feedback block.
      log.warn('extractionFeedback: LLM returned empty feedback', { dealId });
      return null;
    }

    return {
      issuesWithPriorExtraction: issues,
      rootCauseDiagnosis: rootCause,
      promptingFixForPEOS: promptingFix,
    };
  } catch (err) {
    log.error('extractionFeedback: generation failed', {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Module 2: recommendedNextActions ─────────────────────────────

const RECOMMENDED_ACTIONS_SYSTEM_PROMPT = `You are a senior PE associate translating diligence findings into a prioritized buyer to-do list. You're given:
 1. Computed ground truth (financial aggregates)
 2. CIM claim validation results (claim vs computed variances)
 3. Material findings (HIGH/MEDIUM/LOW severity issues)

Produce 4-8 actionable items the buyer should request from the seller. Order by priority (1 = most urgent). Each action references the finding/claim it stems from. Owner is usually 'Buyer' (this is what the buyer asks for); use 'Seller' only when the action is something the seller must produce internally.

Examples of good actions:
- "Request Stripe payout report for any one month to verify gross-vs-net revenue treatment" (priority 1, owner Buyer — links to F-005 revenue recognition flag)
- "Request monthly cohort retention table broken out by Stripe / Wix / Shopify" (priority 2, links to F-004 churn)

Return JSON: { actions: [{ priority: 1, owner: "Buyer", action: "..." }, ...] }`;

function formatDollars(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  // Always render in compact "$XXXk / $X.Xm" form for the LLM prompt;
  // the model reasons about magnitudes more reliably with formatted
  // numbers than raw scientific notation from JSON.stringify.
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  // Ground truth stores margins as decimals (0.7 → 70%). Render as
  // percent for the LLM. Two decimals keep partial-point variance
  // visible without flooding the prompt.
  return `${(value * 100).toFixed(1)}`;
}

function buildRecommendedActionsUserPrompt(
  groundTruth: ComputedGroundTruth,
  claimValidations: CimClaimValidation[],
  materialFindings: MaterialFinding[],
): string {
  const flagged = nonVerifiedClaims(claimValidations);
  const claimsBlock = flagged.length === 0
    ? '(no flagged claims)'
    : flagged
        .map((c) => `- ${c.claim} | ${c.verdict} | ${c.implication}`)
        .join('\n');

  const findingsBlock = materialFindings.length === 0
    ? '(no material findings)'
    : materialFindings
        .map(
          (f) => `- ${f.id} | ${f.severity} | ${f.title} | ${f.evidence}`,
        )
        .join('\n');

  return [
    'GROUND TRUTH SUMMARY:',
    `- TTM revenue: ${formatDollars(groundTruth.TTM_revenue)}`,
    `- TTM net income: ${formatDollars(groundTruth.TTM_netIncome)}`,
    `- TTM net margin: ${formatPct(groundTruth.TTM_netMargin)}%`,
    `- Implied ARR (3-mo): ${formatDollars(groundTruth.impliedARR_3MoAvg)}`,
    '',
    'CLAIM VARIANCES (non-VERIFIED only):',
    claimsBlock,
    '',
    'MATERIAL FINDINGS:',
    findingsBlock,
    '',
    'Produce a prioritized diligence to-do list (4-8 items).',
  ].join('\n');
}

export async function generateRecommendedActions(input: {
  groundTruth: ComputedGroundTruth;
  claimValidations: CimClaimValidation[];
  materialFindings: MaterialFinding[];
  dealId: string;
  orgId: string;
}): Promise<RecommendedAction[]> {
  const { groundTruth, claimValidations, materialFindings, dealId, orgId } = input;

  if (!isAIEnabled()) {
    log.info('extractionFeedback: LLM client unavailable, skipping recommended actions');
    return [];
  }

  const userPrompt = buildRecommendedActionsUserPrompt(
    groundTruth,
    claimValidations,
    materialFindings,
  );

  try {
    const response = await trackedChatCompletion(
      'reconciler_recommended_actions',
      {
        model: MODEL_INSIGHTS,
        messages: [
          { role: 'system', content: RECOMMENDED_ACTIONS_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1500,
      },
      undefined,
      {
        tags: ['reconciler', 'recommended_actions'],
        traceMeta: { dealId, orgId },
      },
    );

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      log.warn('extractionFeedback: empty LLM response for actions', { dealId });
      return [];
    }

    const parsed = JSON.parse(content) as { actions?: unknown };
    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];

    const actions: RecommendedAction[] = [];
    for (const raw of rawActions) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const priority = typeof r.priority === 'number' ? r.priority : Number(r.priority);
      const owner = typeof r.owner === 'string' ? r.owner.trim() : '';
      const action = typeof r.action === 'string' ? r.action.trim() : '';
      if (!Number.isFinite(priority) || !owner || !action) continue;
      actions.push({ priority, owner, action });
    }

    // Sort by priority ascending so the caller can render top-down
    // without re-sorting; LLMs sometimes return out-of-order lists.
    actions.sort((a, b) => a.priority - b.priority);

    return actions;
  } catch (err) {
    log.error('extractionFeedback: action generation failed', {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
