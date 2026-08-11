import { z } from 'zod';

// One proposed field update. Includes the exact phrase from the email that
// motivated the change so a human reviewer (and the audit log) can verify.
const proposedField = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value,
    confidence: z.number().min(0).max(1),
    sourceQuote: z.string().min(1).max(500),
  });

export const dealStageEnum = z.enum([
  'INITIAL_REVIEW',
  'TEASER_RECEIVED',
  'CIM_REVIEW',
  'DUE_DILIGENCE',
  'IOI_SUBMITTED',
  'LOI_SUBMITTED',
  'NEGOTIATION',
  'CLOSED_WON',
  'CLOSED_LOST',
  'PASSED',
]);

export const incrementalUpdateSchema = z.object({
  // Sensitive (always queued for human approval in autoUpdateDeal).
  dealSize: proposedField(z.number().positive()).nullable(),
  revenue: proposedField(z.number().positive()).nullable(),
  ebitda: proposedField(z.number()).nullable(),
  stage: proposedField(dealStageEnum).nullable(),

  // Non-sensitive (auto-applied above threshold).
  description: proposedField(z.string().min(1).max(2000)).nullable(),
  industry: proposedField(z.string().min(1).max(120)).nullable(),
  // Additive: classifier returns BULLETS to APPEND, not a replacement aiThesis.
  thesisAppend: proposedField(z.string().min(1).max(1000)).nullable(),
  keyRisksAdd: z.array(z.string().min(1).max(300)).max(8),
  investmentHighlightsAdd: z.array(z.string().min(1).max(300)).max(8),

  // Newly-mentioned people who should become Contacts on the deal.
  contactsToAdd: z.array(
    z.object({
      email: z.string().email(),
      name: z.string().nullable(),
      role: z.string().nullable(),
      sourceQuote: z.string().max(300).nullable(),
    })
  ).max(20),

  reasoning: z.string(),
});

export type DealIncrementalUpdate = z.infer<typeof incrementalUpdateSchema>;
export type DealStage = z.infer<typeof dealStageEnum>;

// Field-level sensitivity policy. Sensitive fields ALWAYS land in
// DealUpdateProposal regardless of confidence; non-sensitive fields are eligible
// for auto-apply above the org threshold.
export const SENSITIVE_FIELDS = new Set<string>([
  'dealSize',
  'revenue',
  'ebitda',
  'stage',
]);
