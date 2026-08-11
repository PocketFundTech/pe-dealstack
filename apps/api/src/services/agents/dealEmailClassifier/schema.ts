import { z } from 'zod';

// Deal type taxonomy. Kept narrow on purpose; if none fits, the classifier
// should still mark isRelevant = false rather than picking 'other' as a hedge.
export const dealEmailTypeEnum = z.enum([
  'cold_pitch',         // banker reaching out with a new opportunity
  'banker_intro',       // intermediated intro to a target
  'founder_intro',      // founder directly pitching their company
  'process_update',     // CIM follow-up, IOI request, LOI process, etc.
  'portfolio_update',   // existing portfolio company sending an update
  'lp_intro',           // limited-partner intro
  'thread_update',      // follow-up on an ongoing deal thread
  'other',
]);

export const dealEmailClassifierSchema = z.object({
  isRelevant: z.boolean(),
  confidence: z.number().min(0).max(1),
  dealType: dealEmailTypeEnum.nullable(),
  reasoning: z.string(),
  hints: z.object({
    companyName: z.string().nullable(),
    sector: z.string().nullable(),
    geography: z.string().nullable(),
    askPrice: z.string().nullable(),    // free-text; deeper extraction happens later if isRelevant
    contactRoles: z.array(z.string()),  // e.g. ["banker", "founder", "CFO"]
  }),
});

export type DealEmailClassification = z.infer<typeof dealEmailClassifierSchema>;
export type DealEmailType = z.infer<typeof dealEmailTypeEnum>;
