// ─── Memo route validation schemas + section-type mapping ──────────
// Shared by memos-list / memos-mutate / memos-generate sub-routers.

import { z } from 'zod';

export const createMemoSchema = z.object({
  title: z.string().min(1),
  projectName: z.string().optional(),
  // dealId is REQUIRED on create — the AI generation pipeline (generate-all,
  // chat agent) needs a bound deal to source context, and a memo with no
  // deal strands the user on the MEMO_MISSING_DEAL 400 path. The frontend
  // CreateMemoModal also enforces this client-side; this guard catches
  // bypass attempts via curl, the API explorer, or stale/older clients.
  dealId: z.string().uuid({ message: 'A valid dealId is required to create a memo' }),
  templateId: z.string().uuid().optional(),
  type: z.enum(['IC_MEMO', 'TEASER', 'SUMMARY', 'CUSTOM']).default('IC_MEMO'),
  status: z.enum(['DRAFT', 'REVIEW', 'FINAL', 'ARCHIVED']).default('DRAFT'),
  sponsor: z.string().optional(),
  memoDate: z.string().optional(),
  autoGenerate: z.boolean().optional().default(false),
  templatePreset: z.enum(['comprehensive', 'standard', 'search_fund', 'screening']).optional(),
  metadata: z.record(z.any()).optional(),
});

export const updateMemoSchema = createMemoSchema.partial();

export const memosQuerySchema = z.object({
  dealId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'REVIEW', 'FINAL', 'ARCHIVED']).optional(),
  type: z.enum(['IC_MEMO', 'TEASER', 'SUMMARY', 'CUSTOM']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Map template section titles to memo section types
export const SECTION_TYPE_MAP: Record<string, string> = {
  'executive summary': 'EXECUTIVE_SUMMARY',
  'company overview': 'COMPANY_OVERVIEW',
  'business overview': 'COMPANY_OVERVIEW',
  'financial performance': 'FINANCIAL_PERFORMANCE',
  'financial analysis': 'FINANCIAL_PERFORMANCE',
  'market analysis': 'MARKET_DYNAMICS',
  'market dynamics': 'MARKET_DYNAMICS',
  'competitive landscape': 'COMPETITIVE_LANDSCAPE',
  'risk assessment': 'RISK_ASSESSMENT',
  'deal structure': 'DEAL_STRUCTURE',
  'valuation': 'DEAL_STRUCTURE',
  'value creation': 'VALUE_CREATION',
  'exit strategy': 'EXIT_STRATEGY',
  'recommendation': 'RECOMMENDATION',
  'appendix': 'APPENDIX',
  'unit economics': 'FINANCIAL_PERFORMANCE',
  'brand analysis': 'COMPANY_OVERVIEW',
  'quality of earnings': 'FINANCIAL_PERFORMANCE',
  'management assessment': 'CUSTOM',
  'operational deep dive': 'CUSTOM',
  'value creation plan': 'VALUE_CREATION',
  'exit analysis': 'EXIT_STRATEGY',
  'strategic rationale': 'EXECUTIVE_SUMMARY',
  'situation overview': 'EXECUTIVE_SUMMARY',
  'turnaround plan': 'VALUE_CREATION',
};

// Normalize a memoAgent generator section type (its own SectionType enum)
// to the DB CHECK constraint's type set — the same remapping SECTION_TYPE_MAP
// above applies to template section titles, but keyed by the generator's
// type instead of a title string. Several generator types collapse onto a
// DB type shared with other generator types (both MANAGEMENT_ASSESSMENT and
// OPERATIONAL_DEEP_DIVE store as CUSTOM), so callers matching a generated
// section back to an existing MemoSection row must normalize through this
// BEFORE comparing types, and disambiguate CUSTOM rows by title (see
// `memoSectionKey`) — matching on the raw generator type, or on type alone
// for CUSTOM, caused duplicate/misdirected section rows (QA 2026-10-06 #16b).
export const GENERATOR_TYPE_TO_DB_TYPE: Record<string, string> = {
  'EXIT_ANALYSIS': 'EXIT_STRATEGY',
  'VALUE_CREATION_PLAN': 'VALUE_CREATION',
  'QUALITY_OF_EARNINGS': 'FINANCIAL_PERFORMANCE',
  'MANAGEMENT_ASSESSMENT': 'CUSTOM',
  'OPERATIONAL_DEEP_DIVE': 'CUSTOM',
};

/** Match key for a MemoSection: CUSTOM rows are ambiguous on type alone, so title disambiguates. */
export function memoSectionKey(type: string, title: string): string {
  return type === 'CUSTOM' ? `CUSTOM:${title}` : type;
}
