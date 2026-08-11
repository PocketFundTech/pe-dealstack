import crypto from 'crypto';
import type { ProviderId } from './types.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface StateClaims {
  userId: string;
  organizationId: string;
  provider: ProviderId;
  nonce: string;
  iat: number;
}

function getSecret(): Buffer {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET is not configured');
  if (secret.length < 32) {
    throw new Error('OAUTH_STATE_SECRET must be at least 32 characters');
  }
  return Buffer.from(secret, 'utf8');
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

export function signState(params: {
  userId: string;
  organizationId: string;
  provider: ProviderId;
}): string {
  const claims: StateClaims = {
    userId: params.userId,
    organizationId: params.organizationId,
    provider: params.provider,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
  };
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(
    crypto.createHmac('sha256', getSecret()).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

export function verifyState(state: string): StateClaims {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) throw new Error('Invalid state format');
  const expectedSig = b64url(
    crypto.createHmac('sha256', getSecret()).update(payload).digest()
  );
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new Error('Invalid state signature');
  }
  const claims = JSON.parse(fromB64url(payload).toString('utf8')) as StateClaims;
  if (Date.now() - claims.iat > STATE_TTL_MS) {
    throw new Error('State expired');
  }
  return claims;
}

export function buildAuthUrl(params: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  extraParams?: Record<string, string>;
}): string {
  const url = new URL(params.baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  for (const [k, v] of Object.entries(params.extraParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function exchangeCodeForTokens(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
  const res = await fetch(params.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
}
