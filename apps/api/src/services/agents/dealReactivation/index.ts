// ─── Deal Reactivation engine ─────────────────────────────────────
// Passed deals are not dead — they're dormant. A business that was too
// small at $2M EBITDA is a live target at $3M, and a thesis change can
// make yesterday's 4/10 today's 8/10. This re-scores dormant deals when
// something has actually changed and surfaces the ones that woke up.
//
// Demo-call origin: Aryamaan M8 ("we invest in 4 of 1,500 — the other
// 1,496 still matter") and Martin M14 ("no tool does this").
//
// Scoring itself is NOT reimplemented here: we call the existing
// dealScorecard engine, which owns the prompt, the schema and the
// persistence of Deal.scorecard. This module owns *when* to call it and
// *what changed*.
//
// Backed by DealReactivation + new Deal columns — see
// apps/api/deal-reactivation-migration.sql (applied MANUALLY per the
// repo's Supabase-migrations convention).

import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import { scoreDeal } from '../dealScorecard/index.js';
import { notifyDealTeam } from '../../../routes/notifications.js';
import {
  isRescoreEligible,
  detectReactivation,
  type ReactivationTrigger,
  type Verdict,
} from './rules.js';

export * from './rules.js';

/** Superseded scorecards kept per deal. */
export const SCORECARD_HISTORY_LIMIT = 20;

/** Deals one org may re-score in a single automatic sweep. */
export const SWEEP_MAX_PER_RUN = 25;

/** Passed deals examined per sweep (cheap — one query, no LLM). */
const SWEEP_SCAN_LIMIT = 500;

interface DealRow {
  id: string;
  organizationId: string;
  name: string;
  stage: string;
  revisitAt: string | null;
  lastRescoredAt: string | null;
  scorecard: {
    overallScore: number;
    verdict: Verdict;
    scoredAt?: string;
    reasons?: Array<{ kind: 'hit' | 'miss' | 'flag'; text: string }>;
  } | null;
  scorecardHistory: Array<Record<string, unknown>> | null;
}

const DEAL_FIELDS =
  'id, organizationId, name, stage, revisitAt, lastRescoredAt, scorecard, scorecardHistory';

/** When this org last edited its investment criteria, if ever. */
async function loadCriteriaUpdatedAt(orgId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  const criteria = (data?.settings as Record<string, any> | null)?.dealCriteria;
  return criteria?.updatedAt ?? null;
}

export interface RescoreOutcome {
  reactivated: boolean;
  newScore?: number;
  reactivationId?: string;
}

/**
 * Re-score one dormant deal and record a reactivation if it woke up.
 *
 * Never throws. Callers include the post-extraction hook, which piggybacks
 * on a user-facing upload response — a scoring failure must never surface
 * there as a broken upload.
 */
export async function rescorePassedDeal(
  dealId: string,
  orgId: string,
  trigger: ReactivationTrigger,
): Promise<RescoreOutcome> {
  try {
    const { data: deal } = await supabase
      .from('Deal')
      .select(DEAL_FIELDS)
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    const row = deal as DealRow | null;
    if (!row) return { reactivated: false };

    // Guard here as well as in the sweep: a deal can move out of PASSED
    // between eligibility and execution.
    if (row.stage !== 'PASSED') return { reactivated: false };

    const previous = row.scorecard;
    const next = await scoreDeal(dealId, orgId);

    const outcome = detectReactivation(previous, next);

    // Archive the superseded card, newest last, oldest evicted first.
    const history = [...(row.scorecardHistory ?? [])];
    if (previous) {
      history.push({
        score: previous.overallScore,
        verdict: previous.verdict,
        scoredAt: previous.scoredAt ?? null,
        trigger,
      });
    }
    const trimmed = history.slice(-SCORECARD_HISTORY_LIMIT);

    await supabase
      .from('Deal')
      .update({ scorecardHistory: trimmed, lastRescoredAt: new Date().toISOString() })
      .eq('id', dealId)
      .eq('organizationId', orgId);

    if (!outcome.reactivated) {
      log.info('[dealReactivation] re-scored, no material change', {
        dealId,
        trigger,
        from: outcome.previousScore,
        to: outcome.newScore,
      });
      return { reactivated: false, newScore: outcome.newScore };
    }

    const { data: reactivation } = await supabase
      .from('DealReactivation')
      .insert({
        dealId,
        organizationId: orgId,
        trigger,
        previousScore: outcome.previousScore,
        newScore: outcome.newScore,
        previousVerdict: outcome.previousVerdict,
        newVerdict: outcome.newVerdict,
        delta: outcome.delta,
        status: 'NEW',
      })
      .select()
      .single();

    const headline = outcome.delta.resolvedMisses[0]
      ?? outcome.delta.gainedHits[0]
      ?? `Now scores ${outcome.newVerdict}`;

    notifyDealTeam(
      dealId,
      'DEAL_UPDATED',
      `${row.name}: ${outcome.previousScore} → ${outcome.newScore}`,
      headline,
    ).catch((err) => log.error('[dealReactivation] notify failed', { err }));

    log.info('[dealReactivation] deal reactivated', {
      dealId,
      trigger,
      from: outcome.previousScore,
      to: outcome.newScore,
    });

    return {
      reactivated: true,
      newScore: outcome.newScore,
      reactivationId: reactivation?.id,
    };
  } catch (err: any) {
    log.warn(`[dealReactivation] re-score skipped: ${err?.message}`, { dealId, trigger });
    return { reactivated: false };
  }
}

export interface SweepResult {
  scanned: number;
  eligible: number;
  rescored: number;
  reactivated: number;
  failed: number;
  /** True when the per-run cap dropped work — never truncate silently. */
  truncated: boolean;
}

/**
 * Re-score the dormant deals in one org that have a reason to be looked at.
 *
 * The eligibility gate runs BEFORE any LLM call, off data we already have
 * (newest financial per deal, criteria timestamp, revisit date, cooldown).
 * An org whose passed pile hasn't changed costs one query and nothing else.
 */
export async function sweepPassedDeals(
  orgId: string,
  trigger?: ReactivationTrigger,
): Promise<SweepResult> {
  const empty: SweepResult = {
    scanned: 0, eligible: 0, rescored: 0, reactivated: 0, failed: 0, truncated: false,
  };

  const { data: deals, error } = await supabase
    .from('Deal')
    .select(DEAL_FIELDS)
    .eq('organizationId', orgId)
    .eq('stage', 'PASSED')
    .order('revisitAt', { ascending: true })
    .limit(SWEEP_SCAN_LIMIT);

  if (error) {
    log.error('[dealReactivation] sweep query failed', { orgId, error: error.message });
    return empty;
  }

  const rows = (deals ?? []) as DealRow[];
  if (rows.length === 0) return empty;

  // One batched query for the newest financial per deal, instead of N.
  const { data: statements } = await supabase
    .from('FinancialStatement')
    .select('dealId, createdAt, updatedAt')
    .in('dealId', rows.map((d) => d.id));

  const latestFinancial = new Map<string, string>();
  for (const s of statements ?? []) {
    const stamp = (s.updatedAt ?? s.createdAt) as string | null;
    if (!stamp) continue;
    const current = latestFinancial.get(s.dealId);
    if (!current || stamp > current) latestFinancial.set(s.dealId, stamp);
  }

  const criteriaUpdatedAt = await loadCriteriaUpdatedAt(orgId);
  const now = new Date();

  const eligible: Array<{ deal: DealRow; trigger: ReactivationTrigger }> = [];
  for (const deal of rows) {
    const verdict = isRescoreEligible(
      {
        stage: deal.stage,
        revisitAt: deal.revisitAt,
        lastRescoredAt: deal.lastRescoredAt,
        scorecard: deal.scorecard,
        latestFinancialAt: latestFinancial.get(deal.id) ?? null,
        criteriaUpdatedAt,
      },
      now,
    );
    if (verdict.eligible) {
      eligible.push({ deal, trigger: trigger ?? verdict.trigger });
    }
  }

  const batch = eligible.slice(0, SWEEP_MAX_PER_RUN);
  const truncated = eligible.length > batch.length;
  if (truncated) {
    // Never let a cap look like full coverage.
    log.warn('[dealReactivation] sweep truncated by per-run cap', {
      orgId,
      eligible: eligible.length,
      cap: SWEEP_MAX_PER_RUN,
      deferred: eligible.length - batch.length,
    });
  }

  let rescored = 0;
  let reactivated = 0;
  let failed = 0;

  for (const { deal, trigger: dealTrigger } of batch) {
    try {
      const outcome = await rescorePassedDeal(deal.id, orgId, dealTrigger);
      if (outcome.newScore === undefined && !outcome.reactivated) {
        failed += 1;
        continue;
      }
      rescored += 1;
      if (outcome.reactivated) reactivated += 1;
    } catch (err) {
      failed += 1;
      log.error('[dealReactivation] sweep item failed', {
        dealId: deal.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('[dealReactivation] sweep complete', {
    orgId, scanned: rows.length, eligible: eligible.length, rescored, reactivated, failed, truncated,
  });

  return {
    scanned: rows.length,
    eligible: eligible.length,
    rescored,
    reactivated,
    failed,
    truncated,
  };
}

/**
 * Post-extraction hook for PASSED deals — the sibling of dealScorecard's
 * maybeScoreAfterExtraction. Fresh financials on a dormant deal are the
 * single strongest reactivation signal, so we don't wait for the cron.
 * Never throws.
 */
export async function maybeReactivateAfterExtraction(
  dealId: string,
  orgId: string,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('Deal')
      .select('stage')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();
    if (data?.stage !== 'PASSED') return;
    await rescorePassedDeal(dealId, orgId, 'FINANCIALS_UPDATED');
  } catch (err: any) {
    log.warn(`[dealReactivation] post-extraction hook skipped: ${err?.message}`);
  }
}
