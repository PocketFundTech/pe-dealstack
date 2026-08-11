/**
 * Financial-extraction eval scorer (deterministic, pure).
 * =======================================================
 *
 * Diffs a live/captured extraction (flattened to ScoredPeriod[]) against a
 * GoldenCase and reports extraction-specific metrics + a list of violations.
 * Pure and synchronous — unit-tested against both the known-correct output and
 * the real buggy InstateMe output (which it must flag).
 */
import { normalizePeriodLabel } from '../financialPeriodNormalizer.js';
import type {
  ClassificationResult,
  StatementType,
} from '../financialClassifier.js';
import type {
  GoldenCase,
  ScoredPeriod,
  ScoreResult,
  Violation,
} from './types.js';

/** Pull every period of `statementType` out of a live ClassificationResult. */
export function flattenResult(
  result: ClassificationResult,
  statementType: StatementType,
): ScoredPeriod[] {
  const out: ScoredPeriod[] = [];
  for (const stmt of result.statements) {
    if (stmt.statementType !== statementType) continue;
    for (const p of stmt.periods) {
      out.push({ period: p.period, periodType: p.periodType, lineItems: p.lineItems });
    }
  }
  return out;
}

/** Canonical grouping key for "same period" (normalized label + type). */
function canonKey(period: string, periodType: string): string {
  return `${normalizePeriodLabel(period).toLowerCase()}::${periodType}`;
}

function withinTolerance(actual: number, expected: number, tol: number): boolean {
  if (expected === 0) return Math.abs(actual) <= Math.max(1, Math.abs(tol));
  return Math.abs(actual - expected) / Math.abs(expected) <= tol;
}

/**
 * Score one case. `actual` is the flattened output (from flattenResult, or a
 * captured fixture). Returns metrics + violations; `passed` iff zero violations.
 */
export function scoreCase(golden: GoldenCase, actual: ScoredPeriod[]): ScoreResult {
  const violations: Violation[] = [];

  // ── 1. Phantom periods — forbidden/cohort labels emitted as periods ──
  let phantomPeriods = 0;
  for (const p of actual) {
    const label = normalizePeriodLabel(p.period);
    if (golden.forbiddenPeriodPatterns.some((re) => re.test(p.period) || re.test(label))) {
      phantomPeriods++;
      violations.push({
        kind: 'phantom_period',
        period: p.period,
        detail: `"${p.period}" is a cohort/enrollment label, not a fiscal period (should be a revenue channel within a period)`,
      });
    }
  }

  // ── 2. Duplicate periods — same canonical (label, type) more than once ──
  const groups = new Map<string, ScoredPeriod[]>();
  for (const p of actual) {
    const k = canonKey(p.period, p.periodType);
    const arr = groups.get(k) ?? [];
    arr.push(p);
    groups.set(k, arr);
  }
  let duplicatePeriods = 0;
  for (const [k, arr] of groups.entries()) {
    if (arr.length > 1) {
      duplicatePeriods += arr.length - 1;
      violations.push({
        kind: 'duplicate_period',
        period: arr[0].period,
        detail: `${arr.length} statements collapse to the same period key "${k}" (labels: ${arr.map((x) => x.period).join(', ')})`,
      });
    }
  }

  // ── 2b. Extra periods — output labels absent from the (complete) expected
  //        set and not already flagged as cohort phantoms. Catches spurious
  //        periods like a "2026" HISTORICAL that double-counts a "2026E"
  //        PROJECTED. One count per canonical group (dupes handled above).
  const expectedLabels = new Set(golden.expected.map((e) => e.period.toLowerCase()));
  let extraPeriods = 0;
  for (const [k, arr] of groups.entries()) {
    const label = normalizePeriodLabel(arr[0].period);
    const isForbidden = golden.forbiddenPeriodPatterns.some(
      (re) => re.test(arr[0].period) || re.test(label),
    );
    if (isForbidden) continue; // already a phantom
    if (!expectedLabels.has(label.toLowerCase())) {
      extraPeriods++;
      violations.push({
        kind: 'extra_period',
        period: arr[0].period,
        detail: `period "${arr[0].period}" (key "${k}") is not in the expected set — likely a mislabelled duplicate of another period`,
      });
    }
  }

  // ── 3. Expected-period matching (recall, period-type, line items) ──
  let matchedPeriods = 0;
  let typeCorrect = 0;
  let lineItemsExpected = 0;
  let lineItemsMatched = 0;

  for (const exp of golden.expected) {
    const match = actual.find(
      (p) => normalizePeriodLabel(p.period).toLowerCase() === exp.period.toLowerCase(),
    );
    if (!match) {
      violations.push({
        kind: 'missing_period',
        period: exp.period,
        detail: `expected period "${exp.period}" (${exp.periodType}) not found in output`,
      });
      lineItemsExpected += Object.keys(exp.lineItems).length;
      continue;
    }
    matchedPeriods++;

    if (match.periodType === exp.periodType) {
      typeCorrect++;
    } else {
      violations.push({
        kind: 'wrong_period_type',
        period: exp.period,
        detail: `"${exp.period}" is ${match.periodType}, expected ${exp.periodType}`,
      });
    }

    for (const [key, expVal] of Object.entries(exp.lineItems)) {
      lineItemsExpected++;
      const got = match.lineItems[key];
      if (got == null) {
        violations.push({
          kind: 'missing_line_item',
          period: exp.period,
          detail: `line item "${key}" missing (expected ${expVal})`,
        });
        continue;
      }
      if (!withinTolerance(got, expVal, golden.valueTolerance)) {
        violations.push({
          kind: 'wrong_value',
          period: exp.period,
          detail: `line item "${key}" = ${got}, expected ~${expVal} (tol ${golden.valueTolerance})`,
        });
        continue;
      }
      lineItemsMatched++;
    }
  }

  const expectedPeriods = golden.expected.length;
  const periodRecall = expectedPeriods ? matchedPeriods / expectedPeriods : 1;
  const periodTypeAccuracy = matchedPeriods ? typeCorrect / matchedPeriods : 1;
  const lineItemCoverage = lineItemsExpected ? lineItemsMatched / lineItemsExpected : 1;

  // Composite: recall + type accuracy + line-item coverage, each penalised by
  // phantom/duplicate noise. A single phantom or duplicate meaningfully drops
  // the score because it corrupts the period axis of every downstream chart.
  const noisePenalty = 1 / (1 + phantomPeriods + duplicatePeriods + extraPeriods);
  const score =
    noisePenalty * (0.4 * periodRecall + 0.3 * periodTypeAccuracy + 0.3 * lineItemCoverage);

  return {
    caseId: golden.id,
    passed: violations.length === 0,
    score,
    metrics: {
      phantomPeriods,
      duplicatePeriods,
      extraPeriods,
      expectedPeriods,
      matchedPeriods,
      periodRecall,
      periodTypeAccuracy,
      lineItemCoverage,
    },
    violations,
  };
}

/** One-line human summary for the runner's console table. */
export function formatScoreLine(r: ScoreResult): string {
  const m = r.metrics;
  return (
    `${r.passed ? 'PASS' : 'FAIL'} ${r.caseId}  score=${r.score.toFixed(2)}  ` +
    `phantom=${m.phantomPeriods} dup=${m.duplicatePeriods} extra=${m.extraPeriods} ` +
    `recall=${(m.periodRecall * 100).toFixed(0)}% ` +
    `type=${(m.periodTypeAccuracy * 100).toFixed(0)}% ` +
    `items=${(m.lineItemCoverage * 100).toFixed(0)}%`
  );
}
