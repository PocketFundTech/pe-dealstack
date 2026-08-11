import type { GraphEvent } from './types.js';

export interface Microsoft365IntegrationActivityRow {
  integrationId: string;
  organizationId: string;
  userId: string;
  source: 'microsoft365';
  externalId: string;
  type: 'CALENDAR_EVENT';
  dealIds: string[];
  contactIds: string[];
  title: string;
  summary: string;
  occurredAt: string;
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
  aiExtraction: null;
  rawTranscript: string;
}

// Graph returns naive datetimes (no offset) in `start.dateTime` with a
// separate `timeZone`. The window we query is built in UTC and we request
// without a timezone-shifting Prefer header, so Graph returns UTC — append Z
// to parse correctly.
function parseGraphDateTime(dt: { dateTime?: string; timeZone?: string } | undefined): number | null {
  if (!dt?.dateTime) return null;
  const raw = dt.dateTime;
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw);
  const t = Date.parse(hasZone ? raw : `${raw}Z`);
  return Number.isFinite(t) ? t : null;
}

export function extractAttendeeEmails(event: GraphEvent): string[] {
  const out: string[] = [];
  const organizer = event.organizer?.emailAddress?.address;
  if (organizer) out.push(organizer.trim().toLowerCase());
  for (const a of event.attendees ?? []) {
    const addr = a.emailAddress?.address;
    if (addr) out.push(addr.trim().toLowerCase());
  }
  return out;
}

export function calendarEventToIntegrationActivity(params: {
  event: GraphEvent;
  integrationId: string;
  organizationId: string;
  userId: string;
  dealIds: string[];
  contactIds: string[];
}): Microsoft365IntegrationActivityRow {
  const { event, integrationId, organizationId, userId, dealIds, contactIds } = params;
  const startMs = parseGraphDateTime(event.start);
  const endMs = parseGraphDateTime(event.end);
  const durationSeconds =
    startMs != null && endMs != null && endMs > startMs
      ? Math.round((endMs - startMs) / 1000)
      : null;

  return {
    integrationId,
    organizationId,
    userId,
    source: 'microsoft365',
    externalId: event.id,
    type: 'CALENDAR_EVENT',
    dealIds,
    contactIds,
    title: event.subject || '(no title)',
    summary: event.bodyPreview ?? '',
    occurredAt: startMs != null ? new Date(startMs).toISOString() : new Date().toISOString(),
    durationSeconds,
    metadata: {
      isCancelled: event.isCancelled ?? false,
      organizer: event.organizer?.emailAddress ?? null,
      attendees: (event.attendees ?? []).map((a) => a.emailAddress ?? null).filter(Boolean),
      webLink: event.webLink ?? null,
      onlineMeetingUrl: event.onlineMeetingUrl ?? null,
    },
    aiExtraction: null,
    rawTranscript: '',
  };
}
