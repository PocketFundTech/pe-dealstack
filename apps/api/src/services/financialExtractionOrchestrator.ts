import { supabase } from '../supabase.js';
import { extractDealDataFromText, ExtractedDealData } from './aiExtractor.js';
import { classifyFinancials, ClassificationResult, ClassifiedStatement } from './financialClassifier.js';
import { dedupeStatementPeriods, mergeStatementsBySameType } from './financialPeriodNormalizer.js';
import { refreshDealCache } from './dealCacheWriteback.js';
import {
  compareSources, periodKeyOf, resolveSourceKind, selectSourceStatements, type SourceCandidate,
} from './financialSourceSelection.js';
import {
  canonicalPeriodColumns, candidateFromRow, deactivateRows, upsertStatementRow, type ActiveRow,
} from './financialStatementStore.js';
import { log } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────

export interface OrchestrationInput {
  text: string;
  dealId: string;
  documentId?: string;
  /** Pre-computed classification from vision extraction — skips classifyFinancials() when provided */
  classification?: ClassificationResult;
  /** Source label written to DB rows ('gpt4o' | 'gpt4o-vision') */
  extractionSource?: string;
}

export interface FastPassResult {
  companyName: string | null;
  revenue: number | null;
  ebitda: number | null;
  ebitdaMargin: number | null;
  revenueGrowth: number | null;
  overallConfidence: number;
  needsReview: boolean;
  rawData: ExtractedDealData;
}

export interface DeepPassResult {
  statementsStored: number;
  periodsStored: number;
  overallConfidence: number;
  statementIds: string[];
  warnings: string[];
  hasConflicts: boolean;
}

export interface OrchestrationResult {
  fastPass: FastPassResult | null;
  deepPass: DeepPassResult | null;
  errors: string[];
}

// ─── Fast Pass ────────────────────────────────────────────────

/**
 * Fast pass: uses existing aiExtractor to pull top-line metrics
 * (revenue, EBITDA, margins for the most recent period).
 * Returns in < 10s — shown to user immediately.
 */
export async function runFastPass(text: string): Promise<FastPassResult | null> {
  const extracted = await extractDealDataFromText(text);
  if (!extracted) return null;

  return {
    companyName: extracted.companyName.value,
    revenue: extracted.revenue.value,
    ebitda: extracted.ebitda.value,
    ebitdaMargin: extracted.ebitdaMargin.value,
    revenueGrowth: extracted.revenueGrowth.value,
    overallConfidence: extracted.overallConfidence,
    needsReview: extracted.needsReview,
    rawData: extracted,
  };
}

// ─── Deep Pass ────────────────────────────────────────────────

/**
 * Deep pass: full 3-statement extraction via AI classifier.
 * Upserts one FinancialStatement row per (dealId, statementType, period).
 * Designed so the extraction layer can be swapped for Azure later —
 * only this function and classifyFinancials() need to change.
 */
// Per-deal write lock. The cross-document conflict check (read the active
// row, then upsert) is not atomic, so two documents of the same deal
// finishing together could both see "no active row" and both go active —
// or the outcome depended on which finished first. "Extract all" runs its
// documents inside one function instance, so serialising runDeepPass per
// deal in-process closes that race without a migration. (Cross-instance
// writers — a data-room upload racing an Extract-all — would need a DB
// advisory lock; see FINANCIALS-FIX-PLAN B3.)
const dealWriteLocks = new Map<string, Promise<unknown>>();

export async function withDealWriteLock<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const previous = dealWriteLocks.get(dealId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  dealWriteLocks.set(dealId, tail);
  try {
    return await run;
  } finally {
    if (dealWriteLocks.get(dealId) === tail) dealWriteLocks.delete(dealId);
  }
}

export async function runDeepPass(input: OrchestrationInput): Promise<DeepPassResult | null> {
  // Classify (an LLM call when no classification is passed) OUTSIDE the
  // lock — only the DB merge needs serialising.
  const classification = input.classification ?? await classifyFinancials(input.text);
  return withDealWriteLock(input.dealId, () => runDeepPassUnlocked(input, classification));
}

async function runDeepPassUnlocked(
  input: OrchestrationInput,
  // Pre-computed (vision path) or text-classified by runDeepPass above.
  classification: Awaited<ReturnType<typeof classifyFinancials>> | NonNullable<OrchestrationInput['classification']> | null,
): Promise<DeepPassResult | null> {
  const source = input.extractionSource ?? 'gpt4o';

  if (!classification || classification.statements.length === 0) {
    log.warn('Deep pass: no financial statements found', { dealId: input.dealId });
    return {
      statementsStored: 0,
      periodsStored: 0,
      overallConfidence: 0,
      statementIds: [],
      warnings: classification?.warnings ?? ['No financial data found in document'],
      hasConflicts: false,
    };
  }

  // Document metadata for the deal — used to tell reported statements from
  // derived models and to rank sources across documents (fix plan B1).
  const { data: dealDocs } = await supabase
    .from('Document')
    .select('id, type, mimeType, name')
    .eq('dealId', input.dealId);
  const docMetaById = new Map<string, { type?: string | null; mimeType?: string | null; name?: string | null }>(
    (dealDocs ?? []).map((d) => [d.id as string, d as { type?: string | null; mimeType?: string | null; name?: string | null }]),
  );
  const incomingDoc = input.documentId ? docMetaById.get(input.documentId) : undefined;

  // One document can hold the same statement twice — the reported tab and a
  // valuation tab. Keep the reported one; merging would union the model's
  // lines into the real statement.
  const selected = selectSourceStatements(classification.statements, incomingDoc?.name);
  if (selected.dropped.length > 0) {
    log.info('Deep pass: dropped model-derived statements in favour of reported ones', {
      dealId: input.dealId, documentId: input.documentId, dropped: selected.dropped,
    });
  }

  // Statement merge pass: collapse multiple statements of the same type into
  // one. The classifier sometimes returns separate ClassifiedStatement
  // entries for each source section (e.g. four BALANCE_SHEET objects: one
  // for working capital, one for AR/AP, one for fixed assets, one for
  // deferred revenue). Each section may carry an overlapping period label
  // (e.g. all four describe "2026-03-31"). Without this merge the upsert
  // loop below — keyed on (dealId, statementType, period, documentId) —
  // collapses N sections into a single DB row, with each iteration's
  // `lineItems` overwriting the previous one's. The bug reported as
  // "Stored 5 periods but only 2 distinct UUIDs" in LangSmith.
  //
  // mergeStatementsBySameType uses the existing per-period merge logic so
  // overlapping line-item KEYS are unioned (higher-confidence value wins
  // per key, missing keys filled from the loser).
  classification.statements = mergeStatementsBySameType(selected.statements);

  // Period dedup pass: collapse equivalent labels ("FY26 Est." vs "FY26 Est",
  // "YTD 2026" vs "2026 YTD" vs "YTD Total") before upsert so the time
  // series doesn't end up with 6 rows for what should be 2 distinct periods.
  // Runs in-place per statement, scoped to (statementType, periodType).
  // Note: mergeStatementsBySameType already calls dedupeStatementPeriods
  // for any same-type group, so this loop is a no-op for those statements.
  // We keep it for the single-statement-per-type case (still need to dedup
  // intra-statement label variants like "FY26 Est." vs "FY26 Est").
  const totalBefore = classification.statements.reduce((n, s) => n + s.periods.length, 0);
  for (const stmt of classification.statements) {
    stmt.periods = dedupeStatementPeriods(stmt.statementType, stmt.periods);
  }
  const totalAfter = classification.statements.reduce((n, s) => n + s.periods.length, 0);
  if (totalAfter < totalBefore) {
    log.info(
      `Period dedup: ${totalBefore} input → ${totalAfter} output (dropped ${totalBefore - totalAfter} duplicates)`,
      { dealId: input.dealId },
    );
  }

  // Diagnostic: log every (statement, period) the classifier produced after
  // dedup. Lets us tell apart "LLM only emitted 3 periods" (max_tokens
  // truncation) from "LLM emitted 12 but storage dropped 9" (upsert race
  // condition with isActive multi-row).
  log.info('Deep pass: post-dedup periods', {
    dealId: input.dealId,
    documentId: input.documentId,
    byStatement: classification.statements.map(s => ({
      type: s.statementType,
      count: s.periods.length,
      periods: s.periods.map(p => p.period),
    })),
  });

  const statementIds: string[] = [];
  // Parallel array tracking which (statementType, period) input each entry
  // in statementIds came from. Used by the post-loop collision detector to
  // name the colliding labels even when some upserts failed (and therefore
  // skipped pushing into statementIds). Push order matches statementIds.
  const idLabels: string[] = [];
  let periodsStored = 0;
  let hasConflicts = false;
  const now = new Date().toISOString();

  for (const stmt of classification.statements) {
    const incomingKind = resolveSourceKind(stmt.sourceKind, stmt.sheetName, incomingDoc?.name);

    // Every active row of this statement type, matched by CANONICAL period
    // (fix plan A4) — "FY2024 (Jan - Dec 2024)" from the P&L and "2024" from
    // a valuation file are the same year. Exact-label matching let both stay
    // active with no conflict raised. One read per statement, not per period.
    const { data: activeRows } = await supabase
      .from('FinancialStatement')
      .select('*')
      .eq('dealId', input.dealId)
      .eq('statementType', stmt.statementType)
      .eq('isActive', true);
    // Kept current through the loop: rows written earlier in THIS run are
    // compared too, so two labels for one period from the same document
    // can't both end up active (dedup should already have merged them —
    // this is the backstop).
    let active = (activeRows ?? []) as ActiveRow[];

    for (const periodData of stmt.periods) {
      try {
        const periodKey = periodKeyOf(periodData.period);
        const matching = active.filter(
          (r) => (r.periodKey ?? periodKeyOf(r.period)) === periodKey,
        );
        const incomingDocId = input.documentId ?? null;
        const others = matching.filter((r) => r.documentId !== incomingDocId);
        // Same document, old label for the same period (re-extract renamed it).
        const staleSameDoc = matching.filter((r) => r.documentId === incomingDocId && r.period !== periodData.period);

        let isActive = true;
        let mergeStatus: 'auto' | 'needs_review' = 'auto';
        if (others.length > 0) {
          // CONFLICT with another document. Decide by source kind, then
          // document authority, then completeness (financialSourceSelection.ts)
          // — never by which document wrote first.
          const incoming: SourceCandidate = {
            sourceKind: incomingKind, doc: incomingDoc, statementType: stmt.statementType, lineItems: periodData.lineItems,
            period: periodData.period,
          };
          const best = others
            .map((r) => ({ row: r, cand: candidateFromRow(r, stmt.statementType, docMetaById) }))
            .sort((x, y) => compareSources(y.cand, x.cand))[0];
          const cmp = compareSources(incoming, best.cand);
          const incomingWins = cmp > 0;
          const tie = cmp === 0;
          isActive = incomingWins;
          mergeStatus = tie ? 'needs_review' : 'auto';
          hasConflicts = true;

          log.info('Deep pass: conflict detected', {
            dealId: input.dealId, statementType: stmt.statementType,
            period: periodData.period, periodKey, existingDocId: best.row.documentId,
            newDocId: input.documentId, incomingKind, existingKind: best.cand.sourceKind,
            resolution: incomingWins ? 'incoming_wins' : tie ? 'tie_needs_review' : 'existing_wins',
          });

          if (incomingWins) {
            // Deactivate every active row for this period first (respects the
            // one-active-per-period partial unique indexes), then the upsert
            // below installs the incoming row as active.
            const ids = [...others, ...staleSameDoc].map((r) => r.id);
            await deactivateRows(ids);
            active = active.filter((r) => !ids.includes(r.id));
          } else {
            // Existing source stays active. Flag for review only on a true tie.
            await supabase
              .from('FinancialStatement')
              .update({ mergeStatus })
              .eq('id', best.row.id);
          }
        } else if (staleSameDoc.length > 0) {
          const ids = staleSameDoc.map((r) => r.id);
          await deactivateRows(ids);
          active = active.filter((r) => !ids.includes(r.id));
        }

        // Upsert (not insert) so a re-extraction of the same document updates
        // its own prior row instead of violating the (deal,type,period,doc)
        // unique constraint.
        const { data, error } = await upsertStatementRow({
          dealId: input.dealId,
          documentId: incomingDocId,
          statementType: stmt.statementType,
          period: periodData.period,
          periodType: periodData.periodType,
          lineItems: periodData.lineItems,
          currency: stmt.currency,
          unitScale: stmt.unitScale,
          extractionConfidence: periodData.confidence,
          extractionSource: source,
          extractedAt: now,
          isActive,
          mergeStatus,
        }, {
          ...canonicalPeriodColumns(periodData.period),
          sourceKind: incomingKind,
          sheetName: stmt.sheetName ?? null,
        });

        if (error) {
          log.error('Deep pass: failed to upsert period', {
            dealId: input.dealId, statementType: stmt.statementType,
            period: periodData.period, error,
          });
          continue;
        }
        if (data?.id) {
          statementIds.push(data.id);
          idLabels.push(`${stmt.statementType}:${periodData.period}`);
          if (isActive && !active.some((r) => r.id === data.id)) {
            active.push({
              ...(data as Partial<ActiveRow>), id: data.id, documentId: incomingDocId,
              period: periodData.period, periodKey, lineItems: periodData.lineItems, sourceKind: incomingKind,
            } as ActiveRow);
          }
        }
        periodsStored++;
      } catch (err) {
        log.error('Deep pass: unexpected error upserting period', {
          dealId: input.dealId, statementType: stmt.statementType,
          period: periodData.period, error: err,
        });
      }
    }
  }

  // Defensive: if any UUID appears more than once in `statementIds`, that
  // means two distinct (statementType, period) inputs upserted to the same
  // DB row. Even with mergeStatementsBySameType in place, surfacing this
  // here protects us from future regressions (e.g. a new bucket in the
  // dedup keying that lets two `FinancialPeriod` entries with the SAME
  // normalised label survive into the upsert loop). Log a WARNING so it
  // shows up in LangSmith — the previous failure mode (silent overwrite)
  // had no log line at all.
  const idCounts = new Map<string, number>();
  for (const id of statementIds) {
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const dupes = Array.from(idCounts.entries()).filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    const labelsByDupeId = new Map<string, string[]>();
    for (let i = 0; i < statementIds.length; i++) {
      const id = statementIds[i];
      if ((idCounts.get(id) ?? 0) <= 1) continue;
      const arr = labelsByDupeId.get(id) ?? [];
      arr.push(idLabels[i] ?? '<unknown>');
      labelsByDupeId.set(id, arr);
    }
    for (const [id, count] of dupes) {
      log.warn(
        `Deep pass: statementId collision — ${count} period inputs upserted to the same DB row`,
        {
          dealId: input.dealId,
          documentId: input.documentId,
          statementId: id,
          collidingPeriods: labelsByDupeId.get(id) ?? [],
          hint: 'Sibling statements of the same statementType should have been merged by mergeStatementsBySameType — investigate dedup keying.',
        },
      );
    }
  }

  // Phase 2 cache writeback: refresh Deal.cached* from the latest active
  // income-statement row. Lives in dealCacheWriteback.ts (see header
  // comment for why). Best-effort — if this fails we still want the
  // extraction we just did to be visible via the bulk summaries
  // endpoint, so we never let it bubble up. Skips when no periods were
  // stored (would just be a no-op write of all-nulls, and we'd rather
  // leave any earlier successful cache values intact in that case).
  if (periodsStored > 0) {
    await refreshDealCache(input.dealId, now);
  }

  log.info('Deep pass completed', {
    dealId: input.dealId,
    statementsFound: classification.statements.length,
    periodsStored,
    hasConflicts,
    overallConfidence: classification.overallConfidence,
    distinctStatementIds: idCounts.size,
    collisionCount: dupes.length,
  });

  return {
    statementsStored: classification.statements.length,
    periodsStored,
    overallConfidence: classification.overallConfidence,
    statementIds,
    warnings: classification.warnings,
    hasConflicts,
  };
}

// ─── Combined Orchestrator ────────────────────────────────────

/**
 * Run both fast and deep pass.
 * In practice the API routes call these separately so the user sees
 * top-line data immediately, then deep data when ready.
 * This combined function is useful for re-extraction and testing.
 */
export async function runFullExtraction(
  input: OrchestrationInput,
): Promise<OrchestrationResult> {
  const errors: string[] = [];

  const [fastPass, deepPass] = await Promise.allSettled([
    runFastPass(input.text),
    runDeepPass(input),
  ]);

  return {
    fastPass: fastPass.status === 'fulfilled' ? fastPass.value : (errors.push('Fast pass failed'), null),
    deepPass: deepPass.status === 'fulfilled' ? deepPass.value : (errors.push('Deep pass failed'), null),
    errors,
  };
}
