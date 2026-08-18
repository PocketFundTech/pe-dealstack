// ─── NDA Review engine ────────────────────────────────────────────
// Reviews an INCOMING counterparty NDA against the firm's playbook and
// returns clause-by-clause findings with paste-ready replacement language.
//
// Demo-call origin: Daniel Rocznik (M4) — "30 minutes each, up to five a
// day, 2.5 hours a day". The largest single time saving quoted in any of
// the 19 calls. We already generate our own NDAs and e-sign them; ~90% of
// what a buyer actually signs is the broker's paper, and that was
// untouched until now.
//
// Structure deliberately mirrors services/agents/dealScorecard/index.ts:
// one structured-output call, a raced client-side timeout, persist then
// return, typed error class.
//
// GROUNDING: every quoted span is checked against the parsed document
// before it is persisted (see ./grounding.ts). Unverified quotes are kept
// and flagged, never trusted and never silently dropped.

import { supabase } from '../../../supabase.js';
import { trackedClaudeMessage } from '../../ai/client.js';
import { log } from '../../../utils/logger.js';
import {
  DEFAULT_NDA_PLAYBOOK,
  ndaPlaybookSchema,
  type NdaPlaybook,
} from '../../ndaPlaybookDefaults.js';
import { htmlToPlainText, verifyQuotes } from './grounding.js';

const NDA_REVIEW_TIMEOUT_MS = 60_000;

/** Longest NDA text we send. Beyond this the doc isn't an NDA. */
const MAX_NDA_CHARS = 120_000;

export class NdaReviewError extends Error {
  code: 'EMPTY_DOCUMENT' | 'TOO_LONG';
  status: number;
  constructor(message: string, code: NdaReviewError['code'], status = 400) {
    super(message);
    this.name = 'NdaReviewError';
    this.code = code;
    this.status = status;
  }
}

export type FindingStatus = 'MISSING' | 'ACCEPTABLE' | 'DEVIATION' | 'DEAL_BREAKER';

export interface NdaFinding {
  clauseKey: string;
  clauseTitle: string;
  status: FindingStatus;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  quotedText: string;
  whyItMatters: string;
  playbookPosition: string;
  suggestedLanguage: string;
  quoteVerified: boolean;
}

export interface NdaReview {
  id?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  summary: string;
  findings: NdaFinding[];
  model: string;
  reviewedAt: string;
}

const NDA_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clauseKey: { type: 'string' },
          clauseTitle: { type: 'string' },
          status: { type: 'string', enum: ['MISSING', 'ACCEPTABLE', 'DEVIATION', 'DEAL_BREAKER'] },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          quotedText: { type: 'string' },
          whyItMatters: { type: 'string' },
          playbookPosition: { type: 'string' },
          suggestedLanguage: { type: 'string' },
        },
        required: [
          'clauseKey', 'clauseTitle', 'status', 'severity',
          'quotedText', 'whyItMatters', 'playbookPosition', 'suggestedLanguage',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['riskLevel', 'summary', 'findings'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are reviewing an incoming NDA on behalf of a private-equity buyer, against that firm's own negotiating playbook. Your reader is a deal partner, not a lawyer: they want to know in 60 seconds what to push back on and what language to send.

Grounding rules — these are absolute:
- Review ONLY the NDA text provided in this message. Never rely on knowledge of this counterparty, this firm, or NDAs you have seen elsewhere. You have no information about either party beyond what is written here.
- "quotedText" MUST be copied verbatim and contiguously from the NDA text provided. Never paraphrase, never tidy up, never reconstruct from memory. Copy the exact characters, including numbers and defined terms.
- If a clause is absent from the NDA, return status "MISSING" with an empty quotedText. Never infer what an absent clause "probably" says.

Coverage:
- Produce exactly one finding per playbook position, using that position's key as clauseKey.
- Additionally produce findings for clauses present in the NDA that the playbook does not address, using clauseKey "unmapped" — these are often where the surprises are.

Classification:
- "DEAL_BREAKER" only when the playbook marks that position dealBreaker AND the NDA violates it.
- "DEVIATION" when the NDA departs from our stated position but within negotiable range.
- "ACCEPTABLE" when the NDA matches our position or falls inside the acceptable range.
- "MISSING" when the NDA is silent on a position we care about.
- severity reflects commercial impact on this buyer, not legal exotica.

Output:
- "suggestedLanguage" must be drafting-ready replacement text the reader can paste into a redline. Not a description of what to change — the actual clause. Use the playbook's fallbackLanguage where one is given and it fits. Leave it empty only for ACCEPTABLE findings.
- "whyItMatters" is one or two plain sentences on the commercial consequence.
- "summary" is 2-3 sentences a partner can read in ten seconds.

You are assisting with commercial review, not giving legal advice.`;

/** Worst-first, so the reader's eye lands on what needs action. */
const STATUS_ORDER: Record<FindingStatus, number> = {
  DEAL_BREAKER: 0, DEVIATION: 1, MISSING: 2, ACCEPTABLE: 3,
};
const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** The org's playbook, or the shipped defaults so the feature works on day one. */
export async function loadPlaybook(orgId: string): Promise<NdaPlaybook> {
  const { data } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();

  const stored = (data?.settings as Record<string, any> | null)?.ndaPlaybook;
  if (!stored) return DEFAULT_NDA_PLAYBOOK;

  const parsed = ndaPlaybookSchema.safeParse(stored);
  if (!parsed.success || parsed.data.positions.length === 0) {
    log.warn('[ndaReview] stored playbook invalid or empty — using defaults', { orgId });
    return DEFAULT_NDA_PLAYBOOK;
  }
  return parsed.data;
}

export interface ReviewNdaInput {
  orgId: string;
  dealId: string | null;
  sourceHtml: string;
  sourceFileName: string;
  documentId?: string | null;
  createdBy?: string | null;
}

export async function reviewNda(input: ReviewNdaInput): Promise<NdaReview> {
  const plainText = htmlToPlainText(input.sourceHtml);
  if (plainText.length < 40) {
    throw new NdaReviewError(
      'That file has no readable text — if it is a scanned NDA, we cannot review it yet.',
      'EMPTY_DOCUMENT',
    );
  }
  if (plainText.length > MAX_NDA_CHARS) {
    throw new NdaReviewError(
      'That document is too long to review as an NDA.',
      'TOO_LONG',
    );
  }

  const playbook = await loadPlaybook(input.orgId);

  const userPrompt = [
    '## Firm NDA playbook',
    JSON.stringify(playbook, null, 2),
    '',
    '## NDA under review',
    '(Everything below is the complete text of the document. Quote only from here.)',
    '',
    plainText,
  ].join('\n');

  const timeoutMs = Number(process.env.NDA_REVIEW_TIMEOUT_MS) > 0
    ? Number(process.env.NDA_REVIEW_TIMEOUT_MS)
    : NDA_REVIEW_TIMEOUT_MS;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`NDA review timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  let result: { text: string; model: string };
  try {
    result = await Promise.race([
      trackedClaudeMessage({
        operation: 'nda_review',
        role: 'chat',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        outputSchema: NDA_REVIEW_SCHEMA,
        maxTokens: 8000,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const parsed = JSON.parse(result.text) as {
    riskLevel: NdaReview['riskLevel'];
    summary: string;
    findings: Array<Omit<NdaFinding, 'quoteVerified'>>;
  };

  // Grounding gate — before persistence, before display.
  const verified = verifyQuotes(parsed.findings ?? [], input.sourceHtml);

  const unverified = verified.filter((f) => !f.quoteVerified);
  for (const finding of unverified) {
    // Logged individually so the unverified-quote RATE is monitorable —
    // it is the health metric for this feature.
    log.warn('[ndaReview] quote failed verbatim check', {
      dealId: input.dealId,
      clauseKey: finding.clauseKey,
      fileName: input.sourceFileName,
      quotePrefix: String(finding.quotedText).slice(0, 60),
    });
  }

  const findings = (verified as NdaFinding[]).sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
  });

  const reviewedAt = new Date().toISOString();

  const { data: saved, error } = await supabase
    .from('NdaReview')
    .insert({
      dealId: input.dealId,
      organizationId: input.orgId,
      documentId: input.documentId ?? null,
      sourceFileName: input.sourceFileName,
      sourceHtml: input.sourceHtml,
      findings,
      summary: parsed.summary,
      riskLevel: parsed.riskLevel,
      playbookSnapshot: playbook,
      model: result.model,
      reviewedAt,
      createdBy: input.createdBy ?? null,
    })
    .select()
    .single();

  if (error) throw error;

  log.info('[ndaReview] reviewed', {
    dealId: input.dealId,
    riskLevel: parsed.riskLevel,
    findings: findings.length,
    unverifiedQuotes: unverified.length,
  });

  return {
    id: saved?.id,
    riskLevel: parsed.riskLevel,
    summary: parsed.summary,
    findings,
    model: result.model,
    reviewedAt,
  };
}
