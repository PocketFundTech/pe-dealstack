/**
 * Org-scoped API keys for external tools (n8n, Zapier, Make, scripts).
 *
 * The standard every key follows:
 *   - Format: `avise_sk_` + 32 random bytes as base64url (43 chars).
 *   - Sent as `Authorization: Bearer avise_sk_…` (or `X-API-Key: avise_sk_…`).
 *   - Only the SHA-256 hash is stored; the plaintext is shown once at creation.
 *   - A key acts as the admin who created it, inside that admin's org. It stops
 *     working when revoked, expired, or when that user is deactivated or moves org.
 */
import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import type { AuthUser } from '../middleware/auth.js';

export const API_KEY_PREFIX = 'avise_sk_';

export function isApiKey(token: string | undefined | null): token is string {
  return !!token && token.startsWith(API_KEY_PREFIX);
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export type ApiKeyScope = 'full' | 'read_only';

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string; lastFour: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: key.slice(0, API_KEY_PREFIX.length + 4),
    lastFour: key.slice(-4),
  };
}

interface ApiKeyRow {
  id: string;
  organizationId: string;
  scope: ApiKeyScope;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  user: {
    authId: string | null;
    email: string | null;
    name: string | null;
    role: string | null;
    organizationId: string | null;
    isActive: boolean | null;
  } | null;
}

// Only bump lastUsedAt once a minute per key — n8n loops can fire hundreds of
// requests and each one shouldn't cost a write.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** null = not yet known; flips to false on the first "column does not exist". */
let scopeColumnAvailable: boolean | null = null;

/** Test hook. */
export function resetApiKeyScopeProbe(): void {
  scopeColumnAvailable = null;
}

export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // 42703 = Postgres undefined_column; PGRST204 = column not in PostgREST's schema cache.
  return error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message ?? '');
}

/**
 * Resolve a plaintext API key to the user it acts as, or null when the key is
 * unknown, revoked, expired, or its owner is no longer an active member of
 * the key's organization.
 */
export async function resolveApiKey(key: string): Promise<AuthUser | null> {
  const withScope = scopeColumnAvailable !== false;
  const fields = withScope
    ? 'id, organizationId, scope, expiresAt, revokedAt, lastUsedAt, user:User!userId(authId, email, name, role, organizationId, isActive)'
    : 'id, organizationId, expiresAt, revokedAt, lastUsedAt, user:User!userId(authId, email, name, role, organizationId, isActive)';

  let { data, error } = await supabase
    .from('ApiKey')
    .select(fields)
    .eq('keyHash', hashApiKey(key))
    .maybeSingle<ApiKeyRow>();

  // The scope column may not exist yet (api-key-scope-migration.sql not run).
  // Fall back once, remember it, and treat every key as 'full' until the
  // migration runs — never let a missing column break every API key.
  if (withScope && isMissingColumnError(error)) {
    scopeColumnAvailable = false;
    log.warn('ApiKey.scope column missing — run api-key-scope-migration.sql. Treating all keys as full-access.');
    ({ data, error } = await supabase
      .from('ApiKey')
      .select('id, organizationId, expiresAt, revokedAt, lastUsedAt, user:User!userId(authId, email, name, role, organizationId, isActive)')
      .eq('keyHash', hashApiKey(key))
      .maybeSingle<ApiKeyRow>());
  } else if (withScope && !error) {
    scopeColumnAvailable = true;
  }

  if (error) {
    log.error('API key lookup failed', error);
    return null;
  }
  if (!data || data.revokedAt) return null;
  if (data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now()) return null;

  const owner = data.user;
  if (!owner?.authId || owner.isActive === false) return null;
  // Owner moved to another org: the key must not follow them there.
  if (owner.organizationId !== data.organizationId) return null;

  const lastUsed = data.lastUsedAt ? new Date(data.lastUsedAt).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
    void supabase
      .from('ApiKey')
      .update({ lastUsedAt: new Date().toISOString() })
      .eq('id', data.id)
      .then(({ error: updErr }) => {
        if (updErr) log.warn('API key lastUsedAt update failed', { apiKeyId: data.id, error: updErr.message });
      });
  }

  return {
    id: owner.authId,
    email: owner.email || '',
    name: owner.name ?? undefined,
    role: owner.role || 'MEMBER',
    organizationId: data.organizationId,
    emailConfirmed: true,
    apiKeyId: data.id,
    apiKeyScope: (data as { scope?: ApiKeyScope }).scope === 'read_only' ? 'read_only' : 'full',
  };
}
