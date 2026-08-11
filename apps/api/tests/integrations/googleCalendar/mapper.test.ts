import { describe, it, expect } from 'vitest';
import { calendarEventToIntegrationActivity, extractAttendeeEmails } from '../../../src/integrations/googleCalendar/mapper.js';
import type { GoogleCalendarEvent } from '../../../src/integrations/googleCalendar/types.js';

const evt: GoogleCalendarEvent = {
  id: 'e-1',
  status: 'confirmed',
  summary: 'Acme founder call',
  description: 'Q1 review with John',
  location: 'Zoom',
  htmlLink: 'https://calendar.google.com/event?eid=…',
  start: { dateTime: '2026-04-30T15:00:00Z' },
  end:   { dateTime: '2026-04-30T15:48:00Z' },
  attendees: [
    { email: 'john@acme.com', displayName: 'John', responseStatus: 'accepted' },
    { email: 'me@firm.com', displayName: 'Me', self: true, organizer: true, responseStatus: 'accepted' },
  ],
  organizer: { email: 'me@firm.com', self: true },
};

describe('calendarEventToIntegrationActivity', () => {
  it('builds a CALENDAR_EVENT row with attendee + duration', () => {
    const row = calendarEventToIntegrationActivity({
      event: evt, integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: ['d-1'], contactIds: ['c-1'],
    });
    expect(row.source).toBe('google_calendar');
    expect(row.externalId).toBe('e-1');
    expect(row.type).toBe('CALENDAR_EVENT');
    expect(row.title).toBe('Acme founder call');
    expect(row.summary).toContain('Q1 review');
    expect(row.dealIds).toEqual(['d-1']);
    expect(row.contactIds).toEqual(['c-1']);
    expect(row.occurredAt).toBe('2026-04-30T15:00:00.000Z');
    expect(row.durationSeconds).toBe(48 * 60);
    expect(row.metadata).toMatchObject({
      attendees: expect.arrayContaining([
        expect.objectContaining({ email: 'john@acme.com' }),
      ]),
      location: 'Zoom',
      status: 'confirmed',
      eventLink: expect.any(String),
    });
  });

  it('handles all-day events (date instead of dateTime)', () => {
    const row = calendarEventToIntegrationActivity({
      event: { ...evt, start: { date: '2026-04-30' }, end: { date: '2026-05-01' } },
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: [], contactIds: [],
    });
    expect(row.occurredAt).toBe(new Date('2026-04-30').toISOString());
    expect(row.durationSeconds).toBe(24 * 60 * 60);
  });

  it('handles missing summary/description', () => {
    const row = calendarEventToIntegrationActivity({
      event: { ...evt, summary: undefined, description: undefined },
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: [], contactIds: [],
    });
    expect(row.title).toBe('(no title)');
    expect(row.summary).toBe('');
  });
});

describe('extractAttendeeEmails', () => {
  it('returns lowercase emails of attendees plus organizer', () => {
    const emails = extractAttendeeEmails(evt);
    expect(emails).toContain('john@acme.com');
    expect(emails).toContain('me@firm.com');
  });
});
