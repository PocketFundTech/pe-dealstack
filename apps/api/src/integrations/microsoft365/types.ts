// Microsoft Graph calendar shapes (subset we consume). Full schema:
// https://learn.microsoft.com/graph/api/resources/event

export interface GraphDateTimeZone {
  dateTime?: string;   // e.g. "2026-06-19T15:00:00.0000000"
  timeZone?: string;   // e.g. "UTC"
}

export interface GraphEventAttendee {
  emailAddress?: { name?: string; address?: string };
  type?: 'required' | 'optional' | 'resource';
}

export interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: GraphDateTimeZone;
  end?: GraphDateTimeZone;
  isCancelled?: boolean;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: GraphEventAttendee[];
  webLink?: string;
  onlineMeetingUrl?: string | null;
}

export interface GraphListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}
