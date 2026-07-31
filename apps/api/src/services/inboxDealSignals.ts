// ─── Inbox deal-signal scoring ─────────────────────────────────────
// Explainable, LLM-free scoring for the dashboard inbox scan. Runs on each
// candidate email's subject + body + attachment filenames BEFORE the expensive
// AI extraction so the scan can:
//   1. GATE OUT low-signal noise cheaply (stops the scan "picking up randomly"),
//   2. PRIORITISE genuine sourcing emails (High / Medium / Low), and
//   3. SHOW the user WHY an email was picked up — the matched signals are the
//      "breakdown / process" surfaced in the Inbox Deal Finder widget.
//
// Calibrated against the real sourcing transcripts in the deal-testing corpus
// (Pocket Fund "Spencer" drafts, "Project <name>" teasers): friendly intro
// emails that pack MRR/ARR, an asking price / EBITDA multiple, a founder/owner
// context, and a one-pager / tear-sheet / CIM attachment — often several deals
// per email. Those hallmarks are what score high here; a newsletter that merely
// says "for sale" scores low and is deprioritised or gated out.

export type DealPriority = 'high' | 'medium' | 'low';

export interface DealSignalBreakdown {
  /** 0–100 aggregate signal strength. */
  score: number;
  priority: DealPriority;
  /** Human-readable matched signals, strongest first — shown in the widget. */
  signals: string[];
}

// ─── Tunables (no magic numbers) ───────────────────────────────────

// Emails scoring below this carry no real deal signal — skip the LLM entirely.
// Set just above the weight of a single weak, noisy term ("for sale" = 18) so a
// lone brush of one keyword is gated, while any genuine deal email — which
// always carries several signals — clears it comfortably.
export const LLM_EXTRACTION_GATE = 20;
// Priority tier cut-offs on the 0–100 score.
export const PRIORITY_HIGH_MIN = 55;
export const PRIORITY_MEDIUM_MIN = 28;
const SCORE_CAP = 100;

// A deal-document attachment (one-pager, tear sheet, CIM, teaser, financial
// model, cap table, QoE). Kept in sync with the scanner's own attachment gate.
const DEAL_ATTACHMENT_NAME_RE =
  /\b(cim|teaser|one[\s-]?pager|tear[\s-]?sheet|information\s+memorandum|info\s*memo|memorandum|financial[\s-]?model|cap[\s-]?table|qo[fe]|q\.?o\.?e|ioi|tear\s*sheet)\b/i;

interface SignalRule {
  /** Shown verbatim to the user when matched. */
  label: string;
  /** Added to the aggregate score on match. */
  weight: number;
  /** Match against the combined lowercased subject+body haystack. */
  test: RegExp;
}

// Ordered by weight (documentation only — the score sorts matches at runtime).
const SIGNAL_RULES: SignalRule[] = [
  {
    label: 'Recurring-revenue metric (MRR / ARR)',
    weight: 25,
    test: /\b(mrr|arr|recurring revenue|run[\s-]?rate)\b/i,
  },
  {
    label: 'Asking price / enterprise value stated',
    weight: 20,
    test: /\b(asking price|ask:|enterprise value|\bev\b|purchase price|transaction value|deal size|valuation expectation)\b/i,
  },
  {
    label: 'Acquisition / sale framing',
    weight: 18,
    test: /\b(acquisition opportunity|for sale|investment opportunity|off[\s-]?market|reason for sale|seeking (a )?(buyer|exit|liquidity)|open to (a )?(sale|acquisition|exit)|majority (buyout|sale)|full exit|exit options)\b/i,
  },
  {
    label: 'EBITDA / margin disclosed',
    weight: 15,
    test: /\b(ebitda|gross margin|net margin|operating margin|contribution margin)\b/i,
  },
  {
    label: 'Revenue figure disclosed',
    weight: 15,
    test: /\b(revenue|turnover|top[\s-]?line|net revenue|gross revenue|sde|gmv|take[\s-]?rate)\b/i,
  },
  {
    label: 'EBITDA / revenue multiple',
    weight: 12,
    // "6x", "4-6x", "3–4×", "~9-10x EBITDA", "3–4× ARR"
    test: /\b\d+(?:\.\d+)?\s*[-–—]?\s*(?:\d+(?:\.\d+)?)?\s*[x×]\b/i,
  },
  {
    label: 'Currency-tagged money amount',
    weight: 10,
    // $2.1M, ₹42 Cr, €1.2M, £5m, "57K/year", "$3-5 Mn"
    test: /(?:[$₹€£]\s?\d|\b\d+(?:\.\d+)?\s?(?:cr\b|crore|lakh|mn\b|mm\b|[km]\b|million|billion))/i,
  },
  {
    label: 'Founder / ownership context',
    weight: 8,
    test: /\b(founder|founder-led|bootstrapped|owner[\s-]?operator|promoter|owner is|sole owner)\b/i,
  },
  {
    label: 'Multiple opportunities enumerated',
    weight: 8,
    test: /(?:\n|^)\s*\d+\.\s+\S|\b(two|three|several) (new )?(deals|opportunities)\b|opportunities below/i,
  },
];

/**
 * Score an email's deal-signal strength from cheap text signals (no LLM).
 * `attachmentNames` are the raw attachment filenames on the message — a
 * deal-document attachment is the single strongest signal.
 */
export function scoreDealSignals(input: {
  subject: string;
  body: string;
  attachmentNames: string[];
}): DealSignalBreakdown {
  const haystack = `${input.subject}\n${input.body}`;
  const matched: Array<{ label: string; weight: number }> = [];

  // Attachment signal first (strongest) — inspect filenames, not body text.
  const dealAttachment = input.attachmentNames.find((n) => DEAL_ATTACHMENT_NAME_RE.test(n));
  if (dealAttachment) {
    matched.push({ label: `Deal document attached (${dealAttachment})`, weight: 35 });
  }

  for (const rule of SIGNAL_RULES) {
    if (rule.test.test(haystack)) {
      matched.push({ label: rule.label, weight: rule.weight });
    }
  }

  const rawScore = matched.reduce((sum, m) => sum + m.weight, 0);
  const score = Math.min(SCORE_CAP, rawScore);
  const signals = matched
    .sort((a, b) => b.weight - a.weight)
    .map((m) => m.label);

  return { score, priority: priorityFor(score), signals };
}

function priorityFor(score: number): DealPriority {
  if (score >= PRIORITY_HIGH_MIN) return 'high';
  if (score >= PRIORITY_MEDIUM_MIN) return 'medium';
  return 'low';
}

/** Sort rank for a priority (lower = shown first). */
export function priorityRank(p: DealPriority): number {
  return p === 'high' ? 0 : p === 'medium' ? 1 : 2;
}
