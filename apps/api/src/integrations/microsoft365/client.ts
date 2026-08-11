// Microsoft 365 calendar + OneDrive calls against Microsoft Graph. OAuth/token
// helpers live in the shared ../microsoft/client.ts.

import { graphGet } from '../microsoft/client.js';
import type { GraphEvent, GraphListResponse } from './types.js';

// Connecting the Microsoft 365 card grants Calendar + OneDrive access — the
// Microsoft mirror of Google Workspace's Calendar + Drive scopes. Files.Read.All
// covers OneDrive/SharePoint documents (Word/Excel/PowerPoint live there too).
export const MICROSOFT365_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'Files.Read.All',
];

const EVENT_SELECT =
  'id,subject,bodyPreview,start,end,isCancelled,organizer,attendees,webLink,onlineMeetingUrl';

// Calendar events in the [start, end] window. calendarView expands recurring
// series into instances (unlike /me/events), which is what we want for an
// activity feed. Times are passed as ISO and interpreted in UTC.
export async function listEventsBetween(
  accessToken: string,
  start: Date,
  end: Date,
  top = 100
): Promise<GraphEvent[]> {
  const path =
    `/me/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$select=${EVENT_SELECT}` +
    `&$orderby=start/dateTime&$top=${top}`;
  const data = await graphGet<GraphListResponse<GraphEvent>>(accessToken, path);
  return data.value ?? [];
}
