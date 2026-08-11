/**
 * Short-TTL, per-process caches for the hot per-request auth lookups.
 *
 * Every authenticated request resolves the caller's org + role (orgMiddleware)
 * and their org's MFA policy (enforceOrgMfaMiddleware). Both were uncached DB
 * round trips on EVERY request. Serverless lambda instances are reused across
 * requests, so a module-level Map caches within a warm instance.
 *
 * TTL is deliberately short (30s) so security-relevant changes — role change,
 * org reassignment, toggling requireMFA — propagate within seconds without a
 * deploy or manual bust. Mutation paths that change these values SHOULD also
 * call the invalidate* helpers for immediate effect; the TTL is the backstop.
 *
 * We intentionally do NOT cache token validation (supabase.auth.getUser): a
 * revoked/expired token must fail immediately, so that check stays live.
 */

const TTL_MS = 30_000;

interface Entry<V> {
  value: V;
  expires: number;
}

function makeCache<V>() {
  const store = new Map<string, Entry<V>>();
  return {
    get(key: string): V | undefined {
      const e = store.get(key);
      if (!e) return undefined;
      if (Date.now() > e.expires) {
        store.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key: string, value: V): void {
      store.set(key, { value, expires: Date.now() + TTL_MS });
    },
    delete(key: string): void {
      store.delete(key);
    },
  };
}

/** Resolved from the User table, keyed by Supabase auth UUID (User.authId). */
export interface UserAuthContext {
  /** Internal User.id (NOT the auth UUID). */
  userId: string;
  organizationId: string | null;
  role: string | null;
}

const userContextCache = makeCache<UserAuthContext>();
/** orgId → requireMFA flag. */
const orgMfaCache = makeCache<boolean>();

export function getCachedUserContext(authId: string): UserAuthContext | undefined {
  return userContextCache.get(authId);
}
export function setCachedUserContext(authId: string, ctx: UserAuthContext): void {
  userContextCache.set(authId, ctx);
}
/** Call when a user's role or organization membership changes. */
export function invalidateUserContext(authId: string): void {
  userContextCache.delete(authId);
}

export function getCachedOrgMfa(orgId: string): boolean | undefined {
  return orgMfaCache.get(orgId);
}
export function setCachedOrgMfa(orgId: string, requireMFA: boolean): void {
  orgMfaCache.set(orgId, requireMFA);
}
/** Call when an organization toggles requireMFA. */
export function invalidateOrgMfa(orgId: string): void {
  orgMfaCache.delete(orgId);
}
