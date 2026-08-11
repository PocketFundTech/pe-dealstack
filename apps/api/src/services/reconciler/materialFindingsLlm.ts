// ─── Quantitative Reconciler — LLM Material Findings Synthesizer ────
//
// Phase 2 layer that surfaces the qualitative findings a pure
// deterministic detector can't synthesize: platform concentration risk
// framing (F-001), unverifiable seller claims (F-004), revenue
// recognition flags (F-005), operating leverage observations (F-006),
// over-weighted side products (F-003), channel mix shift, etc.
//
// Phase 1 still produces F-002 (the OpEx step-up detector); this module
// is passed those `existingFindings` so the LLM doesn't duplicate them
// and so its IDs skip any already-claimed slots.
//
// One LLM call total. Returns [] on LLM unavailable / parse error /
// network blow-up — caller falls back to the Phase 1 deterministic
// findings only.
//
// Output is capped at 8 findings (slice if the model returns more).

import {
  type ChannelConcentrationAnalysis,
  type ComputedGroundTruth,
  type MaterialFinding,
  type NarrativeDocumentInput,
  type ValuationFraming,
} from './shared.js';
import { isAIEnabled, trackedChatCompletion } from '../../openai.js';
import { MODEL_INSIGHTS } from '../../utils/aiModels.js';
import { log } from '../../utils/logger.js';

// ─── Tunables ──────────────────────────────────────────────────────

/** Hard cap on findings returned. Keeps the output focused — buyers
 * triage on severity, not volume. */
const MAX_FINDINGS = 8;

/** Per-document narrative slice. The LLM doesn't need the full 20K cap
 * shared.ts mentions — 5K is plenty to cite seller-stated claims like
 * "7.1% churn" or "5 LOIs received" without exploding the prompt. */
const PER_DOC_NARRATIVE_CHARS = 5_000;

// ─── System prompt ─────────────────────────────────────────────────
//
// Verbatim — keep this in sync with the spec. The bullet list of
// categories doubles as the "what to look for" rubric the model uses
// to bucket findings, and the format example pins the JSON shape.

const SYS_PROMPT = `You are a PE associate at a lower-middle-market firm doing diligence on a deal. You're given:
 1. Computed ground-truth aggregates (annual/TTM revenue, MRR, margins, valuation framing)
 2. Channel concentration analysis (HHI, per-channel %, dependency risk)
 3. Existing deterministic findings already surfaced (don't duplicate these)
 4. Narrative document text (CIM, teaser) — use this to ground findings in specific seller claims

Surface 4-7 MATERIAL findings a buyer would care about. Severity is HIGH (deal-threatening / requires immediate diligence), MEDIUM (needs investigation, doesn't change deal logic), LOW (nice-to-know / supports thesis). Categories to consider:
 - Platform / customer concentration (HHI >= 2500 = HIGH; check the per-channel breakdown for the at-risk channel and frame the dollar exposure)
 - Unverifiable seller claims (subscriber count, churn rate, geography, prior offers — flag as MEDIUM, request supporting data)
 - Revenue recognition / accounting flags (fees treatment, subscription revenue timing, deferred revenue) — flag as MEDIUM
 - Operating leverage observations (does the cost base scale with revenue or stay flat — supports or undermines the high-margin thesis)
 - Side products / non-core revenue lines that the AI extraction over-weighted as "material" — flag as MEDIUM/LOW with framing of true contribution
 - Channel mix shift over time (if monthly data shows one channel growing, another shrinking — call it out as a strategic question)

Each finding MUST cite specific numbers from the computed ground truth. The 'evidence' field shows raw data ("App-store revenue = 52.3% of Q1-26 revenue. Wix Website Speedy alone is 41.2%"). The 'implication' field explains what the buyer should DO ("Request Wix Partner Agreement, history of platform policy changes...").

Use IDs F-001, F-003, F-004, F-005, F-006... Skip F-002 (OpEx step-up — that's the deterministic detector). Numbering starts at F-001 and skips any already-used IDs from existingFindings.

Return JSON: { "findings": [{ "id", "severity", "title", "evidence", "implication" }, ...] }`;

// ─── Public entry point ────────────────────────────────────────────

export async function synthesizeMaterialFindings(input: {
  groundTruth: ComputedGroundTruth;
  channelConcentration: ChannelConcentrationAnalysis | null;
  valuationFraming: ValuationFraming | null;
  /** Phase 1 deterministic findings already produced (e.g. F-002 OpEx).
   * Pass these in so the LLM doesn't duplicate them. */
  existingFindings: MaterialFinding[];
  /** Narrative documents — used as context to ground findings in
   * specific source claims (e.g. CIM said "7.1% churn" — F-004 cites it). */
  narrativeDocuments: NarrativeDocumentInput[];
  dealId: string;
  orgId: string;
}): Promise<MaterialFinding[]> {
  const {
    groundTruth,
    channelConcentration,
    valuationFraming,
    existingFindings,
    narrativeDocuments,
    dealId,
    orgId,
  } = input;

  if (!isAIEnabled()) {
    log.warn('reconciler.materialFindingsLlm: LLM disabled, returning []', {
      dealId,
    });
    return [];
  }

  const userPrompt = buildUserPrompt({
    groundTruth,
    channelConcentration,
    valuationFraming,
    existingFindings,
    narrativeDocuments,
  });

  try {
    const response = await trackedChatCompletion(
      'reconciler_material_findings',
      {
        model: MODEL_INSIGHTS,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 3500,
      },
      undefined,
      {
        tags: ['reconciler', 'material_findings_llm'],
        traceMeta: { dealId, orgId },
      },
    );

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      log.warn('reconciler.materialFindingsLlm: empty LLM response', {
        dealId,
      });
      return [];
    }

    const parsed = safeParseFindings(content);
    if (parsed.length === 0) {
      log.warn(
        'reconciler.materialFindingsLlm: parsed 0 valid findings from response',
        { dealId },
      );
      return [];
    }

    // Dedup against existing findings, then cap at MAX_FINDINGS.
    const deduped = dedupAgainstExisting(parsed, existingFindings);
    return deduped.slice(0, MAX_FINDINGS);
  } catch (err) {
    log.error('reconciler.materialFindingsLlm: LLM call failed', err, {
      dealId,
    });
    return [];
  }
}

// ─── Prompt construction ───────────────────────────────────────────

function buildUserPrompt(args: {
  groundTruth: ComputedGroundTruth;
  channelConcentration: ChannelConcentrationAnalysis | null;
  valuationFraming: ValuationFraming | null;
  existingFindings: MaterialFinding[];
  narrativeDocuments: NarrativeDocumentInput[];
}): string {
  const {
    groundTruth,
    channelConcentration,
    valuationFraming,
    existingFindings,
    narrativeDocuments,
  } = args;

  const parts: string[] = [];

  parts.push('COMPUTED GROUND TRUTH:');
  parts.push(JSON.stringify(groundTruth, null, 2));
  parts.push('');

  parts.push('CHANNEL CONCENTRATION:');
  parts.push(
    channelConcentration
      ? JSON.stringify(channelConcentration, null, 2)
      : 'Not available',
  );
  parts.push('');

  parts.push('VALUATION FRAMING:');
  parts.push(
    valuationFraming ? JSON.stringify(valuationFraming, null, 2) : 'Not available',
  );
  parts.push('');

  parts.push('ALREADY-SURFACED FINDINGS (do not duplicate):');
  if (existingFindings.length === 0) {
    parts.push('(none)');
  } else {
    parts.push(
      existingFindings
        .map((f) => `- ${f.id} ${f.severity}: ${f.title}`)
        .join('\n'),
    );
  }
  parts.push('');

  parts.push(
    'NARRATIVE CONTEXT (CIM/teaser excerpts — use to cite specific seller claims):',
  );
  if (narrativeDocuments.length === 0) {
    parts.push('(none)');
  } else {
    for (const doc of narrativeDocuments) {
      const header = `--- ${doc.name} (type: ${doc.type ?? 'UNKNOWN'}) ---`;
      const slice = (doc.extractedText ?? '').slice(0, PER_DOC_NARRATIVE_CHARS);
      parts.push(header);
      parts.push(slice);
      parts.push('');
    }
  }

  parts.push('Return 4-7 material findings now.');

  return parts.join('\n');
}

// ─── Response parsing + validation ─────────────────────────────────

/** Parse the LLM JSON envelope into typed MaterialFinding[]. Tolerant
 * of malformed entries — drops any element missing required fields
 * rather than throwing. Returns [] on outer JSON failure. */
function safeParseFindings(raw: string): MaterialFinding[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return [];
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !Array.isArray((envelope as { findings?: unknown }).findings)
  ) {
    return [];
  }
  const arr = (envelope as { findings: unknown[] }).findings;

  const out: MaterialFinding[] = [];
  for (const entry of arr) {
    const f = coerceFinding(entry);
    if (f) out.push(f);
  }
  return out;
}

function coerceFinding(entry: unknown): MaterialFinding | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  const id = typeof e.id === 'string' ? e.id.trim() : '';
  const severityRaw =
    typeof e.severity === 'string' ? e.severity.toUpperCase().trim() : '';
  const title = typeof e.title === 'string' ? e.title.trim() : '';
  const evidence = typeof e.evidence === 'string' ? e.evidence.trim() : '';
  const implication =
    typeof e.implication === 'string' ? e.implication.trim() : '';

  if (!id || !title || !evidence || !implication) return null;
  if (
    severityRaw !== 'HIGH' &&
    severityRaw !== 'MEDIUM' &&
    severityRaw !== 'LOW'
  ) {
    return null;
  }

  return {
    id,
    severity: severityRaw as MaterialFinding['severity'],
    title,
    evidence,
    implication,
  };
}

// ─── Dedup ────────────────────────────────────────────────────────
//
// Defensive layer on top of the prompt's "don't duplicate" instruction.
// Match logic: take the first 5 words of each existing finding's title
// (lower-cased) — if a candidate finding's title contains that
// substring, skip it. 5 words is a sweet spot: enough to fingerprint
// "Operating expenses stepped up 39%" and avoid colliding with unrelated
// titles, short enough to still match minor wording drift.

function dedupAgainstExisting(
  candidates: MaterialFinding[],
  existing: MaterialFinding[],
): MaterialFinding[] {
  if (existing.length === 0) return candidates;

  const fingerprints = existing
    .map((f) => firstNWords(f.title, 5).toLowerCase())
    .filter((s) => s.length > 0);

  if (fingerprints.length === 0) return candidates;

  return candidates.filter((c) => {
    const titleLower = c.title.toLowerCase();
    return !fingerprints.some((fp) => titleLower.includes(fp));
  });
}

function firstNWords(s: string, n: number): string {
  return s
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .join(' ')
    .trim();
}
