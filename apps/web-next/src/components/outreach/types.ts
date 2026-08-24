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

export interface OutreachStage {
  id: string;
  name: string;
  position: number;
}

export type OutreachChannel = "proprietary" | "broker";

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

export const OUTREACH_CHANNELS: OutreachChannel[] = ["proprietary", "broker"];

export const CHANNEL_CONFIG: Record<
  OutreachChannel,
  { label: string; bg: string; text: string; border: string }
> = {
  proprietary: { label: "Proprietary", bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  broker: { label: "Broker", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
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
