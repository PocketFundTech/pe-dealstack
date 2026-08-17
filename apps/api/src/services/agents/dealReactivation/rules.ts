// ─── Deal reactivation — pure rules ───────────────────────────────
// Kept Supabase-free so the two decisions that matter can be tested on
// their own:
//
//   isRescoreEligible  — the COST GATE. Every `true` here is an LLM call.
//                        A firm with 300 passed deals and no new data must
//                        produce zero calls per cron run.
//   detectReactivation — whether a re-score is worth interrupting a
//                        partner for.

export type ReactivationTrigger =
  | 'FINANCIALS_UPDATED'
  | 'CRITERIA_CHANGED'
  | 'REVISIT_DUE'
  | 'MANUAL';

export type Verdict = 'GO' | 'NO_GO' | 'BORDERLINE';

/** Minimum gap between AUTOMATIC re-scores of the same deal. */
export const RESCORE_MIN_INTERVAL_DAYS = 14;

/** Score jump that counts as "this got interesting again". */
export const DEFAULT_REACTIVATION_DELTA = 15;

const DAY_MS = 86_400_000;

/** Ranked so we can tell "moved up" from "moved down". */
const VERDICT_RANK: Record<Verdict, number> = { NO_GO: 0, BORDERLINE: 1, GO: 2 };

interface EligibilityInput {
  stage: string;
  revisitAt: string | null;
  lastRescoredAt: string | null;
  scorecard: { scoredAt?: string } | null;
  /** Newest FinancialStatement createdAt/updatedAt for this deal. */
  latestFinancialAt: string | null;
  /** When the org last edited its dealCriteria. */
  criteriaUpdatedAt: string | null;
}

export type Eligibility =
  | { eligible: false }
  | { eligible: true; trigger: ReactivationTrigger };

function reactivationDelta(): number {
  const raw = Number(process.env.REACTIVATION_MIN_DELTA);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REACTIVATION_DELTA;
}

/**
 * Should we spend an LLM call re-scoring this passed deal?
 *
 * Only when something actually changed: new financials, changed criteria,
 * or an arrived revisit date — and never more often than the cooldown,
 * whatever the trigger. Anything else returns false and costs nothing.
 */
export function isRescoreEligible(deal: EligibilityInput, now: Date = new Date()): Eligibility {
  if (deal.stage !== 'PASSED') return { eligible: false };

  // Cooldown applies to every automatic path. Manual re-scores bypass this
  // entirely by not going through here.
  if (deal.lastRescoredAt) {
    const sinceDays = (now.getTime() - new Date(deal.lastRescoredAt).getTime()) / DAY_MS;
    if (sinceDays < RESCORE_MIN_INTERVAL_DAYS) return { eligible: false };
  }

  // Reference point for "is this news": when we last formed a view.
  const scoredAt = deal.scorecard?.scoredAt ?? deal.lastRescoredAt ?? null;
  const isNewerThanScore = (iso: string | null): boolean => {
    if (!iso) return false;
    if (!scoredAt) return true;
    return new Date(iso).getTime() > new Date(scoredAt).getTime();
  };

  if (isNewerThanScore(deal.latestFinancialAt)) {
    return { eligible: true, trigger: 'FINANCIALS_UPDATED' };
  }
  if (isNewerThanScore(deal.criteriaUpdatedAt)) {
    return { eligible: true, trigger: 'CRITERIA_CHANGED' };
  }
  // revisitAt is a DATE column: "due" means today or earlier. Anchoring to
  // the START of that day matters — anchoring to its end would silently
  // defer every revisit by a day.
  if (deal.revisitAt && new Date(`${deal.revisitAt}T00:00:00Z`).getTime() <= now.getTime()) {
    return { eligible: true, trigger: 'REVISIT_DUE' };
  }

  return { eligible: false };
}

interface ScorecardLike {
  overallScore: number;
  verdict: Verdict;
  reasons?: Array<{ kind: 'hit' | 'miss' | 'flag'; text: string }>;
}

export interface ReactivationDelta {
  /** Criteria this deal used to fail and now doesn't. */
  resolvedMisses: string[];
  /** Criteria it now satisfies that weren't called out before. */
  gainedHits: string[];
  /** New concerns introduced since last time. */
  newFlags: string[];
}

export interface ReactivationResult {
  reactivated: boolean;
  previousScore: number | null;
  newScore: number;
  previousVerdict: Verdict | null;
  newVerdict: Verdict;
  delta: ReactivationDelta;
}

/**
 * Did this re-score change the picture enough to surface?
 *
 * Either a material score jump, or the verdict climbing a rung — a verdict
 * flip is what a partner actually acts on, so it counts even when the
 * points barely moved. Declines never surface: nobody needs an alert that
 * a deal they already passed on got worse.
 */
export function detectReactivation(
  previous: ScorecardLike | null,
  next: ScorecardLike,
): ReactivationResult {
  const prevReasons = previous?.reasons ?? [];
  const nextReasons = next.reasons ?? [];

  const textsOfKind = (list: typeof prevReasons, kind: 'hit' | 'miss' | 'flag') =>
    list.filter((r) => r.kind === kind).map((r) => r.text);

  const prevMisses = textsOfKind(prevReasons, 'miss');
  const nextMisses = new Set(textsOfKind(nextReasons, 'miss'));
  const prevHits = new Set(textsOfKind(prevReasons, 'hit'));
  const prevFlags = new Set(textsOfKind(prevReasons, 'flag'));

  const delta: ReactivationDelta = {
    resolvedMisses: prevMisses.filter((text) => !nextMisses.has(text)),
    gainedHits: textsOfKind(nextReasons, 'hit').filter((text) => !prevHits.has(text)),
    newFlags: textsOfKind(nextReasons, 'flag').filter((text) => !prevFlags.has(text)),
  };

  // No prior view means nothing to compare — score it, don't alert on it.
  if (!previous) {
    return {
      reactivated: false,
      previousScore: null,
      newScore: next.overallScore,
      previousVerdict: null,
      newVerdict: next.verdict,
      delta,
    };
  }

  const scoreJump = next.overallScore - previous.overallScore;
  const verdictClimbed = VERDICT_RANK[next.verdict] > VERDICT_RANK[previous.verdict];
  const reactivated = scoreJump >= reactivationDelta() || verdictClimbed;

  return {
    reactivated,
    previousScore: previous.overallScore,
    newScore: next.overallScore,
    previousVerdict: previous.verdict,
    newVerdict: next.verdict,
    delta,
  };
}
