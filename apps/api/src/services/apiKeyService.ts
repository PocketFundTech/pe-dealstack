// ─── API key service ───────────────────────────────────────────────
// Generation, hashing, and verification of machine-to-machine API keys.
// Raw keys are `peos_` + 48 hex chars, shown once at creation. Only the
// SHA-256 hash is stored, so a DB leak never exposes usable keys.

import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  createdBy: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  revokedAt: string | null;
}

export const API_KEY_HEADER = 'x-api-key';
const KEY_PREFIX = 'peos_';

// Short-TTL cache of verified keys (same rationale as authContextCache:
// warm serverless instances serve many requests; revocation propagates
// within TTL_MS and immediately via invalidateApiKey on the revoke path).
const TTL_MS = 30_000;
const verifiedCache = new Map<string, { value: ApiKeyRecord; expires: number }>();

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function generateApiKey(): { rawKey: string; keyHash: string; prefix: string } {
  const rawKey = KEY_PREFIX + randomBytes(24).toString('hex');
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    prefix: rawKey.slice(0, KEY_PREFIX.length + 8),
  };
}

export function invalidateApiKey(keyHash: string): void {
  verifiedCache.delete(keyHash);
}

/**
 * Verify a raw API key. Returns the active key record or null.
 * Updates lastUsedAt fire-and-forget (at most once per cache TTL).
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashApiKey(rawKey);

  const cached = verifiedCache.get(keyHash);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  const { data, error } = await supabase
    .from('ApiKey')
    .select('id, organizationId, createdBy, name, prefix, scopes, revokedAt')
    .eq('keyHash', keyHash)
    .maybeSingle();

  if (error) {
    log.error('API key lookup failed', error);
    return null;
  }
  if (!data || data.revokedAt) return null;

  const record = data as ApiKeyRecord;
  verifiedCache.set(keyHash, { value: record, expires: Date.now() + TTL_MS });

  void supabase
    .from('ApiKey')
    .update({ lastUsedAt: new Date().toISOString() })
    .eq('id', record.id)
    .then(({ error: updateErr }) => {
      if (updateErr) log.warn('API key lastUsedAt update failed', { error: updateErr.message });
    });

  return record;
}
