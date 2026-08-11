// ─── CIM Claim Validation — Quantitative Reconciler (Phase 2) ──────
//
// Two-step LLM-augmented audit of narrative claims (CIM, teaser, IM)
// against the Phase-1 ComputedGroundTruth aggregate produced from the
// underlying FinancialStatement rows.
//
//   Step 1 — extract claims (ONE LLM call, all docs batched)
//     * The model receives up to ~20K chars per doc (capped to keep the
//       input under ~10K tokens), labelled by doc.name. It returns a
//       JSON list of structured numeric claims (revenue, ARR, MRR,
//       margins, growth, customer count, asking price, prior offers,
//       hold period, launch date, etc.) with the verbatim phrase, the
//       source doc, a normalised numeric value, and (when stated as a
//       range) low/high bounds.
//
//   Step 2 — variance comparator (deterministic, NO further LLM calls)
//     * Each extracted claim is matched to a ground-truth field by
//       claimType. The variance is computed as
//           variance_pct = (computed - claim) / claim * 100
//       so a positive sign means the spreadsheet number is HIGHER than
//       the narrative claim (i.e. the CIM understates reality).
//     * Range claims with computed inside the band are VERIFIED, with
//       LOWER_END / UPPER_END qualifiers when computed lands in the
//       bottom or top 20% of the stated range.
//     * Point claims use ±5% (VERIFIED), ±15% (MINOR_DISCREPANCY), or
//       MATERIAL with a buyer-impact qualifier when the metric is
//       favorable-to-seller (revenue/ARR/MRR/margin).
//     * Implication strings are deterministic templates referencing the
//       formatted claim and computed values — no per-claim LLM calls.
//
// Returns [] (NEVER throws) when:
//   - LLM client is not configured (no API key)
//   - No narrative documents are provided
//   - The single LLM call fails for any reason
//
// One LLM call per validateCimClaims() invocation. Latency target: <10s.

import { isAIEnabled, trackedChatCompletion } from '../../openai.js';
import { MODEL_INSIGHTS } from '../../utils/aiModels.js';
import { log } from '../../utils/logger.js';
import type {
  CimClaimValidation,
  ClaimVerdict,
  ComputedGroundTruth,
  NarrativeDocumentInput,
} from './shared.js';

// ─── Tunables ──────────────────────────────────────────────────────

/** Per-doc text slice — keeps input under ~10K tokens per doc. */
const DOC_TEXT_CHAR_CAP = 20_000;

/** Hard ceiling on docs sent in one batched extraction call. Beyond
 * this we keep the largest-text docs and warn on the rest — keeps the
 * single LLM call well inside its context budget regardless of how
 * many narrative docs the deal has accumulated. */
const MAX_DOCS_PER_CALL = 5;

/** Verdict thresholds (point claims). */
const VERIFIED_PCT = 5;
const MINOR_PCT = 15;

/** Range "edge" qualifier: bottom/top 20% of the stated range. */
const RANGE_EDGE_FRAC = 0.20;

// ─── Claim type registry ───────────────────────────────────────────

const FAVORABLE_TO_SELLER = new Set([
  'revenue',
  'arr',
  'mrr',
  'margin',
]);

type ClaimType =
  | 'revenue'
  | 'arr'
  | 'mrr'
  | 'margin'
  | 'growth_rate'
  | 'subscriber_count'
  | 'asking_price'
  | 'prior_offer'
  | 'launch_date'
  | 'other';

const CLAIM_TYPES: readonly ClaimType[] = [
  'revenue',
  'arr',
  'mrr',
  'margin',
  'growth_rate',
  'subscriber_count',
  'asking_price',
  'prior_offer',
  'launch_date',
  'other',
] as const;

// ─── LLM extraction shape ──────────────────────────────────────────

interface ExtractedClaim {
  claim: string;
  claimSource: string;
  claimType: ClaimType;
  claimValue: number | null;
  claimRangeLow: number | null;
  claimRangeHigh: number | null;
}

// ─── System prompt (verbatim — referenced in the report) ──────────

const SYSTEM_PROMPT = `You are a PE analyst extracting QUANTITATIVE CLAIMS from a CIM/teaser. For each numeric claim (revenue, ARR, MRR, margin %, growth %, customer count, valuation, asking price, prior offers, hold period, etc.), emit one entry with:
- claim: the verbatim phrase from the document (keep punctuation/units as written)
- claimSource: the document name as labelled in the user prompt
- claimType: one of 'revenue' | 'arr' | 'mrr' | 'margin' | 'growth_rate' | 'subscriber_count' | 'asking_price' | 'prior_offer' | 'launch_date' | 'other'
- claimValue: numeric, NORMALISED to actuals where the unit is implied. Convert "$350K" -> 350000, "$1.2M" -> 1200000, "75% margin" -> 0.75, "20% YoY growth" -> 0.20. Use null when the claim is a range (use claimRangeLow/High instead).
- claimRangeLow / claimRangeHigh: when stated as a range (e.g. "70-80% gross margin", "$300K-$400K ARR"), populate both bounds in the same normalised units. Otherwise null.

Rules:
1. DO NOT extract qualitative claims ("strong growth", "best-in-class", "category leader"). Numbers only.
2. DO NOT emit duplicate claims (same metric + same value from the same source).
3. If the same metric appears in multiple docs, emit one claim per source doc.
4. Limit to ~20 most material claims per document (focus on revenue / ARR / MRR / margin / growth / customer count / valuation — skip immaterial parenthetical numbers).
5. For percentages always emit as a fraction (75% -> 0.75, NOT 75).
6. Return ONLY valid JSON in the exact shape: {"claims": [ ... ]}. No prose, no markdown fences.`;

// ─── Public entry point ────────────────────────────────────────────

export async function validateCimClaims(input: {
  narrativeDocuments: NarrativeDocumentInput[];
  groundTruth: ComputedGroundTruth;
  dealId: string;
  orgId: string;
}): Promise<CimClaimValidation[]> {
  const { narrativeDocuments, groundTruth, dealId, orgId } = input;

  if (!narrativeDocuments || narrativeDocuments.length === 0) return [];
  if (!isAIEnabled()) {
    log.warn('cimClaims: LLM unavailable, skipping claim validation', {
      dealId,
    });
    return [];
  }

  // ─── Doc selection ──────────────────────────────────────────────
  // Pick the most-text-rich docs when we have more than MAX_DOCS_PER_CALL.
  // "Largest" is a reasonable proxy for "most-likely-to-be-the-CIM" when
  // we don't have a richer signal — small one-pagers tend to be teasers.
  let docsToSend = narrativeDocuments;
  if (narrativeDocuments.length > MAX_DOCS_PER_CALL) {
    docsToSend = narrativeDocuments
      .slice()
      .sort(
        (a, b) =>
          (b.extractedText?.length ?? 0) - (a.extractedText?.length ?? 0),
      )
      .slice(0, MAX_DOCS_PER_CALL);
    log.warn(
      `cimClaims: ${narrativeDocuments.length} narrative docs provided, ` +
        `batching only the largest ${MAX_DOCS_PER_CALL} into a single LLM call`,
      {
        dealId,
        skippedCount: narrativeDocuments.length - MAX_DOCS_PER_CALL,
      },
    );
  }

  // ─── Step 1: extract claims via LLM ─────────────────────────────
  let claims: ExtractedClaim[];
  try {
    claims = await extractClaims(docsToSend, dealId, orgId);
  } catch (err) {
    log.error('cimClaims: claim extraction failed', err, { dealId });
    return [];
  }

  if (claims.length === 0) return [];

  // ─── Step 2: deterministic variance comparator ──────────────────
  const validations: CimClaimValidation[] = [];
  for (const c of claims) {
    validations.push(buildValidation(c, groundTruth));
  }

  return validations;
}

// ─── Step 1 implementation ─────────────────────────────────────────

async function extractClaims(
  docs: NarrativeDocumentInput[],
  dealId: string,
  orgId: string,
): Promise<ExtractedClaim[]> {
  const userPrompt = buildUserPrompt(docs);

  const response = await trackedChatCompletion(
    'cim_claim_extraction',
    {
      model: MODEL_INSIGHTS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 3000,
    },
    undefined,
    {
      tags: ['reconciler', 'cim_claim_extraction'],
      traceMeta: {
        dealId,
        orgId,
        docCount: docs.length,
      },
    },
  );

  const content = response?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    log.warn('cimClaims: empty LLM response', { dealId });
    return [];
  }

  return parseClaimsJson(content);
}

function buildUserPrompt(docs: NarrativeDocumentInput[]): string {
  const sections = docs.map((d) => {
    const text = (d.extractedText ?? '').slice(0, DOC_TEXT_CHAR_CAP);
    const truncatedNote =
      (d.extractedText?.length ?? 0) > DOC_TEXT_CHAR_CAP
        ? `\n\n[...truncated at ${DOC_TEXT_CHAR_CAP} chars]`
        : '';
    // Document type tag helps the model bias toward the right metric
    // categories (CIM -> exhaustive; TEASER -> headline numbers only).
    const typeTag = d.type ? ` (${d.type})` : '';
    return `===== DOCUMENT: ${d.name}${typeTag} =====\n${text}${truncatedNote}`;
  });

  return (
    `Extract all material quantitative claims from the following ${docs.length} document(s). ` +
    `Use the document filename (the value after "DOCUMENT:") as claimSource for every claim from that section.\n\n` +
    sections.join('\n\n')
  );
}

/** Defensive parser — accepts a JSON object with a `claims` array,
 * filters out malformed entries, and clamps claimType to the known
 * union. Returns [] on any structural failure. */
function parseClaimsJson(raw: string): ExtractedClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('cimClaims: failed to parse LLM JSON', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(arr)) return [];

  const out: ExtractedClaim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
    const claimSource =
      typeof o.claimSource === 'string' ? o.claimSource.trim() : '';
    const rawType = typeof o.claimType === 'string' ? o.claimType.toLowerCase() : '';
    const claimType = (CLAIM_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ClaimType)
      : 'other';
    const claimValue = toFiniteOrNull(o.claimValue);
    const claimRangeLow = toFiniteOrNull(o.claimRangeLow);
    const claimRangeHigh = toFiniteOrNull(o.claimRangeHigh);

    if (!claim || !claimSource) continue;
    // Need at least a point value or both range bounds to be useful.
    const hasRange = claimRangeLow != null && claimRangeHigh != null;
    if (claimValue == null && !hasRange) {
      // Still record the claim so the audit shows the LLM saw it; it
      // simply won't be matchable -> verdict UNVERIFIABLE_FROM_FINANCIALS.
      out.push({
        claim,
        claimSource,
        claimType,
        claimValue: null,
        claimRangeLow: null,
        claimRangeHigh: null,
      });
      continue;
    }

    out.push({
      claim,
      claimSource,
      claimType,
      claimValue,
      claimRangeLow,
      claimRangeHigh,
    });
  }
  return out;
}

function toFiniteOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,_$%\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ─── Step 2: deterministic comparator ──────────────────────────────

interface MatchResult {
  computedValue: number | null;
  computedSource: string;
  /** True when the metric simply isn't derivable from the financials. */
  unverifiable: boolean;
  /** Reason string used in the UNVERIFIABLE implication. */
  unverifiableReason?: string;
}

function buildValidation(
  c: ExtractedClaim,
  gt: ComputedGroundTruth,
): CimClaimValidation {
  // 1) Match the claim to a ground-truth field.
  const match = matchClaimToGroundTruth(c, gt);

  // For ARR/revenue/MRR/margin, claim values are in the same units as
  // the computed value (we either both use $ or both use a fraction —
  // the LLM is instructed to return percentages as fractions).
  // Margin claims are compared as fractions, NOT percent-of-100, since
  // groundTruth.TTM_netMargin is already a fraction (e.g. 0.475).

  // 2) Unverifiable case — emit early with stock implication.
  if (match.unverifiable || match.computedValue == null) {
    return {
      claim: c.claim,
      claimSource: c.claimSource,
      computedValue: null,
      computedSource: match.computedSource,
      variance_pct: null,
      verdict: 'UNVERIFIABLE_FROM_FINANCIALS',
      implication:
        match.unverifiableReason ??
        unverifiableImplication(c.claimType),
    };
  }

  const computed = match.computedValue;
  const isMargin = c.claimType === 'margin';

  // 3) Range-claim path — VERIFIED with edge qualifier when inside.
  if (c.claimRangeLow != null && c.claimRangeHigh != null) {
    const low = Math.min(c.claimRangeLow, c.claimRangeHigh);
    const high = Math.max(c.claimRangeLow, c.claimRangeHigh);
    const span = high - low;

    if (computed >= low && computed <= high) {
      // Inside the range. Decide LOWER / UPPER / middle.
      let verdict: ClaimVerdict;
      let implication: string;
      const formattedComputed = formatValue(computed, isMargin);

      if (span > 0 && computed - low <= span * RANGE_EDGE_FRAC) {
        verdict = 'VERIFIED_LOWER_END';
        implication =
          `${metricName(c.claimType)} is at the bottom of the stated range ` +
          `(${formattedComputed} computed vs claimed ` +
          `${formatValue(low, isMargin)}-${formatValue(high, isMargin)}), ` +
          `not the middle or top. Use the lower end when modelling.`;
      } else if (span > 0 && high - computed <= span * RANGE_EDGE_FRAC) {
        verdict = 'VERIFIED_UPPER_END';
        implication =
          `${metricName(c.claimType)} is at the top of the stated range ` +
          `(${formattedComputed} computed vs claimed ` +
          `${formatValue(low, isMargin)}-${formatValue(high, isMargin)}). ` +
          `Verify the trajectory before assuming the upper end persists.`;
      } else {
        verdict = 'VERIFIED';
        implication =
          `${metricName(c.claimType)} of ${formattedComputed} sits inside the ` +
          `stated range ${formatValue(low, isMargin)}-` +
          `${formatValue(high, isMargin)}. Claim verified.`;
      }
      return {
        claim: c.claim,
        claimSource: c.claimSource,
        computedValue: computed,
        computedSource: match.computedSource,
        variance_pct: 0,
        verdict,
        implication,
      };
    }

    // Outside the range — fall through to the point-claim comparator
    // using the nearer bound as the reference value. Also produces a
    // useful variance % the user can act on.
    const nearer = computed < low ? low : high;
    return buildPointVerdict({
      c,
      computed,
      reference: nearer,
      computedSource: match.computedSource,
      isMargin,
      isOutsideRange: true,
      rangeLow: low,
      rangeHigh: high,
    });
  }

  // 4) Point-claim path.
  if (c.claimValue == null) {
    // Defensive — shouldn't happen because parseClaimsJson would have
    // set this to UNVERIFIABLE above, but keep the type-safety branch.
    return {
      claim: c.claim,
      claimSource: c.claimSource,
      computedValue: null,
      computedSource: match.computedSource,
      variance_pct: null,
      verdict: 'UNVERIFIABLE_FROM_FINANCIALS',
      implication: unverifiableImplication(c.claimType),
    };
  }

  return buildPointVerdict({
    c,
    computed,
    reference: c.claimValue,
    computedSource: match.computedSource,
    isMargin,
    isOutsideRange: false,
  });
}

interface PointVerdictArgs {
  c: ExtractedClaim;
  /** Computed ground-truth value. */
  computed: number;
  /** The numeric value from the claim used as the variance denominator
   * (the claim value, OR the nearer end of the stated range when the
   * computed value falls outside the range). */
  reference: number;
  computedSource: string;
  isMargin: boolean;
  isOutsideRange: boolean;
  rangeLow?: number;
  rangeHigh?: number;
}

function buildPointVerdict(args: PointVerdictArgs): CimClaimValidation {
  const { c, computed, reference, computedSource, isMargin } = args;

  // Variance sign convention:
  //   variance_pct = (computed - claim) / claim * 100
  //   positive  -> computed HIGHER than claim  -> claim understates
  //   negative  -> computed LOWER than claim   -> claim overstates
  // Spec verification target: claim 350K vs computed 416859
  //   (416859 - 350000) / 350000 * 100 = 19.10257... -> +19.1
  // matches MATERIAL_UNDERSTATEMENT.
  const variance =
    reference !== 0 ? ((computed - reference) / reference) * 100 : 0;
  const absVar = Math.abs(variance);

  let verdict: ClaimVerdict;
  if (absVar < VERIFIED_PCT) {
    verdict = 'VERIFIED';
  } else if (absVar < MINOR_PCT) {
    verdict = 'MINOR_DISCREPANCY';
  } else if (variance > 0) {
    // Computed > claim -> claim understates.
    verdict = FAVORABLE_TO_SELLER.has(c.claimType)
      ? 'UNDERSTATEMENT_FAVORABLE_TO_BUYER'
      : 'MATERIAL_UNDERSTATEMENT';
  } else {
    // Computed < claim -> claim overstates.
    verdict = FAVORABLE_TO_SELLER.has(c.claimType)
      ? 'OVERSTATEMENT_UNFAVORABLE_TO_BUYER'
      : 'MATERIAL_OVERSTATEMENT';
  }

  // Spec-consistent rounding: variance_pct to 1 decimal so the user-facing
  // number (and the verification target "+19.1") matches.
  const variancePctRounded = Math.round(variance * 10) / 10;

  const implication = buildImplication({
    verdict,
    claimType: c.claimType,
    computed,
    claim: reference,
    variancePct: variancePctRounded,
    isMargin,
    isOutsideRange: args.isOutsideRange,
    rangeLow: args.rangeLow,
    rangeHigh: args.rangeHigh,
  });

  return {
    claim: c.claim,
    claimSource: c.claimSource,
    computedValue: computed,
    computedSource,
    variance_pct: variancePctRounded,
    verdict,
    implication,
  };
}

// ─── Claim → ground-truth matching rules ───────────────────────────

function matchClaimToGroundTruth(
  c: ExtractedClaim,
  gt: ComputedGroundTruth,
): MatchResult {
  switch (c.claimType) {
    case 'arr': {
      // Prefer 3-mo annualised run-rate ARR; fall back to TTM revenue
      // when 3-mo isn't available (e.g. <3 months of monthly data).
      if (gt.impliedARR_3MoAvg != null) {
        return {
          computedValue: gt.impliedARR_3MoAvg,
          computedSource: gt.latestMonthMRR
            ? `Spreadsheet, 3-month avg MRR × 12 (${threeMoLabel(gt.latestMonthMRR.month)})`
            : 'Spreadsheet, 3-month avg MRR × 12',
          unverifiable: false,
        };
      }
      if (gt.TTM_revenue != null) {
        return {
          computedValue: gt.TTM_revenue,
          computedSource: 'Spreadsheet, TTM revenue (sum of last 12 months)',
          unverifiable: false,
        };
      }
      return {
        computedValue: null,
        computedSource: 'Spreadsheet (no monthly revenue series)',
        unverifiable: true,
        unverifiableReason:
          'Spreadsheet has no monthly revenue series; ARR cannot be computed. Request a monthly P&L from the seller for diligence.',
      };
    }

    case 'revenue': {
      // For "annual revenue" / "FY revenue" claims, TTM is the right
      // comparator. If TTM unavailable but we have annualised figures,
      // use the most-recent _full year as the next-best signal.
      if (gt.TTM_revenue != null) {
        return {
          computedValue: gt.TTM_revenue,
          computedSource: 'Spreadsheet, TTM revenue (sum of last 12 months)',
          unverifiable: false,
        };
      }
      const fullYearRev = pickLatestFullYear(gt.annualGrossRevenue);
      if (fullYearRev) {
        return {
          computedValue: fullYearRev.value,
          computedSource: `Spreadsheet, annual revenue ${fullYearRev.year}`,
          unverifiable: false,
        };
      }
      return {
        computedValue: null,
        computedSource: 'Spreadsheet (no annual or TTM revenue available)',
        unverifiable: true,
      };
    }

    case 'mrr': {
      if (gt.latestMonthMRR != null) {
        return {
          computedValue: gt.latestMonthMRR.grossRevenue,
          computedSource: `Spreadsheet, ${gt.latestMonthMRR.month} gross revenue`,
          unverifiable: false,
        };
      }
      if (gt.trailingThreeMonthAvgMRR != null) {
        return {
          computedValue: gt.trailingThreeMonthAvgMRR,
          computedSource: 'Spreadsheet, 3-month avg MRR',
          unverifiable: false,
        };
      }
      return {
        computedValue: null,
        computedSource: 'Spreadsheet (no monthly revenue series)',
        unverifiable: true,
      };
    }

    case 'margin': {
      if (gt.TTM_netMargin != null) {
        return {
          computedValue: gt.TTM_netMargin,
          computedSource: 'Spreadsheet, TTM net margin (NI / revenue)',
          unverifiable: false,
        };
      }
      const fullYearMargin = pickLatestFullYearMargin(gt);
      if (fullYearMargin) {
        return {
          computedValue: fullYearMargin.value,
          computedSource: `Spreadsheet, annual net margin ${fullYearMargin.year}`,
          unverifiable: false,
        };
      }
      return {
        computedValue: null,
        computedSource: 'Spreadsheet (no margin available)',
        unverifiable: true,
      };
    }

    case 'asking_price': {
      const ask = gt.valuationContextAtAskingPrice?.askingPrice ?? null;
      if (ask != null) {
        return {
          computedValue: ask,
          computedSource: 'Deal record, askingPrice',
          unverifiable: false,
        };
      }
      return {
        computedValue: null,
        computedSource: 'Deal record (no askingPrice set)',
        unverifiable: true,
        unverifiableReason:
          'Deal record has no askingPrice; cannot reconcile valuation claims. Confirm the asking number with the seller before relying on prior-offer references.',
      };
    }

    // Out-of-scope for the financial spreadsheet — the ground truth has
    // no derivable value for these. Implication template will explain.
    case 'growth_rate':
    case 'subscriber_count':
    case 'launch_date':
    case 'prior_offer':
    case 'other':
    default:
      return {
        computedValue: null,
        computedSource: 'Not derivable from spreadsheet',
        unverifiable: true,
      };
  }
}

// ─── Implication template helpers ──────────────────────────────────

interface ImplicationArgs {
  verdict: ClaimVerdict;
  claimType: ClaimType;
  computed: number;
  claim: number;
  variancePct: number;
  isMargin: boolean;
  isOutsideRange: boolean;
  rangeLow?: number;
  rangeHigh?: number;
}

function buildImplication(a: ImplicationArgs): string {
  const computedFmt = formatValue(a.computed, a.isMargin);
  const claimFmt = formatValue(a.claim, a.isMargin);
  const metric = metricName(a.claimType);
  // Use rounded magnitude for narrative copy ("~19%") so the prose
  // stays readable; the precise value is in variance_pct.
  const absPctRounded = Math.round(Math.abs(a.variancePct));
  const rangeNote = a.isOutsideRange
    ? ` Computed value falls outside the stated range ` +
      `${formatValue(a.rangeLow ?? 0, a.isMargin)}-` +
      `${formatValue(a.rangeHigh ?? 0, a.isMargin)}; nearer bound used as reference.`
    : '';

  switch (a.verdict) {
    case 'VERIFIED':
      return (
        `${metric} of ${computedFmt} matches the claimed ${claimFmt} within ` +
        `tolerance (${a.variancePct >= 0 ? '+' : ''}${a.variancePct}%). ` +
        `Claim verified.`
      );

    case 'MINOR_DISCREPANCY':
      return (
        `Discrepancy of ${absPctRounded}% between stated ${metric} ` +
        `(${claimFmt}) and computed (${computedFmt}) — minor; may reflect ` +
        `timing or methodology differences. Verify with seller.${rangeNote}`
      );

    case 'UNDERSTATEMENT_FAVORABLE_TO_BUYER':
      return (
        `Business has continued growing past CIM snapshot. True ${metric} ` +
        `is ~${absPctRounded}% higher than stated (${computedFmt} vs ` +
        `${claimFmt}). Buyer should reprice off current run-rate, not ` +
        `stale ${metric}.${rangeNote}`
      );

    case 'OVERSTATEMENT_UNFAVORABLE_TO_BUYER':
      return (
        `Stated ${metric} (${claimFmt}) overstates the spreadsheet number ` +
        `by ~${absPctRounded}% (computed ${computedFmt}). Push back on the ` +
        `seller's framing — repricing should anchor on the lower computed ` +
        `value.${rangeNote}`
      );

    case 'MATERIAL_UNDERSTATEMENT':
      return (
        `Stated ${metric} (${claimFmt}) understates the spreadsheet number ` +
        `by ~${absPctRounded}% (computed ${computedFmt}). Investigate why ` +
        `the narrative is conservative — could be stale data or a deliberate ` +
        `framing choice.${rangeNote}`
      );

    case 'MATERIAL_OVERSTATEMENT':
      return (
        `Stated ${metric} (${claimFmt}) overstates the spreadsheet number ` +
        `by ~${absPctRounded}% (computed ${computedFmt}). Reconcile the ` +
        `methodology with the seller before relying on this figure.${rangeNote}`
      );

    case 'VERIFIED_LOWER_END':
    case 'VERIFIED_UPPER_END':
      // Range-edge implications are built directly in buildValidation;
      // shouldn't reach here from the point-claim path.
      return (
        `${metric} of ${computedFmt} is verified against claimed ${claimFmt}.`
      );

    case 'UNVERIFIABLE_FROM_FINANCIALS':
      return unverifiableImplication(a.claimType);
  }
}

function unverifiableImplication(claimType: ClaimType): string {
  switch (claimType) {
    case 'growth_rate':
      return (
        'Spreadsheet does not contain a growth-rate disclosure. Compute ' +
        'YoY growth from the monthly revenue series and verify against ' +
        'the seller-stated rate during diligence.'
      );
    case 'subscriber_count':
      return (
        'Spreadsheet contains no subscriber/customer count data. Request ' +
        'a customer file (active subscribers, churn, ACV) from the seller ' +
        'to validate this claim.'
      );
    case 'launch_date':
      return (
        'Launch date is not derivable from the financials. Request founding ' +
        'docs or the seller\'s product timeline to confirm.'
      );
    case 'prior_offer':
      return (
        'Prior-offer history is not in the spreadsheet. Ask the seller for ' +
        'documentation (LOIs, term sheets) of any referenced prior offers.'
      );
    case 'asking_price':
      return (
        'Deal record has no askingPrice; cannot reconcile valuation claims. ' +
        'Confirm the asking number with the seller before relying on ' +
        'prior-offer references.'
      );
    case 'other':
    default:
      return (
        'Claim is not derivable from the financial spreadsheet. Request ' +
        'supporting documentation from the seller for diligence.'
      );
  }
}

// ─── Display helpers ───────────────────────────────────────────────

function metricName(t: ClaimType): string {
  switch (t) {
    case 'arr': return 'ARR';
    case 'mrr': return 'MRR';
    case 'revenue': return 'revenue';
    case 'margin': return 'margin';
    case 'growth_rate': return 'growth rate';
    case 'subscriber_count': return 'subscriber count';
    case 'asking_price': return 'asking price';
    case 'prior_offer': return 'prior offer';
    case 'launch_date': return 'launch date';
    case 'other': return 'metric';
  }
}

/** Format a value for display. Margins/percentages are emitted as "X.X%";
 * dollar amounts use formatMoney ($K/$M/$B). */
function formatValue(value: number, isMargin: boolean): string {
  if (isMargin) {
    // Fractions in (0,1] read as percentages; whole numbers (e.g. when
    // an LLM returns 75 instead of 0.75) get treated as already-percent.
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    const rounded = Math.round(pct * 10) / 10;
    return `${rounded}%`;
  }
  return formatMoney(value);
}

/** Compact $K/$M/$B formatter. Stays consistent with how the channels
 * module renders monthly figures so the UI feels uniform. */
function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return `$${n}`;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    const v = roundOneDp(n / 1_000_000_000);
    return `$${v}B`;
  }
  if (abs >= 1_000_000) {
    const v = roundOneDp(n / 1_000_000);
    return `$${v}M`;
  }
  if (abs >= 1_000) {
    const v = Math.round(n / 1_000);
    return `$${v}K`;
  }
  return `$${Math.round(n)}`;
}

function roundOneDp(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}

/** Convert "2026-03" -> "Jan-Mar 2026" (the 3-month window ending on
 * the labelled month). Used in computedSource for ARR claims so the
 * reader can tell which months the run-rate spans. */
function threeMoLabel(latestIsoMonth: string): string {
  const m = latestIsoMonth.match(/^(\d{4})-(\d{2})$/);
  if (!m) return latestIsoMonth;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const MONTHS = [
    '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  // Window is the trailing 3 months ending on (and including) `month`.
  // E.g. month=3 -> Jan-Mar of the same year.
  const startMonth = month - 2;
  if (startMonth >= 1) {
    return `${MONTHS[startMonth]}-${MONTHS[month]} ${year}`;
  }
  // Wrap into prior year.
  const startMonthWrapped = ((startMonth - 1) % 12 + 12) % 12 + 1;
  const startYear = year - 1;
  return `${MONTHS[startMonthWrapped]} ${startYear}-${MONTHS[month]} ${year}`;
}

// ─── Annual-margin / annual-revenue lookup helpers ─────────────────

interface YearPick {
  year: string;
  value: number;
}

function pickLatestFullYear(
  rec: Record<string, number>,
): YearPick | null {
  const fullYears: YearPick[] = [];
  for (const [key, value] of Object.entries(rec)) {
    const m = key.match(/^(\d{4})_full$/);
    if (m) fullYears.push({ year: m[1]!, value });
  }
  if (fullYears.length === 0) return null;
  fullYears.sort((a, b) => Number(b.year) - Number(a.year));
  return fullYears[0]!;
}

function pickLatestFullYearMargin(gt: ComputedGroundTruth): YearPick | null {
  return pickLatestFullYear(gt.annualNetMargin);
}
