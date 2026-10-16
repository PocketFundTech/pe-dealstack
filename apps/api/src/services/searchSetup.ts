import { z } from 'zod';
import { ConflictError } from '../middleware/errorHandler.js';
export const SETUP_STEPS = ['brief','team','sectors','geography','size','fit','transaction','workflow','review'] as const;
const text = z.string().max(5000);
const list = z.array(z.string().max(100)).max(250);
const amount = z.number().finite().min(0).max(1_000_000).nullable();
// Drafts allow incomplete answers; only the completed profile is consumed by AI.
export const searchDraftSchema = z.object({
  step: z.enum(SETUP_STEPS),
  touched: z.array(z.string().max(40)).max(40).default([]),
  answers: z.object({
    thesis:text, buyerType:text, firmName:text, website:text, teamSize:text,
    geographyNotes:text, currency:text, otherCriteria:z.string().max(240), extraExclusions:text,
    timeline:text, fundingStage:text, ownerTransition:text, dealVolume:text, firstFocus:text, searchName:text,
    sectorsInclude:list, geographies:list, features:list, hardExclusions:list, transactionTypes:list, sources:list,
    sectorOpen:z.boolean(), locationFlexible:z.boolean(), sizeFlexible:z.boolean(),
    revenueMin:amount, revenueMax:amount, ebitdaMin:amount, ebitdaMax:amount, dealSizeMin:amount, dealSizeMax:amount,
  }),
});
export type SearchDraft = z.infer<typeof searchDraftSchema>;
export interface SearchSetup { status: 'draft' | 'skipped' | 'complete'; draft: SearchDraft | null; updatedAt: string }
export function readSearchSetup(settings: Record<string, unknown>): SearchSetup | null {
  const raw = settings.searchSetup as SearchSetup | undefined;
  if (!raw || !['draft','skipped','complete'].includes(raw.status)) return null;
  const draft = searchDraftSchema.safeParse(raw.draft);
  return { status:raw.status, draft:draft.success?draft.data:null, updatedAt:raw.updatedAt };
}
export function buildSearchDraft(settings: Record<string, unknown>, draft: SearchDraft, skip: boolean) {
  const previous = readSearchSetup(settings);
  if (previous?.status === 'complete') throw new ConflictError('Search setup is already complete. Reload to edit your saved profile.');
  return { ...settings, searchSetup: { status: skip || previous?.status === 'skipped' ? 'skipped' : 'draft', draft, updatedAt:new Date().toISOString() } };
}
