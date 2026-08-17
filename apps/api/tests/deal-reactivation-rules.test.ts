/**
 * Deal reactivation — the pure rules (spec §5.5, §5.6).
 *
 * Two jobs, both worth isolating from Supabase:
 *
 *  1. isRescoreEligible — the cost gate. A firm with 300 passed deals must
 *     generate ZERO LLM calls on a cron run when nothing has changed. Get
 *     this wrong and the feature quietly eats the customer's deal allowance.
 *  2. detectReactivation — what counts as "this deal got interesting again".
 */
import { describe, it, expect } from 'vitest';
import {
  isRescoreEligible,
  detectReactivation,
  RESCORE_MIN_INTERVAL_DAYS,
  DEFAULT_REACTIVATION_DELTA,
} from '../src/services/agents/dealReactivation/rules.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const dateDaysAhead = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dateDaysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function passedDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deal-1',
    stage: 'PASSED',
    revisitAt: null as string | null,
    lastRescoredAt: daysAgo(90),
    scorecard: { overallScore: 40, verdict: 'NO_GO', scoredAt: daysAgo(90) },
    latestFinancialAt: null as string | null,
    criteriaUpdatedAt: null as string | null,
    ...overrides,
  };
}

describe('isRescoreEligible', () => {
  it('says no when nothing at all has changed — the cost gate', () => {
    expect(isRescoreEligible(passedDeal(), NOW)).toEqual({ eligible: false });
  });

  it('never touches a deal that is not passed', () => {
    const live = passedDeal({ stage: 'DUE_DILIGENCE', revisitAt: dateDaysAgo(1) });
    expect(isRescoreEligible(live, NOW).eligible).toBe(false);
  });

  it('fires when financials landed after the last scoring', () => {
    const deal = passedDeal({ latestFinancialAt: daysAgo(2) });
    expect(isRescoreEligible(deal, NOW)).toEqual({
      eligible: true,
      trigger: 'FINANCIALS_UPDATED',
    });
  });

  it('ignores financials that predate the last scoring', () => {
    const deal = passedDeal({ latestFinancialAt: daysAgo(120) });
    expect(isRescoreEligible(deal, NOW).eligible).toBe(false);
  });

  it('fires when the firm changed its criteria after the deal was scored', () => {
    const deal = passedDeal({ criteriaUpdatedAt: daysAgo(3) });
    expect(isRescoreEligible(deal, NOW)).toEqual({
      eligible: true,
      trigger: 'CRITERIA_CHANGED',
    });
  });

  it('ignores criteria changes older than the scorecard', () => {
    const deal = passedDeal({ criteriaUpdatedAt: daysAgo(200) });
    expect(isRescoreEligible(deal, NOW).eligible).toBe(false);
  });

  it('fires when the revisit date has arrived', () => {
    const deal = passedDeal({ revisitAt: dateDaysAgo(0) });
    expect(isRescoreEligible(deal, NOW)).toEqual({ eligible: true, trigger: 'REVISIT_DUE' });
  });

  it('waits for a revisit date still in the future', () => {
    const deal = passedDeal({ revisitAt: dateDaysAhead(30) });
    expect(isRescoreEligible(deal, NOW).eligible).toBe(false);
  });

  it('holds the line for a fortnight after a re-score, whatever the trigger', () => {
    const justScored = passedDeal({
      lastRescoredAt: daysAgo(RESCORE_MIN_INTERVAL_DAYS - 1),
      latestFinancialAt: daysAgo(0),
      revisitAt: dateDaysAgo(1),
    });
    expect(isRescoreEligible(justScored, NOW).eligible).toBe(false);

    const cooledOff = passedDeal({
      lastRescoredAt: daysAgo(RESCORE_MIN_INTERVAL_DAYS + 1),
      latestFinancialAt: daysAgo(0),
    });
    expect(isRescoreEligible(cooledOff, NOW).eligible).toBe(true);
  });

  it('scores a never-scored passed deal when its revisit date lands', () => {
    const deal = passedDeal({ scorecard: null, lastRescoredAt: null, revisitAt: dateDaysAgo(1) });
    expect(isRescoreEligible(deal, NOW)).toEqual({ eligible: true, trigger: 'REVISIT_DUE' });
  });

  it('does not fire on a never-scored deal with no trigger at all', () => {
    const deal = passedDeal({ scorecard: null, lastRescoredAt: null });
    expect(isRescoreEligible(deal, NOW).eligible).toBe(false);
  });
});

describe('detectReactivation', () => {
  const previous = {
    overallScore: 40,
    verdict: 'NO_GO' as const,
    reasons: [
      { kind: 'miss' as const, text: 'Outside size range: $2M EBITDA vs the firm’s $5M min' },
      { kind: 'flag' as const, text: 'Customer concentration above 40%' },
    ],
  };

  it('reactivates on a big score jump', () => {
    const next = { ...previous, overallScore: 40 + DEFAULT_REACTIVATION_DELTA, verdict: 'BORDERLINE' as const };
    const result = detectReactivation(previous, next);
    expect(result.reactivated).toBe(true);
    expect(result.previousScore).toBe(40);
    expect(result.newScore).toBe(40 + DEFAULT_REACTIVATION_DELTA);
  });

  it('stays quiet on a small wobble', () => {
    const next = { ...previous, overallScore: 46 };
    expect(detectReactivation(previous, next).reactivated).toBe(false);
  });

  it('reactivates when the verdict crosses out of NO_GO even on a small move', () => {
    // A verdict flip is the signal a partner actually acts on, so it counts
    // regardless of how few points moved.
    const next = { ...previous, overallScore: 46, verdict: 'BORDERLINE' as const };
    expect(detectReactivation(previous, next).reactivated).toBe(true);
  });

  it('reactivates when BORDERLINE becomes GO', () => {
    const borderline = { ...previous, overallScore: 60, verdict: 'BORDERLINE' as const };
    const next = { ...borderline, overallScore: 64, verdict: 'GO' as const };
    expect(detectReactivation(borderline, next).reactivated).toBe(true);
  });

  it('never reactivates on a decline', () => {
    const next = { ...previous, overallScore: 10, verdict: 'NO_GO' as const };
    expect(detectReactivation(previous, next).reactivated).toBe(false);
  });

  it('never reactivates on a verdict going backwards', () => {
    const go = { ...previous, overallScore: 80, verdict: 'GO' as const };
    const next = { ...go, overallScore: 78, verdict: 'BORDERLINE' as const };
    expect(detectReactivation(go, next).reactivated).toBe(false);
  });

  it('explains what changed, so the alert is actionable', () => {
    const next = {
      overallScore: 78,
      verdict: 'GO' as const,
      reasons: [
        { kind: 'hit' as const, text: 'Inside size range: $6M EBITDA' },
        { kind: 'flag' as const, text: 'Customer concentration above 40%' },
      ],
    };
    const { delta } = detectReactivation(previous, next);
    expect(delta.resolvedMisses).toEqual([
      'Outside size range: $2M EBITDA vs the firm’s $5M min',
    ]);
    expect(delta.gainedHits).toEqual(['Inside size range: $6M EBITDA']);
    // The concentration flag persisted, so it is not news.
    expect(delta.gainedHits).not.toContain('Customer concentration above 40%');
  });

  it('treats a first-ever scorecard as no reactivation', () => {
    const next = { overallScore: 90, verdict: 'GO' as const, reasons: [] };
    expect(detectReactivation(null, next).reactivated).toBe(false);
  });
});
