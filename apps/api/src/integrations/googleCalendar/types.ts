export interface GoogleCalendarUserInfo {
  email: string;
  name?: string;
  verified_email?: boolean;
  // Hosted domain — present ONLY for managed Google Workspace accounts
  // (e.g. "acme.com"). Absent for personal @gmail.com accounts. We use its
  // presence as the "is this a Workspace account?" signal that gates the
  // Google Docs native eSignature flow.
  hd?: string;
}

export interface GoogleCalendarTimeRef {
  dateTime?: string;  // ISO 8601 with offset
  date?: string;      // YYYY-MM-DD (all-day events)
  timeZone?: string;
}

export interface GoogleCalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  organizer?: boolean;
  self?: boolean;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GoogleCalendarTimeRef;
  end?: GoogleCalendarTimeRef;
  attendees?: GoogleCalendarAttendee[];
  organizer?: GoogleCalendarAttendee;
  created?: string;
  updated?: string;
}

export interface GoogleCalendarListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
}
