// ─── Contact Enrichment Agent — State Schema & Types ────────────────
// Shared LangGraph state annotation + helpers used across all nodes.

import { Annotation } from '@langchain/langgraph';

// ─── State Schema ──────────────────────────────────────────────────

export const EnrichmentState = Annotation.Root({
  contactId: Annotation<string>,
  organizationId: Annotation<string>,
  firstName: Annotation<string>,
  lastName: Annotation<string>,
  email: Annotation<string | null>,
  company: Annotation<string | null>,
  title: Annotation<string | null>,
  // CRM data found
  crmContext: Annotation<string>,
  emailAnalysis: Annotation<Record<string, any>>,
  linkedDeals: Annotation<Array<{ name: string; stage: string; industry: string }>>,
  documentMentions: Annotation<string[]>,
  // Enrichment results
  enrichedData: Annotation<Record<string, any>>,
  confidence: Annotation<number>,
  sources: Annotation<string[]>,
  // Status
  status: Annotation<string>,
  error: Annotation<string | null>,
  needsReview: Annotation<boolean>,
  steps: Annotation<Array<{ timestamp: string; node: string; message: string }>>,
});

// ─── Known corporate email domains ──────────────────────────────────

export const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'protonmail.com',
  'mail.com', 'zoho.com', 'yandex.com', 'gmx.com', 'inbox.com',
]);

// ─── Public input/output types ─────────────────────────────────────

export interface EnrichmentInput {
  contactId: string;
  organizationId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  company?: string | null;
  title?: string | null;
}

export interface EnrichmentResult {
  status: 'completed' | 'needs_review' | 'failed';
  enrichedData: Record<string, any>;
  confidence: number;
  needsReview: boolean;
  sources: string[];
  steps: Array<{ timestamp: string; node: string; message: string }>;
  error?: string | null;
  // SUGGESTION ONLY — the agent never writes followUpAt. Null when no contact data.
  suggestedFollowUp: { date?: string; action?: string } | null;
}
