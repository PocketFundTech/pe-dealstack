// Shared types + display config for the Cicero Capital Outreach Kanban board
// (apps/web-next/src/app/(app)/outreach/page.tsx and this directory).
//
// Backend contract (built in parallel under apps/api/, mounted at /api/outreach):
//   GET    /outreach/stages                -> OutreachStage[]
//   GET    /outreach/contacts              -> OutreachContact[]
//   POST   /outreach/contacts              -> OutreachContact
//   PATCH  /outreach/contacts/:id          -> OutreachContact
//   DELETE /outreach/contacts/:id          -> 204 No Content
//   POST   /outreach/contacts/:id/enrich   -> OutreachContact | EnrichNotRunResult
//     (no enrichment provider configured yet -> { enriched: false, reason })
//   POST   /outreach/sync-replies          -> SyncRepliesResult
//     (no request body; on-demand pull-based check, not a webhook)
//     (no Reply.io provider configured yet -> { checked: 0, newReplies: 0,
//      flaggedForReview: 0, reason } -- confirmed against the actual
//      backend response, not the enrich endpoint's { enriched: false }
//      shape this was originally guessed to match)
//   POST   /outreach/import/private-circle -> PrivateCircleImportResult
//     (multipart file upload — a CSV export from Private Circle — built in
//      parallel under apps/api/; goes through authFetchRaw, not api.post,
//      per the multipart convention in deal-intake/components.tsx)

export interface OutreachStage {
  id: string;
  name: string;
  position: number;
}

export type OutreachChannel = "proprietary" | "broker";

/** Claude's read on a reply's intent — set by the backend when
 *  POST /outreach/sync-replies finds a new reply for a contact. */
export type ReplyIntent =
  | "interested"
  | "not_interested"
  | "meeting_request"
  | "out_of_office"
  | "unclear";

export interface OutreachContact {
  id: string;
  stageId: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  channel: OutreachChannel;
  notes: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Enrichment fields — populated once a Clay/Apollo/Anymail provider is configured. */
  title?: string | null;
  linkedinUrl?: string | null;
  enrichedAt?: string | null;
  enrichmentSource?: string[];
  enrichmentData?: Record<string, unknown> | null;
  /** Reply.io sync + Claude intent-classification fields — set by the backend
   *  when POST /outreach/sync-replies finds a new reply for this contact.
   *  `needsReview` is true whenever Claude wasn't confident in the intent
   *  read; a human resolves it (see ContactFormModal's "Mark reviewed"). */
  needsReview: boolean;
  replyIntent: ReplyIntent | null;
  /** Full text of the most recent reply, if any. Not explicitly listed in the
   *  backend contract handed off for this feature (only `needsReview` /
   *  `replyIntent` were) — surfaced here so a human resolving a flagged
   *  contact can read what the reply said; confirm the field name with the
   *  backend agent once /outreach/sync-replies lands. */
  lastReplyText?: string | null;
  /** Where this contact's record originated. `null` covers contacts created
   *  before this field existed. Distinct from `enrichmentSource` (which
   *  providers enriched the record) — this is about the *source of the row
   *  itself*. */
  sourceProvider: "clay" | "private_circle" | "manual" | null;
  /** True when the Private Circle CSV importer's duplicate-detection flagged
   *  this contact as a possible match against an existing company/contact
   *  during bulk import. Entirely distinct from `needsReview` (which is
   *  about reply-intent classification) — this is a bulk-import data-quality
   *  concern, so it gets its own badge/treatment rather than reusing the
   *  amber "Needs review" one. A human clears it via "Confirm as new
   *  contact" once they've checked it isn't actually a duplicate; merging
   *  duplicate records is explicitly out of scope here. */
  needsMatchReview: boolean;
  /** Human-readable explanation of why `needsMatchReview` was set, e.g.
   *  "Possible duplicate of existing contact Jane Smith at Acme Holdings". */
  matchReviewReason: string | null;
  /** Corporate Identification Number — populated by the Private Circle
   *  importer when the source CSV includes it. Read-only in the UI. */
  cin: string | null;
}

/** Editable fields for the create/edit form (all strings for controlled inputs). */
export interface OutreachContactFormValues {
  name: string;
  stageId: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  channel: OutreachChannel;
  notes: string;
}

/** `POST /outreach/contacts/:id/enrich` when no provider is configured yet — the
 *  expected/normal state right now, not an error. */
export interface EnrichNotRunResult {
  enriched: false;
  reason: string;
}

/** The enrich endpoint returns either the updated contact directly (at least one
 *  provider ran) or an `{ enriched: false, reason }` explainer. */
export type EnrichContactResult = OutreachContact | EnrichNotRunResult;

/** `POST /outreach/sync-replies` on success — a manual "check for new
 *  replies" action across the whole board, not per-contact. */
export interface SyncRepliesSummary {
  checked: number;
  newReplies: number;
  flaggedForReview: number;
}

/** `POST /outreach/sync-replies` when no Reply.io connection is configured
 *  yet. Confirmed against the actual backend: unlike the enrich endpoint's
 *  `{ enriched: false, reason }`, this still returns the summary fields
 *  (all zero) alongside `reason` rather than a boolean flag — `"reason" in
 *  result` is the correct discriminator, not a `synced`/`enriched` field. */
export interface SyncRepliesNotRunResult {
  checked: 0;
  newReplies: 0;
  flaggedForReview: 0;
  reason: string;
}

export type SyncRepliesResult = SyncRepliesSummary | SyncRepliesNotRunResult;

/** `POST /outreach/import/private-circle` response — a bulk CSV import, not
 *  a single-contact mutation. `received` is the row count parsed from the
 *  CSV; `created`/`updated` are how those rows were reconciled against
 *  existing contacts; `flaggedForReview` is how many tripped the
 *  duplicate-detection heuristic (`needsMatchReview`); `enriched` is how
 *  many got enrichment data attached during the same pass. */
export interface PrivateCircleImportResult {
  received: number;
  created: number;
  updated: number;
  flaggedForReview: number;
  enriched: number;
}

export const OUTREACH_CHANNELS: OutreachChannel[] = ["proprietary", "broker"];

export const REPLY_INTENTS: ReplyIntent[] = [
  "interested",
  "meeting_request",
  "out_of_office",
  "not_interested",
  "unclear",
];

/** Humanized label + badge palette per reply intent. Positive-leaning
 *  outcomes (interested / meeting request) read green, out-of-office is a
 *  neutral/muted grey, and not-interested / unclear use a muted grey-red so
 *  they don't compete visually with the amber "Needs review" badge. */
export const REPLY_INTENT_CONFIG: Record<
  ReplyIntent,
  { label: string; bg: string; text: string; border: string }
> = {
  interested: { label: "Interested", bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  meeting_request: {
    label: "Meeting request",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
  out_of_office: { label: "Out of office", bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
  not_interested: { label: "Not interested", bg: "bg-red-50", text: "text-red-600", border: "border-red-200" },
  unclear: { label: "Unclear", bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
};

export const CHANNEL_CONFIG: Record<
  OutreachChannel,
  { label: string; bg: string; text: string; border: string }
> = {
  proprietary: { label: "Proprietary", bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  broker: { label: "Broker", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
};

/** Humanized label + icon for the two importer-driven `sourceProvider`
 *  values. Deliberately excludes `manual` and `null` — those are the
 *  default/expected state (a human-entered contact) and aren't worth a
 *  badge; `clay` and `private_circle` are the ones worth a small
 *  provenance note. Kept as a muted informational label, not a colored
 *  pill — much lower visual weight than the needsReview / needsMatchReview
 *  / enriched badges. */
export const SOURCE_PROVIDER_CONFIG: Partial<Record<NonNullable<OutreachContact["sourceProvider"]>, { label: string; icon: string }>> = {
  clay: { label: "via Clay", icon: "bolt" },
  private_circle: { label: "via Private Circle", icon: "table_view" },
};

export function sortStagesByPosition(stages: OutreachStage[]): OutreachStage[] {
  return [...stages].sort((a, b) => a.position - b.position);
}

export function emptyContactForm(stageId: string): OutreachContactFormValues {
  return {
    name: "",
    stageId,
    company: "",
    title: "",
    email: "",
    phone: "",
    linkedinUrl: "",
    channel: "proprietary",
    notes: "",
  };
}

export function contactToFormValues(contact: OutreachContact): OutreachContactFormValues {
  return {
    name: contact.name,
    stageId: contact.stageId,
    company: contact.company || "",
    title: contact.title || "",
    email: contact.email || "",
    phone: contact.phone || "",
    linkedinUrl: contact.linkedinUrl || "",
    channel: contact.channel,
    notes: contact.notes || "",
  };
}
