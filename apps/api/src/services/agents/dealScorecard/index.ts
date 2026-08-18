// ─── Deal Scorecard engine ───────────────────────────────────────
// Two-layer deal scoring: general quality + firm thesis fit.
// One trackedClaudeMessage structured-output call; verdict persisted
// to Deal.scorecard (JSONB — see apps/api/scorecard-migration.sql,
// applied MANUALLY per the repo's Supabase-migrations convention).
//
// NOTE: this branch's trackedClaudeMessage has no `signal` option —
// the timeout below races client-side only (same as other Phase 1
// call sites on this branch).

import { supabase } from '../../../supabase.js';
import { trackedClaudeMessage } from '../../ai/client.js';
import { analyzeFinancials } from '../../analysis/index.js';
import { log } from '../../../utils/logger.js';

const SCORECARD_TIMEOUT_MS = 30_000;

export class CriteriaNotConfiguredError extends Error {
  constructor() {
    super('Investment criteria are not configured for this organization');
    this.name = 'CriteriaNotConfiguredError';
  }
}

export interface Scorecard {
  overallScore: number;
  verdict: 'GO' | 'NO_GO' | 'BORDERLINE';
  qualityScore: number;
  thesisFitScore: number;
  reasons: Array<{ kind: 'hit' | 'miss' | 'flag'; text: string }>;
  scoredAt: string;
  model: string;
}

const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    overallScore: { type: 'integer', description: '0-100' },
    verdict: { type: 'string', enum: ['GO', 'NO_GO', 'BORDERLINE'] },
    qualityScore: { type: 'integer', description: '0-100' },
    thesisFitScore: { type: 'integer', description: '0-100' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['hit', 'miss', 'flag'] },
          text: { type: 'string' },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['overallScore', 'verdict', 'qualityScore', 'thesisFitScore', 'reasons'],
  additionalProperties: false,
};

const SCORECARD_SYSTEM_PROMPT = `You are scoring a private-equity deal against a two-layer rubric for an investment team.

Layer 1 — general quality (qualityScore 0-100): revenue durability/recurrence, margin quality, customer concentration, CapEx intensity, and any red flags from the financial analysis provided.
Layer 2 — thesis fit (thesisFitScore 0-100): how well the deal matches the firm's stated criteria (sectors, size bounds, hard exclusions, thesis).

Rules:
- Score ONLY from the data provided. Never invent numbers or facts. If financial data is missing, say so explicitly in a reason and keep the quality score conservative.
- Every NO_GO verdict must include at least one "miss" reason tied to a specific criterion (e.g. "outside size range: $28M vs the firm's $5-15M max").
- "hit" = criterion satisfied, "miss" = criterion violated, "flag" = quality concern not tied to a criterion.
- verdict: GO when both layers are strong, NO_GO when a hard criterion is violated or quality is poor, BORDERLINE otherwise.
- overallScore reflects both layers, weighted toward thesis fit — a great business the firm would never buy is not a GO.`;

/** Load the org's dealCriteria, or null if unset. */
async function loadCriteria(orgId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) throw error;
  const settings = (data?.settings || {}) as Record<string, any>;
  return settings.dealCriteria ?? null;
}

export async function scoreDeal(dealId: string, orgId: string): Promise<Scorecard> {
  const criteria = await loadCriteria(orgId);
  if (!criteria) throw new CriteriaNotConfiguredError();

  const { data: deal } = await supabase
    .from('Deal')
    .select('id, name, industry, stage, revenue, ebitda, dealSize, irrProjected, mom, description')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .single();
  if (!deal) throw new Error('Deal not found');

  const { data: statements } = await supabase
    .from('FinancialStatement')
    .select('statementType, period, lineItems')
    .eq('dealId', dealId)
    .eq('isActive', true)
    .order('period', { ascending: false });

  let financialSection: string;
  if (statements && statements.length > 0) {
    const analysis = await analyzeFinancials(dealId, statements);
    const flags = (analysis.redFlags ?? [])
      .map((f: any) => `- [${f.severity ?? 'unknown'}] ${f.title ?? f.description ?? JSON.stringify(f)}`)
      .join('\n');
    financialSection = `Extracted statements (${statements.length}):\n${statements
      .slice(0, 6)
      .map((s) => `- ${s.statementType} ${s.period}: ${JSON.stringify(s.lineItems).slice(0, 500)}`)
      .join('\n')}\n\nRed flags from analysis:\n${flags || '- none identified'}`;
  } else {
    financialSection = 'No extracted financial statements are available for this deal — score quality from deal-level metadata only and note this limitation in a reason.';
  }

  const userPrompt = `## Firm Criteria\n${JSON.stringify(criteria, null, 2)}\n\n## Deal\n${JSON.stringify(deal, null, 2)}\n\n## Financial Data\n${financialSection}`;

  const timeoutMs = Number(process.env.DEAL_SCORECARD_TIMEOUT_MS) > 0
    ? Number(process.env.DEAL_SCORECARD_TIMEOUT_MS)
    : SCORECARD_TIMEOUT_MS;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Deal scorecard timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  let result: { text: string; model: string };
  try {
    result = await Promise.race([
      trackedClaudeMessage({
        operation: 'deal_scorecard',
        role: 'chat',
        system: SCORECARD_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        outputSchema: SCORECARD_SCHEMA,
        maxTokens: 2000,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const parsed = JSON.parse(result.text);
  const scorecard: Scorecard = { ...parsed, scoredAt: new Date().toISOString(), model: result.model };

  const { error: updateError } = await supabase
    .from('Deal')
    .update({ scorecard })
    .eq('id', dealId)
    .eq('organizationId', orgId);
  if (updateError) throw updateError;

  log.info('[dealScorecard] scored', { dealId, verdict: scorecard.verdict, overallScore: scorecard.overallScore });
  return scorecard;
}

/**
 * Post-extraction hook: score if criteria are configured; silent no-op
 * otherwise. Never throws — never allowed to affect the extraction
 * response it piggybacks on.
 */
export async function maybeScoreAfterExtraction(dealId: string, orgId: string): Promise<void> {
  try {
    const criteria = await loadCriteria(orgId);
    if (!criteria) return;
    await scoreDeal(dealId, orgId);
  } catch (err: any) {
    log.warn(`[dealScorecard] post-extraction scoring skipped: ${err?.message}`);
  }
}
