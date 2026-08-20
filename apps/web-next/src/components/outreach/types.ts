// Shared types + display config for the Cicero Capital Outreach Kanban board
// (apps/web-next/src/app/(app)/outreach/page.tsx and this directory).
//
// Backend contract (built in parallel under apps/api/, mounted at /api/outreach):
//   GET    /outreach/stages             -> OutreachStage[]
//   GET    /outreach/contacts           -> OutreachContact[]
//   POST   /outreach/contacts           -> OutreachContact
//   PATCH  /outreach/contacts/:id       -> OutreachContact
//   DELETE /outreach/contacts/:id       -> 204 No Content

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
}

/** Editable fields for the create/edit form (all strings for controlled inputs). */
export interface OutreachContactFormValues {
  name: string;
  stageId: string;
  company: string;
  email: string;
  phone: string;
  channel: OutreachChannel;
  notes: string;
}

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
  return { name: "", stageId, company: "", email: "", phone: "", channel: "proprietary", notes: "" };
}

export function contactToFormValues(contact: OutreachContact): OutreachContactFormValues {
  return {
    name: contact.name,
    stageId: contact.stageId,
    company: contact.company || "",
    email: contact.email || "",
    phone: contact.phone || "",
    channel: contact.channel,
    notes: contact.notes || "",
  };
}
