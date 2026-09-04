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
//   POST   /outreach/import/private-circle -> CsvImportResult
//   POST   /outreach/import/clay-csv       -> CsvImportResult
//     (multipart file upload — a CSV export from Private Circle or Clay,
//      Clay's real-time webhook push being gated behind a paid plan
//      upgrade — both share the same response shape, same shared engine
//      server-side (services/outreachCsvImport.ts); goes through
//      authFetchRaw, not api.post, per the multipart convention in
//      deal-intake/components.tsx — see CsvImportButton.tsx)
//   GET    /outreach/campaigns             -> ListCampaignsResult
//     (no Reply.io provider configured yet -> { configured: false,
//      campaigns: [], reason } — same "not run yet" idiom as enrich/
//      sync-replies, not an error)
//   POST   /outreach/contacts/:id/send     -> OutreachContact | SendNotRunResult
//     (body: { campaignId }. Enrolls the contact in a live Reply.io
//      sequence — this is a REAL, outward-facing action once Reply.io is
//      configured, not a dry run. Requires the contact to have an email;
//      SendConfirmModal filters ineligible contacts out client-side before
//      ever calling this, and shows the split so nothing is silently
//      dropped.)

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

/** One Reply.io sequence/campaign, as listed by `GET /outreach/campaigns`
 *  (apps/api/src/services/replyIoService.ts's ReplyIoCampaign). `id` is
 *  numeric on Reply.io's side but travels as a string once it's a
 *  campaignId elsewhere (the send endpoint's zod schema, the <select>
 *  value) — kept numeric here to match the list response exactly. */
export interface ReplyIoCampaign {
  id: number;
  name: string;
  status: string;
}

/** `GET /outreach/campaigns` response shape. `configured: false` is the
 *  expected/normal state until REPLY_IO_API_KEY is set — same idiom as
 *  EnrichNotRunResult/SyncRepliesNotRunResult above. `error` (configured
 *  true, live call failed) is distinct from that and worth surfacing
 *  differently — a real upstream problem, not "not set up yet". */
export interface ListCampaignsResult {
  configured: boolean;
  campaigns: ReplyIoCampaign[];
  reason?: string;
  error?: string;
}

/** `POST /outreach/contacts/:id/send` when Reply.io isn't configured yet —
 *  same "not run" idiom as EnrichNotRunResult. A contact missing an email
 *  (the common case for Private Circle/Clay-imported rows) is filtered out
 *  client-side by SendConfirmModal before this endpoint is ever called, so
 *  that specific failure reason shouldn't normally reach this type — kept
 *  here anyway since the backend can still return it (e.g. a race where the
 *  email was cleared between load and send). */
export interface SendNotRunResult {
  sent: false;
  reason: string;
}

/** The send endpoint returns either the updated contact (enrolled in the
 *  campaign for real) or a `{ sent: false, reason }` explainer. */
export type SendContactResult = OutreachContact | SendNotRunResult;

/** `POST /outreach/import/private-circle` response — a bulk CSV import, not
 *  a single-contact mutation. `received` is the row count parsed from the
 *  file; `created`/`updated` are how those rows were reconciled against
 *  existing contacts; `flaggedForReview` is how many tripped the
 *  duplicate-detection heuristic (`needsMatchReview`); `unmappable` is how
 *  many rows had no resolvable company-name column at all (dropped before
 *  de-dupe — a nonzero value here almost always means the column-header
 *  mapping doesn't match this export's actual headers); `enriched` is how
 *  many got enrichment data attached during the same pass. Shared by both
 *  the Private Circle and Clay CSV import endpoints — same shape either
 *  way, per services/outreachCsvImport.ts's shared engine server-side. */
export interface CsvImportResult {
  received: number;
  created: number;
  updated: number;
  flaggedForReview: number;
  unmappable: number;
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

/** One enrichment provider's attempt on this contact, as recorded in
 *  `OutreachContact.enrichmentData[providerKey]` — written by
 *  apps/api/src/services/outreachEnrichment.ts's `enrichContact()`.
 *  `enrichmentData` itself is typed as loosely as the API returns it
 *  (`Record<string, unknown> | null`); this describes the shape of one
 *  entry once a caller has checked it looks like one. */
export interface EnrichmentProviderRecord {
  status: "ok" | "no_match" | "submitted" | "error" | "skipped" | "no_person";
  fetchedAt: string;
  normalized?: Record<string, unknown>;
  error?: string;
}

export type EnrichmentProviderKey = "apollo" | "anymailFinder" | "clay";

/** Humanized label + one-line explanation per enrichment provider status —
 *  used by the contact detail popup's enrichment log, so "no_person" (this
 *  contact has no real decision-maker name, e.g. a company-only Private
 *  Circle/Clay import row — see looksLikeCompanyNameOnly in
 *  outreachEnrichment.ts) reads as an explained skip, not a silent gap. */
export const ENRICHMENT_STATUS_CONFIG: Record<
  EnrichmentProviderRecord["status"],
  { label: string; description: string; bg: string; text: string; border: string }
> = {
  ok: {
    label: "Matched",
    description: "Found and filled in new data.",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
  no_match: {
    label: "No match",
    description: "Ran, but didn't find a match for this contact.",
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-200",
  },
  no_person: {
    label: "Skipped",
    description: "No real decision-maker name to search for (company-only import row).",
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-200",
  },
  submitted: {
    label: "Submitted",
    description: "Sent to Clay's async enrichment queue — results arrive on Clay's own schedule.",
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
  },
  error: {
    label: "Error",
    description: "The provider call failed.",
    bg: "bg-red-50",
    text: "text-red-600",
    border: "border-red-200",
  },
  skipped: {
    label: "Not configured",
    description: "This provider's API key isn't set up yet.",
    bg: "bg-gray-100",
    text: "text-gray-500",
    border: "border-gray-200",
  },
};

export const ENRICHMENT_PROVIDER_LABELS: Record<EnrichmentProviderKey, string> = {
  apollo: "Apollo",
  anymailFinder: "Anymail Finder",
  clay: "Clay",
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
