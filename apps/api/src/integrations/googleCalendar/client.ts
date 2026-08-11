import { log } from '../../utils/logger.js';
import type {
  GoogleCalendarEvent,
  GoogleCalendarListResponse,
  GoogleCalendarUserInfo,
} from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Provider scope set. Originally Calendar-only, then expanded to include
// Drive (file create/manage) + Docs (batchUpdate for placeholder substitution)
// so the NDA send flow can create a real Google Doc with this same token.
// Gmail send scope was added so the NDA flow can email the Doc link from
// the user's own Workspace Gmail (multi-tenant — no domain verification).
// The provider is now displayed as "Google Workspace" but its `id` is still
// `google_calendar` (so existing connections keep working). When a user
// connected before this scope expansion sends an NDA, the Drive or Gmail
// call will 403/401 with "insufficient scope" — the frontend then triggers
// a re-authorize.
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.send',
];

function googleClientCreds(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  return { id, secret };
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export function buildAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const { id } = googleClientCreds();
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', id);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (params.scopes ?? CALENDAR_SCOPES).join(' '));
  u.searchParams.set('state', params.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
  const { id, secret } = googleClientCreds();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code, client_id: id, client_secret: secret, redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Calendar token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const { id, secret } = googleClientCreds();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken, client_id: id, client_secret: secret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Calendar token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function getUserInfo(accessToken: string): Promise<GoogleCalendarUserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Calendar userinfo failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GoogleCalendarUserInfo;
}

/**
 * True when the account behind `accessToken` is a managed Google Workspace
 * account — detected via the `hd` (hosted domain) claim on the OAuth userinfo,
 * which Google only sets for Workspace accounts (never personal @gmail.com).
 *
 * Used to gate the Google Docs native eSignature flow (Workspace-only). This
 * makes a live userinfo call so it stays correct for connections made before
 * we started persisting `settings.hostedDomain`.
 */
export async function isWorkspaceAccount(accessToken: string): Promise<boolean> {
  const info = await getUserInfo(accessToken);
  return Boolean(info.hd);
}

export async function listEventsBetween(
  accessToken: string,
  timeMin: Date,
  timeMax: Date
): Promise<GoogleCalendarEvent[]> {
  const out: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 20;
  do {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${CAL_BASE}/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Calendar listEvents failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as GoogleCalendarListResponse;
    if (page.items) out.push(...page.items);
    pageToken = page.nextPageToken;
    pageCount++;
    if (pageCount >= MAX_PAGES) {
      log.warn('googleCalendar: listEventsBetween hit MAX_PAGES, stopping early', { pageCount });
      break;
    }
  } while (pageToken);
  return out;
}
