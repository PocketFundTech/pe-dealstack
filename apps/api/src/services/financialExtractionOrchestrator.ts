import { supabase } from '../supabase.js';
import { extractDealDataFromText, ExtractedDealData } from './aiExtractor.js';
import { classifyFinancials, ClassificationResult, ClassifiedStatement } from './financialClassifier.js';
import { dedupeStatementPeriods, mergeStatementsBySameType } from './financialPeriodNormalizer.js';
import { refreshDealCache } from './dealCacheWriteback.js';
import { financialSourceAuthorityRank } from './financialSourceAuthority.js';
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
export async function runDeepPass(input: OrchestrationInput): Promise<DeepPassResult | null> {
  // Use pre-computed classification (vision path) or run text classifier
  const classification = input.classification ?? await classifyFinancials(input.text);
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
  classification.statements = mergeStatementsBySameType(classification.statements);

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

  // Source-authority map for cross-document conflict resolution. A dedicated
  // financials spreadsheet outranks a CIM/teaser narrative, so the P&L wins the
  // active slot for a period even when the CIM extracted first or scored higher
  // confidence. Fetched once for the deal; missing docs rank lowest.
  const { data: dealDocs } = await supabase
    .from('Document')
    .select('id, type, mimeType, name')
    .eq('dealId', input.dealId);
  const docMetaById = new Map<string, { type?: string | null; mimeType?: string | null; name?: string | null }>(
    (dealDocs ?? []).map((d) => [d.id as string, d as { type?: string | null; mimeType?: string | null; name?: string | null }]),
  );
  const rankOf = (documentId: string | null | undefined): number =>
    financialSourceAuthorityRank(documentId ? docMetaById.get(documentId) : undefined);

  for (const stmt of classification.statements) {
    for (const periodData of stmt.periods) {
      try {
        // Check for existing active row(s) from a DIFFERENT document.
        // Use limit(1) + array fetch instead of .maybeSingle() — if a
        // previous race condition left multiple active rows for the same
        // (deal, type, period), .maybeSingle() throws "JSON object
        // requested, multiple (or no) rows returned" which the catch
        // block silently swallows, dropping the entire period from the
        // re-extraction. This was the bug that caused only 3 of 12
        // months to survive a multi-doc re-extract.
        const { data: existingRows } = await supabase
          .from('FinancialStatement')
          .select('id, documentId, isActive')
          .eq('dealId', input.dealId)
          .eq('statementType', stmt.statementType)
          .eq('period', periodData.period)
          .eq('isActive', true)
          .limit(1);
        const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;

        const isConflict = existing && existing.documentId !== (input.documentId ?? null);

        if (isConflict) {
          // CONFLICT: a different document already has an active row for this
          // period. Resolve by SOURCE AUTHORITY, not first-writer or
          // confidence: a P&L spreadsheet (rank 3) beats a CIM/teaser narrative
          // (rank 2). Only a genuine tie (equal-rank sources) stays needs_review.
          const incomingRank = rankOf(input.documentId ?? null);
          const existingRank = rankOf(existing.documentId);
          const incomingWins = incomingRank > existingRank;
          const tie = incomingRank === existingRank;

          log.info('Deep pass: conflict detected', {
            dealId: input.dealId, statementType: stmt.statementType,
            period: periodData.period, existingDocId: existing.documentId,
            newDocId: input.documentId, incomingRank, existingRank,
            resolution: incomingWins ? 'incoming_wins_by_authority' : tie ? 'tie_needs_review' : 'existing_wins_by_authority',
          });

          if (incomingWins) {
            // Deactivate EVERY currently-active row for this period first (to
            // respect the one-active-per-period partial unique index), then the
            // upsert below installs the higher-authority incoming row as active.
            await supabase
              .from('FinancialStatement')
              .update({ isActive: false, mergeStatus: 'auto' })
              .eq('dealId', input.dealId)
              .eq('statementType', stmt.statementType)
              .eq('period', periodData.period)
              .eq('isActive', true);
          } else {
            // Existing source outranks or ties the incoming one → keep it
            // active. Flag for user review only on a true tie; a strictly
            // weaker incoming source is auto-resolved (no review needed).
            await supabase
              .from('FinancialStatement')
              .update({ mergeStatus: tie ? 'needs_review' : 'auto' })
              .eq('id', existing.id);
          }

          // Upsert (not insert) so a re-extraction of the incoming doc updates
          // its own prior row instead of violating the (deal,type,period,doc)
          // unique constraint.
          const { data, error } = await supabase
            .from('FinancialStatement')
            .upsert(
              {
                dealId: input.dealId,
                documentId: input.documentId ?? null,
                statementType: stmt.statementType,
                period: periodData.period,
                periodType: periodData.periodType,
                lineItems: periodData.lineItems,
                currency: stmt.currency,
                unitScale: stmt.unitScale,
                extractionConfidence: periodData.confidence,
                extractionSource: source,
                extractedAt: now,
                isActive: incomingWins,
                mergeStatus: incomingWins ? 'auto' : tie ? 'needs_review' : 'auto',
              },
              { onConflict: 'dealId,statementType,period,documentId' },
            )
            .select('id')
            .single();

          if (error) {
            log.error('Deep pass: conflict upsert failed', {
              dealId: input.dealId, statementType: stmt.statementType,
              period: periodData.period, error,
            });
            continue;
          }
          if (data?.id) {
            statementIds.push(data.id);
            idLabels.push(`${stmt.statementType}:${periodData.period}`);
          }
          periodsStored++;
          hasConflicts = true;
        } else {
          // NO CONFLICT: same doc re-extraction or first extraction for this period
          const { data, error } = await supabase
            .from('FinancialStatement')
            .upsert(
              {
                dealId: input.dealId,
                documentId: input.documentId ?? null,
                statementType: stmt.statementType,
                period: periodData.period,
                periodType: periodData.periodType,
                lineItems: periodData.lineItems,
                currency: stmt.currency,
                unitScale: stmt.unitScale,
                extractionConfidence: periodData.confidence,
                extractionSource: source,
                extractedAt: now,
                isActive: true,
                mergeStatus: 'auto',
              },
              { onConflict: 'dealId,statementType,period,documentId' },
            )
            .select('id')
            .single();

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
          }
          periodsStored++;
        }
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
