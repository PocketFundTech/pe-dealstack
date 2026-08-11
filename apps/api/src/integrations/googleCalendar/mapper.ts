import type { GoogleCalendarEvent } from './types.js';

export interface CalendarIntegrationActivityRow {
  integrationId: string;
  organizationId: string;
  userId: string;
  source: 'google_calendar';
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

function startIso(event: GoogleCalendarEvent): string {
  if (event.start?.dateTime) {
    return new Date(event.start.dateTime).toISOString();
  }
  if (event.start?.date) {
    return new Date(event.start.date).toISOString();
  }
  return new Date().toISOString();
}

function durationSeconds(event: GoogleCalendarEvent): number | null {
  const startStr = event.start?.dateTime ?? event.start?.date;
  const endStr = event.end?.dateTime ?? event.end?.date;
  if (!startStr || !endStr) return null;
  const start = Date.parse(startStr);
  const end = Date.parse(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1000);
}

export function calendarEventToIntegrationActivity(params: {
  event: GoogleCalendarEvent;
  integrationId: string;
  organizationId: string;
  userId: string;
  dealIds: string[];
  contactIds: string[];
}): CalendarIntegrationActivityRow {
  const { event, integrationId, organizationId, userId, dealIds, contactIds } = params;
  const summary = event.summary?.trim() ?? '';
  return {
    integrationId,
    organizationId,
    userId,
    source: 'google_calendar',
    externalId: event.id,
    type: 'CALENDAR_EVENT',
    dealIds,
    contactIds,
    title: summary || '(no title)',
    summary: event.description?.trim() ?? '',
    occurredAt: startIso(event),
    durationSeconds: durationSeconds(event),
    metadata: {
      attendees: (event.attendees ?? []).map(a => ({
        email: a.email?.toLowerCase() ?? null,
        name: a.displayName ?? null,
        responseStatus: a.responseStatus ?? null,
      })),
      organizer: event.organizer?.email?.toLowerCase() ?? null,
      location: event.location ?? null,
      status: event.status ?? null,
      eventLink: event.htmlLink ?? null,
    },
    aiExtraction: null,
    rawTranscript: '',
  };
}

export function extractAttendeeEmails(event: GoogleCalendarEvent): string[] {
  const all: string[] = [];
  for (const a of event.attendees ?? []) {
    if (a.email) all.push(a.email.toLowerCase());
  }
  if (event.organizer?.email) all.push(event.organizer.email.toLowerCase());
  return Array.from(new Set(all));
}
