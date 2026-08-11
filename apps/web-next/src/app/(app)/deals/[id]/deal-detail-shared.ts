// ---------------------------------------------------------------------------
// Deal-detail shared types + constants.
//
// This is a LEAF module: pure types and static data, no React components and
// no "use client". Every sub-component of the deal-detail page imports its
import type { DealScorecard } from "@/types";
// types/constants from here instead of from the `components.tsx` barrel.
//
// Why this file exists: `components.tsx` re-exports the page's sub-components
// AND used to define these shared types/constants. When a sub-component
// imported a type/constant back from the barrel, it created an import cycle
// (barrel → sub-component → barrel). Those cycles type-check clean and usually
// work in dev, but Next's production bundler can evaluate the modules in an
// order where a re-exported component resolves to `undefined` — surfacing as a
// minified React error #130 ("element type is invalid: got undefined") only in
// production. Hoisting the shared surface into this leaf breaks every cycle.
// ---------------------------------------------------------------------------

export interface AssignedUser {
  id: string;
  name: string;
  avatar?: string;
  email?: string;
  title?: string;
}

export interface DealDetail {
  id: string;
  name: string;
  companyName?: string;
  stage: string;
  industry?: string;
  dealSize?: number;
  currency?: string;
  revenue?: number;
  ebitda?: number;
  irrProjected?: number;
  mom?: number;
  targetReturn?: number;
  evMultiple?: number;
  priority?: string;
  status?: string;
  aiThesis?: string;
  aiRisks?: { keyRisks?: string[]; investmentHighlights?: string[] };
  description?: string;
  assignee?: string;
  assignedUser?: AssignedUser | null;
  company?: { name?: string } | null;
  source?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  documents?: DocItem[];
  team?: TeamMember[];
  scorecard?: DealScorecard | null;
  activities?: Activity[];
  // Phase 2 canonical cache: latest-period revenue/EBITDA in ACTUAL
  // DOLLARS (unitScale already applied by the API). Refreshed on every
  // FinancialStatement upsert by the extraction pipeline. Use these
  // instead of `revenue` / `ebitda` (the legacy MILLIONS-only fields)
  // when rendering deal headlines. Null until the extraction pipeline
  // or backfill script populates them. Mirrors the same fields on Deal
  // in src/types/index.ts.
  cachedRevenue?: number | null;
  cachedEbitda?: number | null;
  cachedEbitdaMargin?: number | null;
  cachedPeriod?: string | null;
  cachedCurrency?: string | null;
  cachedAt?: string | null;
  /** Raw HubSpot properties kept verbatim by the importer; null for non-imported deals. */
  hubspotProperties?: Record<string, string | null> | null;
}

export interface DocItem {
  id: string;
  name: string;
  type?: string;
  fileSize?: number;
  fileUrl?: string;
  aiAnalysis?: string;
  createdAt: string;
  url?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  role?: string;
}

export interface ChatAction {
  type: string;
  label: string;
  description?: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  action?: ChatAction;
  /** True while this assistant message is still streaming in (deal chat SSE). */
  streaming?: boolean;
}

export interface Activity {
  id: string;
  type?: string;
  action: string;
  title?: string;
  description?: string;
  userName?: string;
  user?: { name?: string };
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stage pipeline config (matches the constants used in the old app)
// ---------------------------------------------------------------------------

// Matches the Deal.stage zod enum in apps/api/src/routes/deals.ts:54-56:
// INITIAL_REVIEW / DUE_DILIGENCE / IOI_SUBMITTED / LOI_SUBMITTED /
// NEGOTIATION / CLOSING / PASSED / CLOSED_WON / CLOSED_LOST.
// The visible pipeline is the 6 in-flight stages; terminal states
// (PASSED / CLOSED_WON / CLOSED_LOST) render as final and disable stage
// changes in StageChangeModal.
export const PIPELINE_STAGES = [
  { key: "INITIAL_REVIEW", label: "Initial Review", icon: "search" },
  { key: "DUE_DILIGENCE", label: "Due Diligence", icon: "fact_check" },
  { key: "IOI_SUBMITTED", label: "IOI Submitted", icon: "description" },
  { key: "LOI_SUBMITTED", label: "LOI Submitted", icon: "verified" },
  { key: "NEGOTIATION", label: "Negotiation", icon: "handshake" },
  { key: "CLOSING", label: "Closing", icon: "gavel" },
];

export const TERMINAL_STAGES = ["PASSED", "CLOSED_WON", "CLOSED_LOST"];

export const TABS = ["Overview", "Documents", "Activity", "Teaser"] as const;
export type Tab = (typeof TABS)[number];
