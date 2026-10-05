import { AsyncLocalStorage } from 'node:async_hooks';
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export interface UsageContext {
  /** Internal User.id (NOT the Supabase auth UUID). FK target for UsageEvent.userId. */
  userId: string;
  organizationId: string;
  requestId?: string;
  source: 'http' | 'background' | 'test';
  /** Set for cron / webhook / background work with no requesting user (e.g. "cron:signal-scan"). */
  systemSource?: string;
  /** Deal the work belongs to, so per-deal AI cost can be read from UsageEvent.metadata.dealId. */
  dealId?: string;
}

const storage = new AsyncLocalStorage<UsageContext>();

// Cache (authId → internal User.id). The internal id never changes for a given
// auth user, so we can cache it indefinitely. Keeps the middleware to one DB
// query per process lifetime per user.
const authIdToUserId = new Map<string, string>();

export function getUsageContext(): UsageContext | undefined {
  return storage.getStore();
}

export function runWithUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Tag every usage record written inside `fn` with this deal. No-op without a bound context. */
export function runWithDealUsage<T>(dealId: string, fn: () => T): T {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  return storage.run({ ...ctx, dealId }, fn);
}

// orgId → the internal User.id that system usage is attributed to.
const orgSystemUserId = new Map<string, string>();

/**
 * Run work that has no requesting user — cron jobs, webhooks, background
 * processing — with a usage context bound to the organization, so its AI
 * spend is recorded instead of silently dropped ("no usage context bound").
 *
 * UsageEvent.userId is NOT NULL, so the row is attributed to the org's
 * earliest admin (falling back to its earliest user) and marked
 * `metadata.attribution = "system"` with `systemSource` for filtering.
 * An already-bound request context is kept as-is. If the org has no user the
 * work still runs, unrecorded, with a warning.
 */
export async function runAsOrgSystem<T>(
  organizationId: string,
  systemSource: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (getUsageContext()) return fn();
  let userId = orgSystemUserId.get(organizationId);
  if (!userId) {
    try {
      const pick = async (roles: string[] | null) => {
        let q = supabase.from('User').select('id').eq('organizationId', organizationId);
        if (roles) q = q.in('role', roles);
        const { data } = await q.order('createdAt', { ascending: true }).limit(1);
        return (data as Array<{ id: string }> | null)?.[0]?.id;
      };
      userId = (await pick(['ADMIN'])) ?? (await pick(null));
      if (userId) orgSystemUserId.set(organizationId, userId);
    } catch (err) {
      log.error('runAsOrgSystem: org user lookup threw', { err, organizationId });
    }
  }
  if (!userId) {
    log.warn('runAsOrgSystem: no user to attribute system usage to — running unrecorded', {
      organizationId,
      systemSource,
    });
    return fn();
  }
  return storage.run({ userId, organizationId, source: 'background', systemSource }, fn);
}

/**
 * Resolve a Supabase auth UUID (User.authId) to the internal User.id that
 * UsageEvent.userId is a foreign key to. Returns null if it can't be resolved.
 *
 * Use this when starting a background task (where usageContextMiddleware never
 * ran) so its UsageContext carries the internal id and not the auth UUID — the
 * latter fails the FK with 23503.
 */
export async function resolveInternalUserId(authId: string): Promise<string | null> {
  if (!authId) return null;
  const cached = authIdToUserId.get(authId);
  if (cached) return cached;
  try {
    const { data, error } = await supabase
      .from('User')
      .select('id')
      .eq('authId', authId)
      .single();
    if (error || !data?.id) {
      log.warn('resolveInternalUserId: failed to resolve internal User.id', {
        authId,
        error: error?.message,
      });
      return null;
    }
    const internalUserId = data.id as string;
    authIdToUserId.set(authId, internalUserId);
    return internalUserId;
  } catch (err) {
    log.error('resolveInternalUserId: User lookup threw', { err, authId });
    return null;
  }
}

/**
 * Express middleware. Must run AFTER authMiddleware + orgMiddleware so req.user
 * has both id (Supabase auth UUID) and organizationId populated.
 *
 * Resolves req.user.id (which is the AUTH UUID = User.authId) to the internal
 * User.id, because UsageEvent.userId is a foreign key to User.id (not authId).
 * Without this resolution the insert fails with FK 23503.
 */
export async function usageContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authId = req.user?.id;
  const organizationId = req.user?.organizationId;
  if (!authId || !organizationId) {
    return next();
  }

  const internalUserId = await resolveInternalUserId(authId);
  if (!internalUserId) {
    return next();
  }

  const requestId = (req.headers['x-request-id'] as string) || undefined;
  storage.run(
    { userId: internalUserId, organizationId, requestId, source: 'http' },
    () => next(),
  );
}
