// Shared Microsoft identity + Microsoft Graph client.
//
// One Azure/Entra app registration backs every Microsoft integration
// (Outlook mail, Microsoft 365 calendar/OneDrive) — exactly like the single
// Google OAuth client backs both Gmail and Google Workspace. Each provider
// requests its own scope subset and stores its own Integration row + token,
// but they all flow through the OAuth + Graph helpers here.
//
// Credentials come from env (set after the Azure app is registered):
//   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT (default 'common')

const TENANT = process.env.MS_TENANT || 'common';
const AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface MicrosoftUserInfo {
  id: string;
  email: string;
  displayName: string | null;
}

function clientId(): string {
  const id = process.env.MS_CLIENT_ID;
  if (!id) throw new Error('MS_CLIENT_ID is not configured');
  return id;
}

function clientSecret(): string {
  const secret = process.env.MS_CLIENT_SECRET;
  if (!secret) throw new Error('MS_CLIENT_SECRET is not configured');
  return secret;
}

// Microsoft's authorize URL differs from Google's (no access_type; uses
// response_mode + prompt), so we build it here rather than reuse the
// Google-shaped helper in _platform/oauth.ts.
export function buildMicrosoftAuthUrl(params: {
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  // Force a consent screen so offline_access reliably yields a refresh token.
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeMicrosoftCode(params: {
  code: string;
  redirectUri: string;
  scopes: string[];
}): Promise<MicrosoftTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId(),
    client_secret: clientSecret(),
    code: params.code,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(' '),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

export async function refreshMicrosoftToken(
  refreshToken: string,
  scopes: string[]
): Promise<MicrosoftTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

export async function getMicrosoftUserInfo(
  accessToken: string
): Promise<MicrosoftUserInfo> {
  const data = await graphGet<{
    id: string;
    mail: string | null;
    userPrincipalName: string | null;
    displayName: string | null;
  }>(accessToken, '/me?$select=id,mail,userPrincipalName,displayName');
  // `mail` can be null for some account types; fall back to UPN.
  const email = (data.mail || data.userPrincipalName || '').toLowerCase();
  return { id: data.id, email, displayName: data.displayName };
}

// Low-level authenticated GET against Microsoft Graph. `path` is everything
// after GRAPH_BASE (e.g. '/me/messages?...'). Throws on non-2xx with the
// Graph error body so callers/logs see the real reason.
export async function graphGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}
