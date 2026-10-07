/**
 * Signed "extraction token" for the two-step duplicate check on interactive
 * intake (upload / paste text / URL).
 *
 * Step 1: the server reads the document with AI, finds an existing deal that
 * looks like the same company, and — instead of creating or merging anything
 * — returns the candidates plus this token. Step 2: the client resends the
 * same request with the user's choice (`dealId` or `forceCreate`) and the
 * token, and the server reuses the extraction instead of paying for the AI
 * read twice.
 *
 * The token is `v1.<payload>.<sig>`: payload = base64url(deflate(JSON)),
 * sig = HMAC-SHA256 over the payload. It binds the extraction to the org, the
 * intake kind and a sha256 of the source (file bytes / text / URL), and
 * expires after 30 minutes. Anything that doesn't verify returns null and the
 * caller just runs the normal extraction — a bad token never fails a request.
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { log } from '../utils/logger.js';

export type ExtractionKind = 'upload' | 'text' | 'url';

export const EXTRACTION_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Refuse absurd tokens before doing any work (the body limit is 50MB). */
const MAX_TOKEN_CHARS = 8 * 1024 * 1024;
/** Cap on the inflated JSON — a zip bomb can't blow up memory. */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

interface TokenClaims<T> {
  v: 1;
  org: string;
  kind: ExtractionKind;
  hash: string;
  exp: number;
  data: T;
}

let processFallbackKey: Buffer | null = null;

/**
 * Key derived from an existing server secret: OAUTH_STATE_SECRET (if set and
 * long enough), else DATA_ENCRYPTION_KEY, else SUPABASE_SERVICE_ROLE_KEY. With
 * none of them (local dev / tests) a random per-process key is used — tokens
 * then only verify on the instance that issued them, and anything else falls
 * back to a fresh extraction.
 */
function getKey(): Buffer {
  const oauth = process.env.OAUTH_STATE_SECRET;
  const secret = (oauth && oauth.length >= 32 ? oauth : null)
    || process.env.DATA_ENCRYPTION_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || null;
  if (!secret) {
    if (!processFallbackKey) {
      processFallbackKey = crypto.randomBytes(32);
      if (process.env.NODE_ENV === 'production') {
        log.warn('extractionToken: no server secret set — using a per-process key');
      }
    }
    return processFallbackKey;
  }
  // Domain-separate from every other use of the same secret.
  return crypto.createHmac('sha256', secret).update('avise:ingest-extraction-token:v1').digest();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** sha256 hex of the source the extraction was made from. */
export function hashContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function signExtractionToken<T>(params: {
  orgId: string;
  kind: ExtractionKind;
  contentHash: string;
  data: T;
  now?: number;
  ttlMs?: number;
}): string {
  const claims: TokenClaims<T> = {
    v: 1,
    org: params.orgId,
    kind: params.kind,
    hash: params.contentHash,
    exp: (params.now ?? Date.now()) + (params.ttlMs ?? EXTRACTION_TOKEN_TTL_MS),
    data: params.data,
  };
  const payload = b64url(zlib.deflateRawSync(Buffer.from(JSON.stringify(claims), 'utf8')));
  const sig = b64url(crypto.createHmac('sha256', getKey()).update(payload).digest());
  return `v1.${payload}.${sig}`;
}

/**
 * The extraction inside `token`, or null when it is missing, malformed,
 * tampered with, expired, or issued for another org / kind / source.
 */
export function verifyExtractionToken<T>(
  token: unknown,
  expected: { orgId: string; kind: ExtractionKind; contentHash: string; now?: number },
): T | null {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', getKey()).update(payload).digest();
    const given = fromB64url(sig);
    if (given.length !== expectedSig.length || !crypto.timingSafeEqual(given, expectedSig)) return null;
    const json = zlib.inflateRawSync(fromB64url(payload), { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8');
    const claims = JSON.parse(json) as TokenClaims<T>;
    if (claims.v !== 1) return null;
    if (claims.org !== expected.orgId) return null;
    if (claims.kind !== expected.kind) return null;
    if (claims.hash !== expected.contentHash) return null;
    if (typeof claims.exp !== 'number' || claims.exp < (expected.now ?? Date.now())) return null;
    return claims.data ?? null;
  } catch (err) {
    log.warn('extractionToken: could not verify token', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Interactive clients send `checkDuplicates: true` (JSON or multipart string). */
export function wantsDuplicateCheck(body: unknown): boolean {
  const v = (body as { checkDuplicates?: unknown } | undefined)?.checkDuplicates;
  return v === true || v === 'true';
}
