/**
 * Financial-extraction eval harness — shared types.
 * ================================================
 *
 * Purpose: make extraction QUALITY measurable instead of vibes. A GoldenCase
 * pins the known-correct structured output for a real document set; the scorer
 * (score.ts) diffs a live ClassificationResult against it and reports
 * extraction-specific metrics (phantom periods, duplicate periods, period-type
 * accuracy, line-item coverage). Prompt / model / few-shot changes are then
 * judged by the delta they move on these metrics — the workflow the repo's
 * extraction roadmap calls for (eval + few-shot BEFORE more prompt patching).
 *
 * These types deliberately mirror the live classifier output
 * (`ClassificationResult` in financialClassifier.ts) so a golden case can be
 * scored against real pipeline output with no adapter.
 */
import type {
  PeriodType,
  StatementType,
} from '../financialClassifier.js';

/** One expected period in a golden case. */
export interface ExpectedPeriod {
  /** Canonical period label AFTER normalizePeriodLabel() (e.g. "2024", "2026E"). */
  period: string;
  periodType: PeriodType;
  /**
   * Line items we assert on. Values are in the case's declared unitScale
   * (usually ACTUALS). Only the keys listed here are checked — a case need
   * not enumerate every sub-line-item; list the ones that matter.
   */
  lineItems: Record<string, number>;
}

/** A known-correct extraction for one document set. */
export interface GoldenCase {
  id: string;
  description: string;
  /**
   * Path (relative to repo root) to the source text/fixture the classifier
   * runs on when the live runner executes this case. Optional for
   * fixture-only cases scored against a captured output.
   */
  sourceTextPath?: string;
  /** The date to pin as "today" for HISTORICAL vs PROJECTED classification. */
  todayIso: string;
  statementType: StatementType;
  /** Every period that SHOULD be produced, keyed by canonical label. */
  expected: ExpectedPeriod[];
  /**
   * Period-label patterns that must NOT appear as standalone periods.
   * Enrollment/cohort labels ("Fall 2026", "Spring 2027") are revenue
   * CHANNELS within a fiscal period, never their own period.
   */
  forbiddenPeriodPatterns: RegExp[];
  /** Tolerance for numeric line-item comparison (fraction, e.g. 0.01 = 1%). */
  valueTolerance: number;
}

/** A flat (period, periodType, lineItems) row — the unit the scorer compares. */
export interface ScoredPeriod {
  period: string;
  periodType: PeriodType;
  lineItems: Record<string, number | null>;
}

/** A single scoring violation, human-readable + machine-filterable. */
export interface Violation {
  kind:
    | 'phantom_period' // a forbidden/cohort label emitted as a period
    | 'duplicate_period' // same canonical (period, periodType) more than once
    | 'extra_period' // an output period not in the (complete) expected set
    | 'missing_period' // an expected period absent from the output
    | 'wrong_period_type' // period present but HISTORICAL/PROJECTED wrong
    | 'missing_line_item' // expected line item absent
    | 'wrong_value'; // line item present but value out of tolerance
  period: string;
  detail: string;
}

/** The full score for one case run. */
export interface ScoreResult {
  caseId: string;
  passed: boolean;
  /** 0..1 composite (weighted) — see score.ts for the weighting. */
  score: number;
  metrics: {
    phantomPeriods: number;
    duplicatePeriods: number;
    extraPeriods: number;
    expectedPeriods: number;
    matchedPeriods: number;
    periodRecall: number; // matched / expected
    periodTypeAccuracy: number; // correct-type / matched
    lineItemCoverage: number; // matched line items / expected line items
  };
  violations: Violation[];
}
