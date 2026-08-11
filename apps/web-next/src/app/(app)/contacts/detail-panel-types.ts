// Shared types, constants and small helpers for the contact DetailPanel and its
// sub-components. Extracted from detail-panel.tsx (pure refactor, no behaviour
// change) so each module stays under the 500-line frontend file limit.

export const INTERACTION_ICONS: Record<string, string> = {
  NOTE: "edit_note", MEETING: "groups", CALL: "call", EMAIL: "mail", OTHER: "more_horiz",
};

export const STAGE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  INITIAL_REVIEW: { bg: "bg-blue-50", text: "text-blue-700", label: "Initial Review" },
  DUE_DILIGENCE:  { bg: "bg-blue-50", text: "text-primary", label: "Due Diligence" },
  IOI_SUBMITTED:  { bg: "bg-amber-50", text: "text-amber-700", label: "IOI Submitted" },
  LOI_SUBMITTED:  { bg: "bg-purple-50", text: "text-purple-700", label: "LOI Submitted" },
  NEGOTIATION:    { bg: "bg-orange-50", text: "text-orange-700", label: "Negotiation" },
  CLOSING:        { bg: "bg-teal-50", text: "text-teal-700", label: "Closing" },
  PASSED:         { bg: "bg-gray-100", text: "text-gray-600", label: "Passed" },
  CLOSED_WON:     { bg: "bg-green-50", text: "text-green-700", label: "Closed Won" },
  CLOSED_LOST:    { bg: "bg-red-50", text: "text-red-700", label: "Closed Lost" },
};

export const RELATIONSHIP_TYPE_CONFIG: Record<string, { label: string; icon: string; bg: string; text: string }> = {
  KNOWS:         { label: "Knows",         icon: "handshake",    bg: "bg-blue-100",    text: "text-blue-700" },
  REFERRED_BY:   { label: "Referred by",   icon: "share",        bg: "bg-purple-100",  text: "text-purple-700" },
  REPORTS_TO:    { label: "Reports to",    icon: "account_tree", bg: "bg-amber-100",   text: "text-amber-700" },
  COLLEAGUE:     { label: "Colleague",     icon: "group",        bg: "bg-emerald-100", text: "text-emerald-700" },
  INTRODUCED_BY: { label: "Introduced by", icon: "person_add",   bg: "bg-pink-100",    text: "text-pink-700" },
};

export interface Connection {
  id: string;
  type: string;
  notes?: string;
  contact: { id: string; firstName: string; lastName: string; type: string; company?: string; title?: string };
}

export interface EnrichmentSuggestedFollowUp {
  date?: string;
  action?: string;
}

export interface ContactEnrichment {
  summary?: string;
  insights?: string[];
  suggestedTags?: string[];
  suggestedFollowUp?: EnrichmentSuggestedFollowUp | null;
  [key: string]: unknown;
}

// Response of POST /ai/suggest-follow-up — a single lightweight LLM call.
export interface FollowUpSuggestion {
  date: string;
  action: string;
  reasoning: string;
}

// Abort the suggestion fetch if it outruns this — the single LLM call should be
// quick; beyond this we stop the spinner and offer a retry instead of hanging.
export const SUGGEST_FOLLOW_UP_TIMEOUT_MS = 10_000;

// followUpNote is capped server-side (PATCH /contacts validator) — mirror it
// here so the applied suggestion text never gets rejected for length.
export const FOLLOW_UP_NOTE_MAX_LEN = 500;

// Returns true when a follow-up date is in the past (date-only comparison).
export function isFollowUpOverdue(followUpAt?: string | null): boolean {
  if (!followUpAt) return false;
  const due = new Date(followUpAt);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

// Normalises an ISO/string date into a yyyy-mm-dd value for <input type="date">.
export function toDateInputValue(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().split("T")[0];
}
