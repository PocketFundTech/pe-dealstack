"use client";

import { STAGE_LABELS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Deal {
  id: string;
  name: string;
  stage: string;
  dealSize?: number;
  currency?: string;
  updatedAt: string;
  createdAt?: string;
  nextAction?: string;
  industry?: string;
  priority?: string;
  status?: string;
  assignedUser?: { id?: string; name?: string; email?: string };
  teamMembers?: Array<{ userId?: string; user?: { id?: string; name?: string; email?: string } }>;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  priority?: string;
  dueDate?: string;
  category?: string;
  dealId?: string;
  dealName?: string;
  assignedTo?: string | null;
  deal?: { id?: string; name?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Position of each stage along the deal lifecycle (1–5), drawn as the tick
// scale in the priorities table. Unknown stages render no ticks.
const STAGE_STEP: Record<string, number> = {
  SOURCING: 1,
  INITIAL_REVIEW: 1,
  DUE_DILIGENCE: 2,
  IOI_SUBMITTED: 3,
  LOI_SUBMITTED: 3,
  LOI_OFFER: 3,
  NEGOTIATION: 4,
  CLOSING: 4,
  CLOSED_WON: 5,
};
export const STAGE_STEP_COUNT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Human label for a stage, falling back to "Loi Offer"-style casing for
 *  legacy enum values missing from STAGE_LABELS. */
export function stageLabel(stage: string): string {
  if (STAGE_LABELS[stage]) return STAGE_LABELS[stage];
  return stage
    .toLowerCase()
    .split("_")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function stageStep(stage: string): number {
  return STAGE_STEP[stage] ?? 0;
}

// ---------------------------------------------------------------------------
// fmtNextAction — stage-based fallback for Next Action column
// Matches legacy dashboard.js fmtNextAction()
// ---------------------------------------------------------------------------

export function fmtNextAction(stage: string): string {
  switch (stage) {
    case "SOURCING":
      return "Initial review";
    case "INITIAL_REVIEW":
      return "Schedule mgmt call";
    case "DUE_DILIGENCE":
      return "Complete QoE analysis";
    case "LOI_OFFER":
    case "IOI_SUBMITTED":
    case "LOI_SUBMITTED":
      return "Negotiate terms";
    case "CLOSED_WON":
    case "CLOSING":
      return "Onboard portfolio co";
    default:
      return "Review deal";
  }
}
