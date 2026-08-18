// ─── Deal route validation schemas ─────────────────────────────────
// Shared by deals-list.ts and deals-mutate.ts.

import { z } from 'zod';

// Validation schemas
export const createDealSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().optional(),
  companyName: z.string().optional(),
  stage: z.string().default('INITIAL_REVIEW'),
  status: z.string().default('ACTIVE'),
  irrProjected: z.number().nullable().optional(),
  mom: z.number().nullable().optional(),
  ebitda: z.number().nullable().optional(),
  revenue: z.number().nullable().optional(),
  industry: z.string().nullable().optional(),
  dealSize: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  aiThesis: z.string().nullable().optional(),
  icon: z.string().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().default('MEDIUM'),
  tags: z.array(z.string()).optional(),
  targetCloseDate: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  currency: z.string().optional().default('USD'),
  customFields: z.record(z.string(), z.any()).optional().default({}),
  // Dormant-deal context (see services/agents/dealReactivation). A pass is
  // not a dead end: the reason and the revisit date are what let a deal
  // wake up months later with the thinking still attached.
  passReason: z.string().max(1000).nullable().optional(),
  revisitAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const updateDealSchema = createDealSchema.partial();

// Query parameter schemas
export const dealsQuerySchema = z.object({
  stage: z.enum(['INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED',
    'LOI_SUBMITTED', 'NEGOTIATION', 'CLOSING', 'PASSED',
    'CLOSED_WON', 'CLOSED_LOST']).optional(),
  status: z.enum(['ACTIVE', 'PROCESSING', 'PASSED', 'ARCHIVED']).optional(),
  industry: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'dealSize', 'irrProjected', 'revenue', 'ebitda', 'name', 'priority']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  minDealSize: z.coerce.number().positive().optional(),
  maxDealSize: z.coerce.number().positive().optional(),
  assignedTo: z.string().uuid().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
});
