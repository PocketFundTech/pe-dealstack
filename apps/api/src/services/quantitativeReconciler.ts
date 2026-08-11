// ─── Quantitative Reconciler — Phase 1 entry point ────────────────
//
// Composes the four deterministic Phase-1 modules into a single audit
// payload per deal. Designed to run cheaply (pure TS over already-stored
// FinancialStatement rows, no LLM) so the user can re-run it any time
// they want to gut-check what the AI extraction produced vs what the
// raw line-item data actually says.
//
// Phase 1 covers: aggregated ground truth (annual sums, TTM, MRR,
// margins, valuation context), channel concentration + HHI, asking-price
// vs micro-SaaS comp bands, and the OpEx step-up detector — the four
// findings the user verified manually against the Website Speedy file.
//
// Phase 2 will add the LLM-augmented blocks (CIM-claim variance,
// cross-doc material findings, extraction-quality feedback). Those
// layer on top and consume Phase 1 output as their ground truth — so
// any bug in Phase 1 propagates, which is why this module ships first
// with the deterministic pieces only.

import type { UnitScale } from './financialClassifier.js';
import {
  computeGroundTruth,
} from './reconciler/groundTruth.js';
import { computeChannelConcentration } from './reconciler/channels.js';
import { computeValuationFraming } from './reconciler/valuation.js';
import { detectOpExStepUp } from './reconciler/opexStepUp.js';
import { validateCimClaims } from './reconciler/cimClaims.js';
import { synthesizeMaterialFindings } from './reconciler/materialFindingsLlm.js';
import {
  generateExtractionQualityFeedback,
  generateRecommendedActions,
} from './reconciler/extractionFeedback.js';
import { isAIEnabled } from '../openai.js';
import {
  type QuantitativeReconciliationPhase1,
  type QuantitativeReconciliationPhase2,
  type ReconcilerStatementInput,
  type ReconcilerContext,
  type MaterialFinding,
  type NarrativeDocumentInput,
  type DealRecordInput,
  type DocumentSet,
  type ExtractionQualityFeedback,
} from './reconciler/shared.js';
import { log } from '../utils/logger.js';

// ─── DB-row → reconciler input adapter ─────────────────────────────
//
// Kept here (not in shared.ts) so the shared types stay free of
// Supabase row assumptions. Callers fetch `FinancialStatement` rows
// however they want and feed the slim view to this function.

export interface FinancialStatementRow {
  id: string;
  documentId: string | null;
  statementType: string;
  period: string;
  periodType: string;
  unitScale: string;
  currency: string;
  lineItems: unknown;
  extractionConfidence: number | null;
  isActive: boolean;
}

export function rowsToReconcilerInput(
  rows: FinancialStatementRow[],
): ReconcilerStatementInput[] {
  return rows
    .filter((r) =>
      r.statementType === 'INCOME_STATEMENT' ||
      r.statementType === 'BALANCE_SHEET' ||
      r.statementType === 'CASH_FLOW',
    )
    .map((r) => ({
      id: r.id,
      documentId: r.documentId,
      statementType: r.statementType as 'INCOME_STATEMENT' | 'BALANCE_SHEET' | 'CASH_FLOW',
      period: r.period,
      periodType: (r.periodType === 'PROJECTED' || r.periodType === 'LTM'
        ? r.periodType
        : 'HISTORICAL') as 'HISTORICAL' | 'PROJECTED' | 'LTM',
      unitScale: (r.unitScale ?? 'ACTUALS') as UnitScale,
      currency: r.currency ?? 'USD',
      // lineItems is jsonb — Supabase returns parsed JSON. Coerce to the
      // expected shape; non-numeric values are dropped at the
      // getLineItemDollars layer.
      lineItems: (r.lineItems && typeof r.lineItems === 'object'
        ? (r.lineItems as Record<string, number | null>)
        : {}),
      extractionConfidence: r.extractionConfidence,
      isActive: r.isActive,
    }));
}

// ─── Phase 1 composition ───────────────────────────────────────────

export interface ReconcilerInput {
  statements: ReconcilerStatementInput[];
  ctx?: ReconcilerContext;
}

export function runQuantitativeReconciliationPhase1(
  input: ReconcilerInput,
): QuantitativeReconciliationPhase1 {
  const { statements, ctx } = input;
  const warnings: string[] = [];

  const computedGroundTruth = computeGroundTruth(statements, ctx);
  const channelConcentrationAnalysis = computeChannelConcentration(statements);

  // Valuation framing only runs when both an asking price and at least
  // one numerator are available. Otherwise the block is null and the
  // route caller can decide whether to surface "asking price not set"
  // as user-facing guidance.
  const askingPriceUsd = ctx?.askingPriceUsd ?? null;
  const valuationFraming =
    askingPriceUsd && askingPriceUsd > 0
      ? computeValuationFraming({
          askingPriceUsd,
          ttmGrossRevenueUsd: computedGroundTruth.TTM_revenue,
          ttmNetIncomeUsd: computedGroundTruth.TTM_netIncome,
          threeMoAnnualizedRevenueUsd: computedGroundTruth.impliedARR_3MoAvg,
        })
      : null;

  // Phase-1 material findings — currently just the OpEx step-up
  // detector. Phase 2 appends LLM-derived findings to this array.
  const materialFindings: MaterialFinding[] = [];
  const opexFinding = detectOpExStepUp(statements);
  if (opexFinding) materialFindings.push(opexFinding);

  // Surface input gaps so the UI can explain why a block is missing
  // instead of silently rendering empty.
  if (statements.length === 0) {
    warnings.push('No FinancialStatement rows found for this deal. Run extraction first.');
  } else if (computedGroundTruth.TTM_revenue == null) {
    warnings.push(
      'No monthly revenue data found — TTM, MRR, and 3-month-ARR figures are unavailable. ' +
      'Annual aggregates may still be present.',
    );
  }
  if (askingPriceUsd == null || askingPriceUsd <= 0) {
    warnings.push(
      'Deal asking price not set — valuation framing block omitted. ' +
      'Set Deal.dealSize on the deal record to enable.',
    );
  }
  if (channelConcentrationAnalysis == null) {
    warnings.push(
      'No channel-tagged revenue line items detected (e.g. revenue_stripe, revenue_wix). ' +
      'Channel concentration block omitted.',
    );
  }

  return {
    computedGroundTruth,
    channelConcentrationAnalysis,
    valuationFraming,
    materialFindings,
    warnings,
  };
}

// ─── Phase 2 composition (Phase 1 + LLM-augmented blocks) ─────────
//
// Layers four LLM modules on top of Phase 1's deterministic output:
//   - validateCimClaims       — extract narrative claims, compare vs ground truth
//   - synthesizeMaterialFindings — non-deterministic findings (concentration, etc.)
//   - generateExtractionQualityFeedback — meta-critique of the prior extraction
//   - generateRecommendedActions — prioritised diligence to-do list
//
// Modules that need narrative context get the trimmed extractedText of
// each non-financial-data Document. Calls run in parallel via Promise
// .all — each module is independent. Failures degrade gracefully:
// any module that errors returns its empty fallback and the rest still
// ship. `llmAugmented` reflects whether ANY Phase 2 block succeeded.

export interface ReconcilerPhase2Input extends ReconcilerInput {
  narrativeDocuments: NarrativeDocumentInput[];
  dealRecord: DealRecordInput;
  /** Latest period as ISO date for the documentSet block.
   * Caller computes (e.g. from the latest monthly statement) — we don't
   * re-derive here so the docSet date matches what the route promises. */
  asOfDateIso: string;
  /** dealId / orgId — passed straight to LLM modules for trace metadata. */
  dealId: string;
  orgId: string;
}

export async function runQuantitativeReconciliationPhase2(
  input: ReconcilerPhase2Input,
): Promise<QuantitativeReconciliationPhase2> {
  const phase1 = runQuantitativeReconciliationPhase1({
    statements: input.statements,
    ctx: input.ctx,
  });

  // documentSet — pure-TS metadata. Picks the largest FINANCIALS / EXCEL
  // doc as primary financial, the largest CIM / TEASER as primary
  // narrative. Both fall through to whatever's available if the
  // explicit types aren't tagged.
  const docSet = computeDocumentSet(input.narrativeDocuments, input.asOfDateIso);

  // Short-circuit when LLM unavailable — Phase 2 turns into Phase 1
  // with empty LLM blocks rather than throwing. UI shows a warning.
  if (!isAIEnabled()) {
    log.info('reconciler Phase 2: LLM unavailable, returning Phase 1 + empty Phase 2 blocks');
    return {
      ...phase1,
      documentSet: docSet,
      cimClaimValidation: [],
      recommendedNextActions: [],
      extractionQualityFeedback: emptyFeedback(),
      llmAugmented: false,
      warnings: [...phase1.warnings, 'LLM unavailable — Phase 2 blocks (CIM claims / material findings / extraction critique) skipped.'],
    };
  }

  // 1. CIM claim validation runs first — its output feeds both the
  //    extraction feedback and the recommended-actions modules so they
  //    can cite specific variances.
  const claimValidations = await validateCimClaims({
    narrativeDocuments: input.narrativeDocuments,
    groundTruth: phase1.computedGroundTruth,
    dealId: input.dealId,
    orgId: input.orgId,
  }).catch((err) => {
    log.warn('reconciler Phase 2: validateCimClaims failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  });

  // 2. Material findings + extraction feedback + recommended actions
  //    all consume Phase 1 + claim validations. Independent — run in parallel.
  const [materialFindingsLlm, extractionFeedback, recommendedActions] = await Promise.all([
    synthesizeMaterialFindings({
      groundTruth: phase1.computedGroundTruth,
      channelConcentration: phase1.channelConcentrationAnalysis,
      valuationFraming: phase1.valuationFraming,
      existingFindings: phase1.materialFindings,
      narrativeDocuments: input.narrativeDocuments,
      dealId: input.dealId,
      orgId: input.orgId,
    }).catch((err) => {
      log.warn('reconciler Phase 2: synthesizeMaterialFindings failed', { error: err instanceof Error ? err.message : String(err) });
      return [] as MaterialFinding[];
    }),
    generateExtractionQualityFeedback({
      dealRecord: input.dealRecord,
      groundTruth: phase1.computedGroundTruth,
      claimValidations,
      dealId: input.dealId,
      orgId: input.orgId,
    }).catch((err) => {
      log.warn('reconciler Phase 2: extractionFeedback failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }),
    // recommendedActions reads materialFindings — but the LLM call
    // needs to fire in parallel for latency, so we pass Phase-1
    // findings here. The Phase-2 LLM findings get appended after.
    generateRecommendedActions({
      groundTruth: phase1.computedGroundTruth,
      claimValidations,
      materialFindings: phase1.materialFindings,
      dealId: input.dealId,
      orgId: input.orgId,
    }).catch((err) => {
      log.warn('reconciler Phase 2: recommendedActions failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }),
  ]);

  // Merge Phase 1 + Phase 2 material findings. Phase 1's deterministic
  // detector goes first (its IDs are reserved — F-002 currently); LLM
  // findings get the remaining IDs.
  const combinedFindings = [...phase1.materialFindings, ...materialFindingsLlm];

  const llmAugmented =
    claimValidations.length > 0 ||
    materialFindingsLlm.length > 0 ||
    extractionFeedback != null ||
    recommendedActions.length > 0;

  return {
    ...phase1,
    materialFindings: combinedFindings,
    documentSet: docSet,
    cimClaimValidation: claimValidations,
    recommendedNextActions: recommendedActions,
    extractionQualityFeedback: extractionFeedback ?? emptyFeedback(),
    llmAugmented,
  };
}

function computeDocumentSet(
  docs: NarrativeDocumentInput[],
  asOfDateIso: string,
): DocumentSet {
  // Heuristic: docs typed as 'FINANCIALS' or 'EXCEL' are financial
  // sheets; everything else is narrative. When type is missing we fall
  // back to mimeType / filename suffix.
  const isFinancialDoc = (d: NarrativeDocumentInput): boolean => {
    const t = (d.type ?? '').toUpperCase();
    if (t === 'FINANCIALS' || t === 'EXCEL') return true;
    const m = (d.mimeType ?? '').toLowerCase();
    if (m.includes('spreadsheet') || m.includes('excel') || m.includes('csv')) return true;
    const n = d.name.toLowerCase();
    return n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv');
  };
  const isNarrativeDoc = (d: NarrativeDocumentInput): boolean => {
    const t = (d.type ?? '').toUpperCase();
    if (t === 'CIM' || t === 'TEASER' || t === 'LOI') return true;
    const m = (d.mimeType ?? '').toLowerCase();
    return m.includes('pdf') || m.includes('document') || m.includes('word');
  };

  const financial = docs.find(isFinancialDoc) ?? null;
  const narrative = docs.find(isNarrativeDoc) ?? null;

  return {
    primaryFinancialFile: financial?.name ?? null,
    primaryNarrativeFile: narrative?.name ?? null,
    asOfDate: asOfDateIso,
    extractionRunDate: new Date().toISOString().split('T')[0],
  };
}

function emptyFeedback(): ExtractionQualityFeedback {
  return {
    issuesWithPriorExtraction: [],
    rootCauseDiagnosis: '',
    promptingFixForPEOS: '',
  };
}

// ─── Re-exports for route callers ──────────────────────────────────

export type {
  QuantitativeReconciliationPhase1,
  QuantitativeReconciliationPhase2,
  ReconcilerStatementInput,
  ReconcilerContext,
  MaterialFinding,
  NarrativeDocumentInput,
  DealRecordInput,
} from './reconciler/shared.js';
