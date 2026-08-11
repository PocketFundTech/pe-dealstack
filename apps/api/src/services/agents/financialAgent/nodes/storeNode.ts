/**
 * Store Node — LangGraph node for the financial extraction agent.
 *
 * Persists validated financial statements to Supabase via the existing
 * runDeepPass() orchestrator. This reuses all the conflict detection,
 * merge status, and partial unique index logic already built.
 *
 * Does NOT duplicate any DB logic — delegates entirely to runDeepPass().
 */

import { runDeepPass } from '../../../financialExtractionOrchestrator.js';
import { recordExtractionLearning } from '../../../agentMemory.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import type { FinancialAgentStateType } from '../state.js';
import type { AgentStep } from '../state.js';
import { CLAUDE_NATIVE_PDF_MARKER } from '../../../extraction/claudeEngine.js';
import {
  applySourceTextDollarOverride,
  type ClassificationResult,
  type ClassifiedStatement,
  type FinancialPeriod,
} from '../../../financialClassifier.js';
import {
  parsePeriodToYearMonth,
  getLineItemDollars,
  REVENUE_KEYS,
} from '../../../reconciler/shared.js';
import {
  computeCompositeConfidence,
  getConfidenceTier,
  scoreSourceMatch,
  scoreMathValidation,
  scoreCrossModel,
} from '../../../compositeConfidence.js';

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * Marker prefix set by the Claude engine's native-PDF path (claudeEngine.ts)
 * when there's no real text layer to check sourceQuotes against — native
 * PDF input replaces pdf-parse entirely for that path, so scoreSourceMatch's
 * substring check has nothing real to compare against.
 */
export { CLAUDE_NATIVE_PDF_MARKER } from '../../../extraction/claudeEngine.js';

/** A bare page marker (no quote captured) carries the same evidentiary
 * weight as "no source" — the model didn't cite anything checkable. */
function isBarePageMarker(sourceValue: string): boolean {
  const trimmed = sourceValue.trim();
  // An empty/whitespace-only quote carries the same evidentiary weight as a
  // bare page marker — no real citation was captured, matching legacy
  // scoreSourceMatch's treatment of a falsy quote (compositeConfidence.ts).
  return trimmed === '' || /^p(\d+|\?)$/.test(trimmed);
}

/**
 * Score a single _source value when there's no real text layer to check it
 * against. The structured extraction schema REQUIRES sourcePage/sourceQuote
 * per line item (extractionSchema.ts), so a well-formed quote is a real —
 * if unverified — provenance signal: better than no citation at all, but
 * not confirmable the way a text-layer substring match is. Deliberately
 * scored below scoreSourceMatch's 100 (confirmed) and 80 (partial) tiers.
 */
function scoreClaudeNativePdfSource(sourceValue: string): number {
  return isBarePageMarker(sourceValue) ? 20 : 75;
}

/**
 * Average source-match confidence across every _source field in the
 * extracted statements. Exported as a pure function for testing (mirrors
 * the `reconcileResults` "exported for testing" convention in
 * crossVerifyNode.ts).
 *
 * When rawText carries CLAUDE_NATIVE_PDF_MARKER, scoreSourceMatch's
 * text-substring check is skipped in favor of scoreClaudeNativePdfSource —
 * there's no real document text to check citations against. Claude-Excel
 * extractions (rawText = real converted Excel text) still use
 * scoreSourceMatch normally, as do all legacy (gpt4o/azure/vision) sources.
 */
export function computeSourceMatchAvg(
  statements: ClassifiedStatement[],
  rawText: string,
): number {
  if (!rawText || statements.length === 0) return 20; // default if no source quotes

  const usesClaudeNativePdf = rawText.startsWith(CLAUDE_NATIVE_PDF_MARKER);
  const scores: number[] = [];
  for (const stmt of statements) {
    for (const period of stmt.periods) {
      for (const [key, val] of Object.entries(period.lineItems || {})) {
        if (key.endsWith('_source') && typeof val === 'string') {
          scores.push(usesClaudeNativePdf ? scoreClaudeNativePdfSource(val) : scoreSourceMatch(val, rawText));
        }
      }
    }
  }
  if (scores.length === 0) return 20;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/**
 * Pre-write dedup of overlapping annual + monthly periods AND zeroed annual
 * projections. Mutates each statement's `periods[]` in place.
 *
 * Why pre-write (not post-store like the audit-report dedup in
 * groundTruth.ts): runDeepPass() upserts every period as its own DB row, so
 * by the time the audit reader collapses overlaps the duplicates already
 * live in the DB and pollute every other consumer (UI tables,
 * dealCacheWriteback, cross-doc reconciler). Mirroring groundTruth.ts'
 * "monthly wins over annual for the same year" rule here keeps the DB clean
 * intra-document. Cross-document reconciliation is a separate concern.
 *
 * Rule C: when multiple monthly periods within a single statement resolve
 *         to the same (year, month), keep one canonical-label period and
 *         drop the rest. Runs FIRST so Rule A's overlap detection isn't
 *         inflated by label-format duplicates of the same source row.
 * Rule A: when a year has both an annual period and any monthly period,
 *         drop the annual.
 * Rule B: when an annual period has revenue == 0 but the same year's
 *         monthly periods sum to materially non-zero revenue, drop the
 *         (almost certainly stub) annual.
 *
 * Returns one log entry per dropped period so the agent log shows what
 * happened.
 */
const ZERO_ANNUAL_REVENUE_THRESHOLD_USD = 1000;

/** Rank a monthly period label for canonical-keep selection. Lower wins.
 * Why: ISO `YYYY-MM` is unambiguous; long-form `Mon YYYY` survives any
 * downstream UI that strips two-digit-year heuristics; short-form `Mon-YY`
 * is the most likely to be re-parsed wrong by a dumb consumer. */
function canonicalLabelRank(label: string): number {
  const trimmed = label.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return 0;
  if (/^[A-Za-z]+\s+\d{4}$/.test(trimmed)) return 1;
  if (/^[A-Za-z]+-\d{2}$/.test(trimmed)) return 2;
  return 3;
}

export function dedupAnnualVsMonthly(statements: ClassifiedStatement[]): AgentStep[] {
  const logs: AgentStep[] = [];

  for (const stmt of statements) {
    if (stmt.periods.length === 0) continue;

    // ─── Rule C — collapse same-(year,month) duplicates first ────────
    type ParsedPeriod = { period: FinancialPeriod; year: number; month: number; idx: number };
    const monthlyByKey = new Map<string, ParsedPeriod[]>();
    stmt.periods.forEach((period, idx) => {
      const parsed = parsePeriodToYearMonth(period.period);
      if (!parsed || parsed.month == null) return;
      const key = `${parsed.year}-${parsed.month}`;
      const arr = monthlyByKey.get(key) ?? [];
      arr.push({ period, year: parsed.year, month: parsed.month, idx });
      monthlyByKey.set(key, arr);
    });

    const ruleCDrops = new Set<FinancialPeriod>();
    for (const [, group] of monthlyByKey) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const r = canonicalLabelRank(a.period.period) - canonicalLabelRank(b.period.period);
        return r !== 0 ? r : a.idx - b.idx;
      });
      const keep = sorted[0];
      const drops = sorted.slice(1);

      // Warn (don't merge) when retained candidates disagree on any shared
      // numeric line item — the equal-value case is the common one, so a
      // mismatch means the upstream extractor is producing inconsistent
      // numbers under different labels and a human should look.
      for (const cand of drops) {
        for (const [field, val] of Object.entries(cand.period.lineItems)) {
          if (typeof val !== 'number' || !Number.isFinite(val)) continue;
          const keepVal = keep.period.lineItems[field];
          if (typeof keepVal !== 'number' || !Number.isFinite(keepVal)) continue;
          if (keepVal !== val) {
            logs.push(step(
              'store',
              `Same-month dedup mismatch on ${stmt.statementType} ${field} for ${cand.period.period} vs ${keep.period.period}: ${keepVal} vs ${val}`,
              'Pre-write dedup (Rule C: divergent values; keeping canonical-label).',
            ));
          }
        }
      }

      for (const cand of drops) {
        ruleCDrops.add(cand.period);
        logs.push(step(
          'store',
          `Dropped duplicate ${stmt.statementType} period "${cand.period.period}" — same (year, month) as kept "${keep.period.period}"`,
          'Pre-write dedup (Rule C: same-month-different-label).',
        ));
      }
    }
    if (ruleCDrops.size > 0) {
      stmt.periods = stmt.periods.filter(p => !ruleCDrops.has(p));
    }

    // ─── Rule A / Rule B — annual vs monthly ─────────────────────────
    // Bucket each period into annual / monthly by parsed shape.
    type Tagged = { period: FinancialPeriod; year: number; isMonthly: boolean };
    const tagged: Tagged[] = [];
    for (const period of stmt.periods) {
      const parsed = parsePeriodToYearMonth(period.period);
      if (!parsed) continue;
      tagged.push({ period, year: parsed.year, isMonthly: parsed.month != null });
    }

    const yearsWithMonthly = new Set<number>();
    for (const t of tagged) if (t.isMonthly) yearsWithMonthly.add(t.year);

    // Sum monthly revenue per year (actual dollars) for Rule B.
    const monthlyRevenueByYear = new Map<number, number>();
    for (const t of tagged) {
      if (!t.isMonthly) continue;
      const rev = getLineItemDollars(t.period.lineItems, REVENUE_KEYS, stmt.unitScale);
      if (rev == null) continue;
      monthlyRevenueByYear.set(t.year, (monthlyRevenueByYear.get(t.year) ?? 0) + rev);
    }

    const periodsToDrop = new Set<FinancialPeriod>();

    for (const t of tagged) {
      if (t.isMonthly) continue;
      // Rule A — annual + any monthly for the same year → drop annual.
      if (yearsWithMonthly.has(t.year)) {
        periodsToDrop.add(t.period);
        logs.push(step(
          'store',
          `Dropped annual ${stmt.statementType} period "${t.period.period}" — monthly rows present for ${t.year}`,
          'Pre-write dedup (Rule A: annual/monthly overlap).',
        ));
        continue;
      }
      // Rule B — annual revenue==0 but monthly sum > threshold → drop annual.
      const annualRev = getLineItemDollars(t.period.lineItems, REVENUE_KEYS, stmt.unitScale);
      const monthlyRev = monthlyRevenueByYear.get(t.year);
      if (
        annualRev === 0 &&
        monthlyRev != null &&
        Math.abs(monthlyRev) > ZERO_ANNUAL_REVENUE_THRESHOLD_USD
      ) {
        periodsToDrop.add(t.period);
        logs.push(step(
          'store',
          `Dropped zeroed annual ${stmt.statementType} period "${t.period.period}" — monthly revenue sums to $${Math.round(monthlyRev).toLocaleString()} for ${t.year}`,
          'Pre-write dedup (Rule B: zero annual + non-zero monthly).',
        ));
      }
    }

    if (periodsToDrop.size > 0) {
      stmt.periods = stmt.periods.filter(p => !periodsToDrop.has(p));
    }
  }

  return logs;
}

/**
 * LangGraph Store Node
 *
 * Reads: dealId, documentId, statements, classification, rawText, extractionSource
 * Writes: statementIds, periodsStored, hasConflicts, status, steps
 */
export async function storeNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { dealId, documentId, statements, classification, rawText, extractionSource, crossVerifyResult } = state;

  if (!statements || statements.length === 0) {
    steps.push(step('store', 'No statements to store'));
    return {
      statementIds: [],
      periodsStored: 0,
      hasConflicts: false,
      status: 'completed',
      steps: [...steps, step('store', 'Agent completed — no financial data extracted')],
    };
  }

  const stmtTypes = statements.map(s => s.statementType).join(', ');
  const totalPeriods = statements.reduce((sum, s) => sum + s.periods.length, 0);
  steps.push(step('store', `Storing ${stmtTypes} (${totalPeriods} periods) to database`));

  try {
    // Pre-write dedup. Mutates `statements` in place — must run BEFORE
    // building classificationToStore so runDeepPass never sees the
    // overlapping annual rows or the zeroed annual projections.
    const dedupLogs = dedupAnnualVsMonthly(statements);
    if (dedupLogs.length > 0) {
      steps.push(...dedupLogs);
      steps.push(step('store', `Pre-write dedup removed ${dedupLogs.length} period(s)`));
    }

    // Build a ClassificationResult from the current (possibly corrected) statements
    const classificationToStore: ClassificationResult = {
      statements,
      overallConfidence: state.overallConfidence,
      warnings: state.warnings,
    };

    // Last-mile unit guard: run the source-quote dollar override on the
    // statements about to be persisted. This is the canonical hook —
    // catches the path where extraction ran cleanly (no self-correct loop)
    // but the LLM still mis-tagged a synthesized period (LTM, "Current
    // Month") whose `_source` quotes literally cite "$1,473" / "~$15,600".
    // Idempotent on rows that the upstream classifier already corrected.
    applySourceTextDollarOverride(classificationToStore);

    // Compute composite confidence
    const mathScore = scoreMathValidation(
      state.validationResult?.errorCount ?? 0,
      state.validationResult?.warningCount ?? 0,
    );

    const crossModelScore = crossVerifyResult
      ? scoreCrossModel(crossVerifyResult.agreedCount, crossVerifyResult.flaggedValues.length)
      : null;

    // Average source match across all periods
    const sourceMatchAvg = computeSourceMatchAvg(statements, rawText);

    const compositeScore = computeCompositeConfidence({
      llmConfidence: state.overallConfidence,
      sourceMatch: sourceMatchAvg,
      mathValidation: mathScore,
      crossModelAgreement: crossModelScore,
    });

    const tier = getConfidenceTier(compositeScore);
    steps.push(step('store', `Composite confidence: ${compositeScore}% (tier: ${tier})`,
      `LLM: ${state.overallConfidence}%, Source: ${sourceMatchAvg}%, Math: ${mathScore}%, CrossModel: ${crossModelScore ?? 'N/A'}%`));

    // Add warnings for cross-verify flagged values
    if (crossVerifyResult && crossVerifyResult.flaggedValues.length > 0) {
      const flagWarnings = crossVerifyResult.flaggedValues.map(f =>
        `Cross-verification disagreement on ${f.field}: primary=${f.gpt4o_value}, verified=${f.claude_value}${f.issue ? ` (${f.issue})` : ''}`
      );
      classificationToStore.warnings = [
        ...(classificationToStore.warnings || []),
        ...flagWarnings,
      ];
      steps.push(step('store',
        `${crossVerifyResult.flaggedValues.length} values flagged by cross-verification`,
        flagWarnings.join('; '),
      ));
    }

    // Confidence-aware storage. Previously: tier 'very_low' (<60%) was a hard
    // refusal — the entire batch was discarded and the user saw nothing. That
    // silently lost legitimate data when cross-verify flagged a few derived
    // fields the source genuinely didn't have (e.g., a P&L without an explicit
    // EBITDA line gets EBITDA flagged → composite drops to ~58 → store
    // refused). For a 36-month spreadsheet, throwing away every period because
    // 4 derived fields disagreed is the wrong tradeoff.
    //
    // New behaviour: ALWAYS store, but surface the confidence tier as the
    // mergeStatus so the UI can flag low-confidence extractions for review.
    // Below ~30% composite (extreme garbage) we still skip — at that point the
    // extraction is so unreliable that polluting the deal record is worse than
    // showing nothing.
    if (compositeScore < 30) {
      steps.push(step('store', `Composite confidence ${compositeScore}% is critically low — refusing to store. User must re-extract.`));
      return {
        status: 'completed',
        overallConfidence: compositeScore,
        warnings: [...(state.warnings || []), `Extraction confidence critically low (${compositeScore}%). Storage skipped.`],
        steps,
      };
    }
    if (tier === 'very_low') {
      // 30-60% — store but flag for review. User can fix individual periods
      // rather than re-running the whole 5-minute extraction.
      steps.push(step(
        'store',
        `Composite confidence ${compositeScore}% — storing with needs_review flag so you can audit individual periods.`,
        `Common cause: cross-verify flagged derived fields (EBITDA, margins) the source doesn't actually have. The raw revenue / opex / net income periods are usually fine.`,
      ));
    }

    const result = await runDeepPass({
      text: rawText,
      dealId,
      documentId: documentId ?? undefined,
      classification: classificationToStore,
      extractionSource,
    });

    if (!result) {
      steps.push(step('store', 'runDeepPass returned null — storage failed'));
      return {
        status: 'failed',
        error: 'Failed to store financial statements',
        steps,
      };
    }

    steps.push(step(
      'store',
      `Stored ${result.periodsStored} periods (${result.statementsStored} statement types)`,
      result.hasConflicts ? 'Conflicts detected — flagged for user review' : undefined,
    ));

    if (result.hasConflicts) {
      steps.push(step('store', 'Multi-document conflicts found — existing data flagged as needs_review'));
    }

    // Final completion step with summary
    const validationSummary = state.validationResult
      ? `Validation: ${state.validationResult.errorCount} errors, ${state.validationResult.warningCount} warnings`
      : 'Validation: not run';
    const retrySummary = state.retryCount > 0
      ? `Self-corrections: ${state.retryCount}`
      : 'Self-corrections: none needed';

    steps.push(step('store', `Done. ${validationSummary}. ${retrySummary}. Confidence: ${state.overallConfidence}%`));

    // Fire-and-forget: record extraction learning for agent memory
    if (state.organizationId) {
      const docPattern = state.fileName.replace(/\.[^.]+$/, '').replace(/[0-9_-]+/g, '').trim() || 'general';
      recordExtractionLearning(
        state.organizationId,
        docPattern,
        state.fileType,
        extractionSource,
        state.overallConfidence,
      ).catch(() => {});
    }

    return {
      statementIds: result.statementIds,
      periodsStored: result.periodsStored,
      hasConflicts: result.hasConflicts,
      status: 'completed',
      steps,
    };
  } catch (err) {
    log.error('Store node: error persisting statements', err);
    captureAgentError(err, { agent: 'financialAgent', node: 'store' });
    return {
      status: 'failed',
      error: `Storage failed: ${err instanceof Error ? err.message : String(err)}`,
      steps: [...steps, step('store', 'Storage failed', String(err))],
    };
  }
}
